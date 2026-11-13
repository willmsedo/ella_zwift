from __future__ import annotations

import datetime as dt
import html
import json
import math
import os
import secrets
import sqlite3
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Iterator

try:
    import keyring
except ImportError:
    keyring = None


ROOT = Path(__file__).resolve().parent
WEB_ROOT = ROOT / "web"
DATA_DIR = ROOT / "data"
DATABASE = DATA_DIR / "rides.sqlite3"
CONFIG_FILE = ROOT / "strava.local.json"
HOST = "127.0.0.1"
PORT = 8765
MAX_BODY = 8 * 1024 * 1024
MAX_GPX_BYTES = 10 * 1024 * 1024
MAX_TRACK_POINTS = 50_000
KEYRING_SERVICE = "ella_zwift"
STRAVA_API = "https://www.strava.com/api/v3"
STRAVA_TOKEN_URL = "https://www.strava.com/oauth/token"
REDIRECT_URI = f"http://localhost:{PORT}/oauth/callback"

_oauth_lock = threading.Lock()
_pending_oauth: dict[str, float] = {}
_token_lock = threading.Lock()
_access_token: str | None = None
_access_expires_at = 0
_webhook_notice: str | None = None


class AppError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _child_text(element: ET.Element, name: str) -> str | None:
    for child in element:
        if _local_name(child.tag) == name and child.text:
            return child.text.strip()
    return None


def _haversine_m(a: dict[str, Any], b: dict[str, Any]) -> float:
    radius = 6_371_000.0
    lat1, lat2 = math.radians(a["lat"]), math.radians(b["lat"])
    dlat = lat2 - lat1
    dlon = math.radians(b["lon"] - a["lon"])
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * radius * math.asin(min(1.0, math.sqrt(h)))


def _smooth_elevations(points: list[dict[str, Any]], radius: int = 2) -> list[float | None]:
    if len(points) <= radius * 2 + 1:
        return [point["ele"] for point in points]
    result: list[float | None] = []
    for index, point in enumerate(points):
        if point["ele"] is None:
            result.append(None)
            continue
        nearby = [
            points[i]["ele"]
            for i in range(max(0, index - radius), min(len(points), index + radius + 1))
            if points[i]["ele"] is not None
        ]
        result.append(sum(nearby) / len(nearby) if nearby else None)
    return result


def parse_gpx(raw: bytes) -> dict[str, Any]:
    if not raw:
        raise AppError("The GPX file is empty.")
    if len(raw) > MAX_GPX_BYTES:
        raise AppError("GPX files must be 10 MB or smaller.")
    if b"<!DOCTYPE" in raw.upper() or b"<!ENTITY" in raw.upper():
        raise AppError("GPX files with document type or entity declarations are not accepted.")
    try:
        root = ET.fromstring(raw)
    except ET.ParseError as exc:
        raise AppError(f"Could not read GPX XML: {exc}") from exc

    segments: list[list[dict[str, Any]]] = []
    for element in root.iter():
        name = _local_name(element.tag)
        if name == "trkseg":
            segment = [point for point in element if _local_name(point.tag) == "trkpt"]
            if segment:
                segments.append(segment)
    if not segments:
        route_points = [
            point for element in root.iter()
            if _local_name(element.tag) == "rte"
            for point in element
            if _local_name(point.tag) == "rtept"
        ]
        if route_points:
            segments = [route_points]

    raw_points: list[list[dict[str, Any]]] = []
    total_points = 0
    for segment in segments:
        parsed_segment: list[dict[str, Any]] = []
        for element in segment:
            try:
                lat, lon = float(element.attrib["lat"]), float(element.attrib["lon"])
            except (KeyError, ValueError):
                continue
            if not (-90 <= lat <= 90 and -180 <= lon <= 180):
                continue
            ele_text = _child_text(element, "ele")
            try:
                elevation = float(ele_text) if ele_text is not None else None
            except ValueError:
                elevation = None
            parsed_segment.append({
                "lat": lat,
                "lon": lon,
                "ele": elevation if elevation is not None and math.isfinite(elevation) else None,
                "time": _child_text(element, "time"),
            })
            total_points += 1
            if total_points > MAX_TRACK_POINTS:
                raise AppError("GPX files must contain 50,000 track points or fewer.")
        if len(parsed_segment) > 0:
            raw_points.append(parsed_segment)

    if not raw_points:
        raise AppError("No valid GPX track points were found.")
    if sum(map(len, raw_points)) < 2:
        raise AppError("The GPX needs at least two valid track points.")

    distance_m = 0.0
    normalized_segments: list[list[dict[str, Any]]] = []
    flat_points: list[dict[str, Any]] = []
    ascent_m = 0.0
    descent_m = 0.0
    has_elevation = False

    for raw_segment in raw_points:
        segment: list[dict[str, Any]] = []
        for point in raw_segment:
            if segment:
                distance_m += _haversine_m(segment[-1], point)
            normalized = {**point, "distance_m": distance_m, "grade_pct": 0.0}
            segment.append(normalized)
        smoothed = _smooth_elevations(segment)
        for index, point in enumerate(segment):
            point["smooth_ele"] = smoothed[index]
            if point["ele"] is not None:
                has_elevation = True
            if index:
                previous = segment[index - 1]
                delta_distance = point["distance_m"] - previous["distance_m"]
                before, after = smoothed[index - 1], smoothed[index]
                if delta_distance > 0 and before is not None and after is not None:
                    delta_elevation = after - before
                    point["grade_pct"] = max(-30.0, min(30.0, 100 * delta_elevation / delta_distance))
                    ascent_m += max(0.0, delta_elevation)
                    descent_m += max(0.0, -delta_elevation)
            flat_points.append(point)
        normalized_segments.append(segment)

    title = None
    for element in root.iter():
        if _local_name(element.tag) == "name" and element.text and element.text.strip():
            title = element.text.strip()
            break
    return {
        "name": title or "Imported GPX route",
        "segments": normalized_segments,
        "points": flat_points,
        "distance_m": distance_m,
        "ascent_m": ascent_m,
        "descent_m": descent_m,
        "has_elevation": has_elevation,
    }


