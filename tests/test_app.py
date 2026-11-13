import sys
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import app


class WebhookStatusTests(unittest.TestCase):
    @patch("app._webhook_config", return_value=None)
    def test_unconfigured_webhook_is_reported_without_network_access(self, _config):
        self.assertEqual(app._webhook_status(), {
            "configured": False,
            "reachable": False,
            "registered": False,
            "revoked": False,
            "error": None,
        })

    @patch("app._webhook_config", return_value=("https://worker.example", "admin-token"))
    @patch("app._webhook_request", return_value={"subscription_id": 123, "revoked": True})
    def test_status_reports_registered_subscription_and_revocation(self, _request, _config):
        status = app._webhook_status()

        self.assertTrue(status["configured"])
        self.assertTrue(status["reachable"])
        self.assertTrue(status["registered"])
        self.assertTrue(status["revoked"])
        self.assertEqual(status["subscription_id"], 123)

    @patch("app._webhook_config", return_value=("https://worker.example", "admin-token"))
    @patch("app._webhook_request", side_effect=app.AppError("offline", 503))
    def test_status_surfaces_an_unreachable_worker(self, _request, _config):
        status = app._webhook_status()

        self.assertTrue(status["configured"])
        self.assertFalse(status["reachable"])
        self.assertEqual(status["error"], "offline")

    @patch("app._refresh_token", return_value=None)
    @patch("app._webhook_status", return_value={"reachable": True, "revoked": True})
    @patch("app._webhook_config", return_value=("https://worker.example", "admin-token"))
    def test_revocation_invalidates_a_cached_access_token(self, _config, _status, _token):
        with patch.object(app, "_access_token", "cached-token"), \
                patch.object(app, "_access_expires_at", 4_000_000_000):
            with self.assertRaises(app.AppError) as raised:
                app._get_access_token()

            self.assertEqual(raised.exception.status, 401)
            self.assertIsNone(app._access_token)


class ParseGpxTests(unittest.TestCase):
    def test_parses_namespaced_track_and_calculates_route_metrics(self):
        source = b"""<?xml version="1.0"?>
        <gpx xmlns="http://www.topografix.com/GPX/1/1">
          <trk><name>Test climb</name><trkseg>
            <trkpt lat="47.0000" lon="-122.0000"><ele>10</ele><time>2025-01-01T00:00:00Z</time></trkpt>
            <trkpt lat="47.0010" lon="-122.0000"><ele>20</ele></trkpt>
            <trkpt lat="47.0020" lon="-122.0000"><ele>30</ele></trkpt>
          </trkseg></trk>
        </gpx>"""

        route = app.parse_gpx(source)

        self.assertEqual(route["name"], "Test climb")
        self.assertEqual(len(route["points"]), 3)
        self.assertTrue(210 < route["distance_m"] < 230)
        self.assertGreater(route["ascent_m"], 0)
        self.assertTrue(route["has_elevation"])
        self.assertEqual(route["points"][0]["time"], "2025-01-01T00:00:00Z")

    def test_keeps_separate_track_segments_without_counting_gap_distance(self):
        source = b"""<gpx><trk>
        <trkseg>
          <trkpt lat="47.0" lon="-122.0"><ele>1</ele></trkpt>
          <trkpt lat="47.001" lon="-122.0"><ele>2</ele></trkpt>
        </trkseg>
        <trkseg>
          <trkpt lat="48.0" lon="-122.0"><ele>3</ele></trkpt>
          <trkpt lat="48.001" lon="-122.0"><ele>4</ele></trkpt>
        </trkseg>
        </trk></gpx>"""

        route = app.parse_gpx(source)

        self.assertEqual(len(route["segments"]), 2)
        self.assertTrue(210 < route["distance_m"] < 230)

    def test_accepts_route_points_without_elevation(self):
        source = b"""<gpx><rte>
        <rtept lat="47.0" lon="-122.0"/>
        <rtept lat="47.001" lon="-122.0"/>
        </rte></gpx>"""

        route = app.parse_gpx(source)

        self.assertFalse(route["has_elevation"])
        self.assertEqual(route["ascent_m"], 0)
        self.assertGreater(route["distance_m"], 100)

    def test_rejects_malformed_and_empty_files(self):
        for source in (b"", b"<gpx><trkseg>"):
            with self.subTest(source=source), self.assertRaises(app.AppError):
                app.parse_gpx(source)

    def test_rejects_xml_entity_declarations(self):
        source = b'<!DOCTYPE gpx [<!ENTITY x "expanded">]><gpx>&x;</gpx>'
        with self.assertRaises(app.AppError):
            app.parse_gpx(source)


class TcxTests(unittest.TestCase):
    def test_builds_valid_tcx_with_gps_power_and_without_heart_rate(self):
        ride = {
            "name": "Local climb",
            "start_time": "2025-01-01T00:00:00Z",
            "points": [
                {"elapsed_s": 0, "distance_m": 0, "lat": 47.0, "lon": -122.0,
                 "altitude_m": 12, "speed_mps": 0, "power_w": 0, "cadence_rpm": 0},
                {"elapsed_s": 1, "distance_m": 4.2, "lat": 47.00001, "lon": -122.0,
                 "altitude_m": 12.2, "speed_mps": 4.2, "power_w": 150, "cadence_rpm": 80},
            ],
        }

        raw = app._build_tcx(ride)
        root = ET.fromstring(raw)
        names = [element.tag.rsplit("}", 1)[-1] for element in root.iter()]

        self.assertEqual(names.count("Trackpoint"), 2)
        self.assertIn("Watts", names)
        self.assertIn("Position", names)
        self.assertNotIn("HeartRateBpm", names)

    def test_rejects_too_short_activity(self):
        with self.assertRaises(app.AppError):
            app._build_tcx({"start_time": "2025-01-01T00:00:00Z", "points": []})


if __name__ == "__main__":
    unittest.main()