def _db() -> sqlite3.Connection:
    DATA_DIR.mkdir(exist_ok=True)
    connection = sqlite3.connect(DATABASE)
    connection.row_factory = sqlite3.Row
    connection.execute(
        """CREATE TABLE IF NOT EXISTS rides (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at TEXT NOT NULL,
            title TEXT NOT NULL,
            distance_m REAL NOT NULL,
            duration_s REAL NOT NULL,
            payload TEXT NOT NULL
        )"""
    )
    connection.commit()
    return connection


@contextmanager
def _connection() -> Iterator[sqlite3.Connection]:
    connection = _db()
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def _strava_config() -> tuple[str, str] | None:
    client_id = os.environ.get("STRAVA_CLIENT_ID")
    client_secret = os.environ.get("STRAVA_CLIENT_SECRET")
    if client_id and client_secret:
        return client_id, client_secret
    try:
        value = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        client_id = str(value["client_id"]).strip()
        client_secret = str(value["client_secret"]).strip()
        if client_id and client_secret:
            return client_id, client_secret
    except (OSError, ValueError, KeyError, TypeError):
        return None
    return None


def _webhook_config() -> tuple[str, str] | None:
    url = os.environ.get("STRAVA_WEBHOOK_STATUS_URL")
    token = os.environ.get("STRAVA_WEBHOOK_ADMIN_TOKEN")
    if not url or not token:
        try:
            value = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
            url = url or str(value.get("webhook_status_url", "")).strip()
            token = token or str(value.get("webhook_admin_token", "")).strip()
        except (OSError, ValueError, TypeError, AttributeError):
            return None
    if not url or not token:
        return None
    parsed = urllib.parse.urlsplit(url)
    if (parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password
            or parsed.path not in ("", "/") or parsed.query or parsed.fragment):
        raise AppError("Webhook status URL must be a Worker HTTPS origin without a path or query.", 400)
    return url.rstrip("/"), token


def _webhook_request(path: str, method: str = "GET") -> dict[str, Any]:
    config = _webhook_config()
    if config is None:
        raise AppError("Configure webhook_status_url and webhook_admin_token first.")
    if path not in {"/admin/state", "/admin/reset", "/admin/register"}:
        raise AppError("Invalid webhook operation.")
    data = b"{}" if method == "POST" else None
    headers = {"Authorization": f"Bearer {config[1]}"}
    if data:
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(f"{config[0]}{path}", data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            try:
                result = json.loads(response.read())
            except (ValueError, UnicodeDecodeError) as exc:
                raise AppError("Webhook service returned invalid JSON.", 502) from exc
            if not isinstance(result, dict):
                raise AppError("Webhook service returned an invalid response.", 502)
            return result
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            value = json.loads(exc.read())
            detail = str(value.get("error", ""))
        except (ValueError, OSError):
            pass
        message = f"Webhook service returned HTTP {exc.code}"
        if detail:
            message += f": {detail}"
        raise AppError(message, 502) from exc
    except (urllib.error.URLError, TimeoutError) as exc:
        raise AppError(f"Could not reach the Strava webhook service: {exc}", 503) from exc


def _webhook_status() -> dict[str, Any]:
    if _webhook_config() is None:
        return {
            "configured": False,
            "reachable": False,
            "registered": False,
            "revoked": False,
            "error": None,
        }
    try:
        result = _webhook_request("/admin/state")
        return {
            "configured": True,
            "reachable": True,
            "registered": bool(result.get("subscription_id")),
            "subscription_id": result.get("subscription_id"),
            "revoked": result.get("revoked") is True,
            "error": None,
        }
    except AppError as exc:
        return {
            "configured": True,
            "reachable": False,
            "registered": False,
            "revoked": False,
            "error": str(exc),
        }


def _forget_strava_tokens() -> None:
    global _access_token, _access_expires_at
    if _refresh_token():
        _store_refresh_token(None)
    _access_token = None
    _access_expires_at = 0


def _keyring_ready() -> bool:
    if keyring is None:
        return False
    try:
        return keyring.get_keyring().priority > 0
    except Exception:
        return False


def _refresh_token() -> str | None:
    if not _keyring_ready():
        return None
    try:
        return keyring.get_password(KEYRING_SERVICE, "strava_refresh_token")
    except Exception:
        return None


def _store_refresh_token(token: str | None) -> None:
    if not _keyring_ready():
        raise AppError("No operating-system keychain is available; Strava tokens were not stored.", 500)
    try:
        if token:
            keyring.set_password(KEYRING_SERVICE, "strava_refresh_token", token)
        elif keyring.get_password(KEYRING_SERVICE, "strava_refresh_token"):
            keyring.delete_password(KEYRING_SERVICE, "strava_refresh_token")
    except Exception as exc:
        raise AppError("Could not save the Strava token to the operating-system keychain.", 500) from exc


def _token_request(fields: dict[str, str]) -> dict[str, Any]:
    config = _strava_config()
    if config is None:
        raise AppError("Add Strava client credentials before connecting.", 400)
    payload = {
        "client_id": config[0],
        "client_secret": config[1],
        **fields,
    }
    request = urllib.request.Request(
        STRAVA_TOKEN_URL,
        data=urllib.parse.urlencode(payload).encode(),
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as exc:
        raise AppError(f"Strava token exchange failed (HTTP {exc.code}). Check the app credentials and callback domain.", 502) from exc
    except (urllib.error.URLError, TimeoutError) as exc:
        raise AppError(f"Could not reach Strava: {exc}", 502) from exc


def _get_access_token() -> str:
    global _access_token, _access_expires_at
    webhook_config = _webhook_config()
    if webhook_config:
        webhook = _webhook_status()
        if not webhook["reachable"]:
            raise AppError(f"Cannot verify Strava authorization status: {webhook['error']}", 503)
        if webhook["revoked"]:
            _forget_strava_tokens()
            raise AppError("Strava authorization was revoked. Reconnect your account before using Strava again.", 401)
    with _token_lock:
        if _access_token and _access_expires_at > time.time() + 60:
            return _access_token
        refresh_token = _refresh_token()
        if not refresh_token:
            raise AppError("Connect your Strava account first.", 401)
        token_data = _token_request({"grant_type": "refresh_token", "refresh_token": refresh_token})
        _access_token = token_data["access_token"]
        _access_expires_at = int(token_data.get("expires_at", time.time() + 21_600))
        rotated = token_data.get("refresh_token")
        if rotated and rotated != refresh_token:
            _store_refresh_token(rotated)
        return _access_token


def _strava_request(path: str, method: str = "GET", data: bytes | None = None,
                    content_type: str | None = None) -> Any:
    token = _get_access_token()
    headers = {"Authorization": f"Bearer {token}"}
    if content_type:
        headers["Content-Type"] = content_type
    request = urllib.request.Request(
        f"{STRAVA_API}{path}", data=data, headers=headers, method=method
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            raw = response.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        message = "Strava rejected the request."
        try:
            error_data = json.loads(exc.read())
            errors = error_data.get("errors", [])
            if errors:
                message = "; ".join(
                    str(item.get("field", "")) + " " + str(item.get("code", ""))
                    for item in errors
                ).strip()
        except (ValueError, OSError):
            pass
        raise AppError(f"{message} (HTTP {exc.code})", exc.code if exc.code < 500 else 502) from exc
    except (urllib.error.URLError, TimeoutError) as exc:
        raise AppError(f"Could not reach Strava: {exc}", 502) from exc


def _build_tcx(ride: dict[str, Any]) -> bytes:
    points = ride.get("points")
    if not isinstance(points, list) or len(points) < 2:
        raise AppError("A ride needs at least two recorded samples before it can be uploaded.")
    if len(points) > MAX_TRACK_POINTS:
        raise AppError("This ride contains too many samples to upload.")
    try:
        start = dt.datetime.fromisoformat(ride["start_time"].replace("Z", "+00:00"))
    except (KeyError, TypeError, ValueError) as exc:
        raise AppError("The ride start time is invalid.") from exc
    if start.tzinfo is None:
        start = start.replace(tzinfo=dt.timezone.utc)
    start = start.astimezone(dt.timezone.utc)
    safe_title = str(ride.get("name") or "Indoor route ride")[:100]

    ns = "http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"
    ext = "http://www.garmin.com/xmlschemas/ActivityExtension/v2"
    xsi = "http://www.w3.org/2001/XMLSchema-instance"
    ET.register_namespace("", ns)
    ET.register_namespace("xsi", xsi)
    ET.register_namespace("ae", ext)
    q = lambda namespace, tag: f"{{{namespace}}}{tag}"
    database = ET.Element(q(ns, "TrainingCenterDatabase"), {
        q(xsi, "schemaLocation"): f"{ns} http://www.garmin.com/xmlschemas/TrainingCenterDatabasev2.xsd"
    })
    activities = ET.SubElement(database, q(ns, "Activities"))
    activity = ET.SubElement(activities, q(ns, "Activity"), {"Sport": "Biking"})
    ET.SubElement(activity, q(ns, "Id")).text = start.isoformat(timespec="milliseconds").replace("+00:00", "Z")
    lap = ET.SubElement(activity, q(ns, "Lap"), {
        "StartTime": start.isoformat(timespec="milliseconds").replace("+00:00", "Z")
    })
    elapsed = max(0.0, float(points[-1].get("elapsed_s", 0)))
    distance = max(0.0, float(points[-1].get("distance_m", 0)))
    ET.SubElement(lap, q(ns, "TotalTimeSeconds")).text = f"{elapsed:.2f}"
    ET.SubElement(lap, q(ns, "DistanceMeters")).text = f"{distance:.2f}"
    ET.SubElement(lap, q(ns, "Calories")).text = "0"
    ET.SubElement(lap, q(ns, "Intensity")).text = "Active"
    ET.SubElement(lap, q(ns, "TriggerMethod")).text = "Manual"
    track = ET.SubElement(lap, q(ns, "Track"))
    for point in points:
        try:
            elapsed_s = max(0.0, float(point.get("elapsed_s", 0)))
            timestamp = start + dt.timedelta(seconds=elapsed_s)
            record = ET.SubElement(track, q(ns, "Trackpoint"))
            ET.SubElement(record, q(ns, "Time")).text = timestamp.isoformat(timespec="milliseconds").replace("+00:00", "Z")
            ET.SubElement(record, q(ns, "DistanceMeters")).text = f"{max(0.0, float(point.get('distance_m', 0))):.2f}"
            if point.get("lat") is not None and point.get("lon") is not None:
                position = ET.SubElement(record, q(ns, "Position"))
                ET.SubElement(position, q(ns, "LatitudeDegrees")).text = f"{float(point['lat']):.7f}"
                ET.SubElement(position, q(ns, "LongitudeDegrees")).text = f"{float(point['lon']):.7f}"
            if point.get("altitude_m") is not None:
                ET.SubElement(record, q(ns, "AltitudeMeters")).text = f"{float(point['altitude_m']):.2f}"
            if point.get("cadence_rpm") is not None:
                ET.SubElement(record, q(ns, "Cadence")).text = str(max(0, min(255, round(float(point["cadence_rpm"])))))
            if point.get("speed_mps") is not None or point.get("power_w") is not None:
                extensions = ET.SubElement(record, q(ns, "Extensions"))
                tpx = ET.SubElement(extensions, q(ext, "TPX"))
                if point.get("speed_mps") is not None:
                    ET.SubElement(tpx, q(ext, "Speed")).text = f"{max(0.0, float(point['speed_mps'])):.3f}"
                if point.get("power_w") is not None:
                    ET.SubElement(tpx, q(ext, "Watts")).text = str(max(0, round(float(point["power_w"]))))
        except (TypeError, ValueError, OverflowError) as exc:
            raise AppError("A ride sample contains invalid data.") from exc
    return ET.tostring(database, encoding="utf-8", xml_declaration=True)


def _json_safe_activity(activity: dict[str, Any]) -> dict[str, Any]:
    map_data = activity.get("map") or {}
    return {
        "id": activity.get("id"),
        "name": activity.get("name") or "Strava ride",
        "type": activity.get("sport_type") or activity.get("type") or "Ride",
        "start_date": activity.get("start_date"),
        "distance_m": activity.get("distance", 0),
        "moving_time_s": activity.get("moving_time", 0),
        "elapsed_time_s": activity.get("elapsed_time", 0),
        "elevation_gain_m": activity.get("total_elevation_gain", 0),
        "average_speed_mps": activity.get("average_speed", 0),
        "average_watts": activity.get("average_watts"),
        "summary_polyline": map_data.get("summary_polyline") or "",
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "EllaZwiftLocal/0.1"

    def log_message(self, _format: str, *_args: Any) -> None:
        return

    def _send(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "default-src 'self'; connect-src 'self' https://www.strava.com; object-src 'none'; base-uri 'self'; frame-ancestors 'none'")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, status: int, value: Any) -> None:
        self._send(status, json.dumps(value, separators=(",", ":")).encode(), "application/json; charset=utf-8")

    def _read_json(self) -> dict[str, Any]:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise AppError("Invalid request length.") from exc
        if length < 0 or length > MAX_BODY:
            raise AppError("Request body is too large.", 413)
        try:
            value = json.loads(self.rfile.read(length))
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise AppError("Request must contain valid JSON.") from exc
        if not isinstance(value, dict):
            raise AppError("Request body must be a JSON object.")
        return value

    def _read_bytes(self, limit: int) -> bytes:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise AppError("Invalid request length.") from exc
        if length < 0 or length > limit:
            raise AppError("Request body is too large.", 413)
        body = self.rfile.read(length)
        if len(body) != length:
            raise AppError("Request body ended unexpectedly.")
        return body

    def _check_origin(self) -> None:
        origin = self.headers.get("Origin")
        allowed = {f"http://localhost:{PORT}", f"http://127.0.0.1:{PORT}"}
        if origin and origin not in allowed:
            raise AppError("Cross-origin requests are not allowed.", 403)

    def _check_host(self) -> None:
        allowed = {f"localhost:{PORT}", f"127.0.0.1:{PORT}"}
        if self.headers.get("Host", "") not in allowed:
            raise AppError("This local service only accepts requests addressed to localhost.", 403)

    def do_GET(self) -> None:
        global _access_token, _access_expires_at, _webhook_notice
        parsed = urllib.parse.urlsplit(self.path)
        path = parsed.path
        try:
            self._check_host()
            if path == "/api/status":
                configured = _strava_config() is not None
                webhook = _webhook_status()
                if webhook["reachable"]:
                    _webhook_notice = None
                if webhook["revoked"]:
                    _forget_strava_tokens()
                linked = bool(_refresh_token())
                self._json(200, {
                    "strava_configured": configured,
                    "strava_connected": linked,
                    "keyring_available": _keyring_ready(),
                    "webhook": webhook,
                    "webhook_notice": _webhook_notice,
                })
                return
            if path == "/api/strava/connect":
                if _strava_config() is None:
                    raise AppError("Create strava.local.json as described in the setup guide first.")
                if not _keyring_ready():
                    raise AppError("Install requirements.txt so Strava tokens can be stored in the operating-system keychain.", 500)
                state = secrets.token_urlsafe(32)
                with _oauth_lock:
                    _pending_oauth[state] = time.time() + 600
                client_id, _ = _strava_config() or ("", "")
                query = urllib.parse.urlencode({
                    "client_id": client_id,
                    "redirect_uri": REDIRECT_URI,
                    "response_type": "code",
                    "approval_prompt": "auto",
                    "scope": "activity:read_all,activity:write",
                    "state": state,
                })
                self.send_response(302)
                self.send_header("Location", f"https://www.strava.com/oauth/authorize?{query}")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                return
            if path == "/oauth/callback":
                params = urllib.parse.parse_qs(parsed.query)
                state = (params.get("state") or [""])[0]
                code = (params.get("code") or [""])[0]
                error = (params.get("error") or [""])[0]
                with _oauth_lock:
                    expiry = _pending_oauth.pop(state, None)
                    now = time.time()
                    _pending_oauth.update({key: value for key, value in _pending_oauth.items() if value > now})
                if not state or expiry is None or expiry < time.time():
                    raise AppError("Strava authorization state expired or did not match. Try connecting again.", 400)
                if error:
                    raise AppError(f"Strava authorization was not completed: {error}. You can close this tab.")
                if not code:
                    raise AppError("Strava did not return an authorization code.")
                token_data = _token_request({"grant_type": "authorization_code", "code": code})
                _store_refresh_token(token_data.get("refresh_token"))
                _access_token = token_data.get("access_token")
                _access_expires_at = int(token_data.get("expires_at", time.time() + 21_600))
                _webhook_notice = None
                if _webhook_config():
                    try:
                        _webhook_request("/admin/reset", method="POST")
                    except AppError as exc:
                        _webhook_notice = str(exc)
                self.send_response(303)
                self.send_header("Location", "/")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                return
            if path == "/api/strava/activities":
                query_values = urllib.parse.parse_qs(parsed.query)
                try:
                    page = int((query_values.get("page") or ["1"])[0])
                except ValueError as exc:
                    raise AppError("Invalid Strava activity page.") from exc
                if page < 1 or page > 100:
                    raise AppError("Strava activity page must be between 1 and 100.")
                query = urllib.parse.urlencode({"per_page": 50, "page": page})
                data = _strava_request(f"/athlete/activities?{query}")
                rides = [
                    _json_safe_activity(item) for item in data
                    if (item.get("sport_type") or item.get("type")) in {"Ride", "VirtualRide", "EBikeRide"}
                ]
                self._json(200, {"activities": rides})
                return
            if path.startswith("/api/strava/streams/"):
                activity_id = path.rsplit("/", 1)[-1]
                if not activity_id.isdigit():
                    raise AppError("Invalid Strava activity ID.")
                query = urllib.parse.urlencode({
                    "keys": "latlng,altitude,time,watts,cadence",
                    "key_by_type": "true",
                })
                data = _strava_request(f"/activities/{activity_id}/streams?{query}")
                self._json(200, {"streams": data})
                return
            if path.startswith("/api/strava/uploads/"):
                upload_id = path.rsplit("/", 1)[-1]
                if not upload_id.isdigit():
                    raise AppError("Invalid Strava upload ID.")
                data = _strava_request(f"/uploads/{upload_id}")
                self._json(200, data)
                return
            if path == "/api/rides":
                with _connection() as connection:
                    rows = connection.execute(
                        "SELECT id, created_at, title, distance_m, duration_s FROM rides ORDER BY id DESC LIMIT 100"
                    ).fetchall()
                self._json(200, {"rides": [dict(row) for row in rows]})
                return
            if path.startswith("/api/rides/"):
                ride_id = path.rsplit("/", 1)[-1]
                if not ride_id.isdigit():
                    raise AppError("Invalid ride ID.")
                with _connection() as connection:
                    row = connection.execute("SELECT payload FROM rides WHERE id = ?", (int(ride_id),)).fetchone()
                if row is None:
                    raise AppError("Ride not found.", 404)
                self._json(200, json.loads(row["payload"]))
                return
            if path == "/":
                path = "/index.html"
            static_files = {
                "/index.html": ("index.html", "text/html; charset=utf-8"),
                "/app.js": ("app.js", "text/javascript; charset=utf-8"),
                "/styles.css": ("styles.css", "text/css; charset=utf-8"),
            }
            if path not in static_files:
                raise AppError("Not found.", 404)
            filename, content_type = static_files[path]
            self._send(200, (WEB_ROOT / filename).read_bytes(), content_type)
        except AppError as exc:
            if path == "/oauth/callback":
                self._send(exc.status, f"<p>{html.escape(str(exc))}</p>".encode(), "text/html; charset=utf-8")
            else:
                self._json(exc.status, {"error": str(exc)})
        except (OSError, sqlite3.Error) as exc:
            self._json(500, {"error": f"Local storage error: {exc}"})
        except Exception as exc:
            self._json(500, {"error": f"Unexpected local service error: {exc}"})

    def do_POST(self) -> None:
        global _access_token, _access_expires_at, _webhook_notice
        parsed = urllib.parse.urlsplit(self.path)
        path = parsed.path
        try:
            self._check_host()
            self._check_origin()
            if path == "/api/route/parse":
                raw = self._read_bytes(MAX_GPX_BYTES)
                self._json(200, parse_gpx(raw))
                return
            if path == "/api/strava/disconnect":
                _store_refresh_token(None)
                _access_token, _access_expires_at = None, 0
                self._json(200, {"ok": True})
                return
            if path == "/api/strava/webhook/register":
                if not _refresh_token():
                    raise AppError("Connect Strava before registering its webhook.", 401)
                result = _webhook_request("/admin/register", method="POST")
                _webhook_notice = None
                self._json(200, result)
                return
            if path == "/api/rides":
                ride = self._read_json()
                points = ride.get("points")
                if not isinstance(points, list) or len(points) < 2 or len(points) > MAX_TRACK_POINTS:
                    raise AppError("A ride must contain 2 to 50,000 samples.")
                title = str(ride.get("name") or "Indoor route ride")[:100]
                distance = max(0.0, float(points[-1].get("distance_m", 0)))
                duration = max(0.0, float(points[-1].get("elapsed_s", 0)))
                with _connection() as connection:
                    cursor = connection.execute(
                        "INSERT INTO rides (created_at, title, distance_m, duration_s, payload) VALUES (?, ?, ?, ?, ?)",
                        (dt.datetime.now(dt.timezone.utc).isoformat(), title, distance, duration,
                         json.dumps(ride, separators=(",", ":"))),
                    )
                    ride_id = cursor.lastrowid
                self._json(201, {"id": ride_id})
                return
            if path.startswith("/api/strava/uploads/"):
                upload_id = path.rsplit("/", 1)[-1]
                if not upload_id.isdigit():
                    raise AppError("Invalid Strava upload ID.")
                self._json(200, _strava_request(f"/uploads/{upload_id}", method="GET"))
                return
            if path == "/api/strava/upload":
                ride = self._read_json()
                tcx = _build_tcx(ride)
                boundary = "----EllaZwift" + secrets.token_hex(18)
                fields = {
                    "data_type": "tcx",
                    "name": str(ride.get("name") or "Indoor route ride")[:100],
                    "description": "Recorded with Ella Zwift",
                    "trainer": "1",
                    "external_id": str(ride.get("external_id") or f"ella-zwift-{secrets.token_urlsafe(18)}")[:100],
                }
                chunks: list[bytes] = []
                for key, value in fields.items():
                    chunks.extend([
                        f"--{boundary}\r\n".encode(),
                        f'Content-Disposition: form-data; name="{key}"\r\n\r\n'.encode(),
                        str(value).encode("utf-8"),
                        b"\r\n",
                    ])
                chunks.extend([
                    f"--{boundary}\r\n".encode(),
                    b'Content-Disposition: form-data; name="file"; filename="ella-zwift.tcx"\r\n',
                    b"Content-Type: application/vnd.garmin.tcx+xml\r\n\r\n",
                    tcx,
                    b"\r\n",
                    f"--{boundary}--\r\n".encode(),
                ])
                response = _strava_request(
                    "/uploads", method="POST", data=b"".join(chunks),
                    content_type=f"multipart/form-data; boundary={boundary}",
                )
                self._json(202, response)
                return
            raise AppError("Not found.", 404)
        except AppError as exc:
            self._json(exc.status, {"error": str(exc)})
        except (OSError, sqlite3.Error, TypeError, ValueError) as exc:
            self._json(500, {"error": f"Local service error: {exc}"})
        except Exception as exc:
            self._json(500, {"error": f"Unexpected local service error: {exc}"})


def main() -> None:
    if sys.version_info < (3, 10):
        raise SystemExit("Python 3.10 or newer is required.")
    _db().close()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Ella Zwift is running at http://localhost:{PORT}")
    print("Press Ctrl+C to stop. This server is only available on this computer.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping Ella Zwift.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
