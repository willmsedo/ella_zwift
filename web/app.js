const FTMS_SERVICE = "00001826-0000-1000-8000-00805f9b34fb";
const FTMS_FEATURE = "00002acc-0000-1000-8000-00805f9b34fb";
const FTMS_INDOOR_BIKE_DATA = "00002ad2-0000-1000-8000-00805f9b34fb";
const FTMS_CONTROL_POINT = "00002ad9-0000-1000-8000-00805f9b34fb";
const FTMS_INCLINATION_RANGE = "00002ad5-0000-1000-8000-00805f9b34fb";
const MAX_GRADE = 8;
const MIN_GRADE = -5;
const ROUTE_SAMPLE_LIMIT = 50000;

const $ = (selector) => document.querySelector(selector);
const state = {
  route: null,
  routeDistanceM: 0,
  trainer: null,
  telemetry: { speedKmh: 0, powerW: null, cadenceRpm: null },
  ride: null,
  rideTimer: null,
  lastTickAt: 0,
  stravaConnected: false,
  stravaConfigured: false,
  stravaPage: 0,
  stravaActivities: [],
  hasMoreActivities: true,
  activityGroups: [],
  ghosts: [],
};

function api(path, options = {}) {
  return fetch(path, options).then(async (response) => {
    const type = response.headers.get("content-type") || "";
    const data = type.includes("application/json") ? await response.json() : {};
    if (!response.ok) throw new Error(data.error || `Local service returned HTTP ${response.status}.`);
    return data;
  });
}

function setMessage(id, message, isError = false) {
  const element = $(id);
  element.textContent = message || "";
  element.style.color = isError ? "var(--red)" : "var(--lime)";
}

function setTag(id, text, mode = "") {
  const element = $(id);
  element.textContent = text;
  element.className = `status-tag ${mode}`.trim();
}

function formatDistance(meters) {
  return `${(Math.max(0, meters || 0) / 1000).toFixed(1)}`;
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(seconds || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  return hours ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}` :
    `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function formatDate(value) {
  if (!value) return "DATE UNKNOWN";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "DATE UNKNOWN" :
    date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }).toUpperCase();
}

function haversine(a, b) {
  const radius = 6371000;
  const toRadians = (value) => value * Math.PI / 180;
  const latitude1 = toRadians(a.lat);
  const latitude2 = toRadians(b.lat);
  const latitudeDelta = latitude2 - latitude1;
  const longitudeDelta = toRadians(b.lon - a.lon);
  const value = Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(latitude1) * Math.cos(latitude2) * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * radius * Math.asin(Math.min(1, Math.sqrt(value)));
}

function smoothElevations(points) {
  if (points.length <= 5) return points.map((point) => point.ele);
  return points.map((point, index) => {
    if (point.ele == null) return null;
    const nearby = points.slice(Math.max(0, index - 2), Math.min(points.length, index + 3))
      .map((item) => item.ele).filter((value) => value != null);
    return nearby.length ? nearby.reduce((sum, value) => sum + value, 0) / nearby.length : null;
  });
}

function enrichRoute(name, segments, source = "GPX") {
  let distance = 0;
  let ascent = 0;
  let descent = 0;
  const all = [];
  const normalized = segments.map((segment) => {
    const points = segment.map((point, index) => {
      if (index > 0) distance += haversine(segment[index - 1], point);
      return { ...point, distance_m: distance, grade_pct: 0 };
    });
    const smoothed = smoothElevations(points);
    points.forEach((point, index) => {
      point.smooth_ele = smoothed[index];
      if (index && smoothed[index] != null && smoothed[index - 1] != null) {
        const deltaDistance = point.distance_m - points[index - 1].distance_m;
        const deltaElevation = smoothed[index] - smoothed[index - 1];
        if (deltaDistance > 0) {
          point.grade_pct = Math.max(-30, Math.min(30, 100 * deltaElevation / deltaDistance));
          ascent += Math.max(0, deltaElevation);
          descent += Math.max(0, -deltaElevation);
        }
      }
      all.push(point);
    });
    return points;
  });
  return {
    name,
    segments: normalized,
    points: all,
    distance_m: distance,
    ascent_m: ascent,
    descent_m: descent,
    has_elevation: all.some((point) => point.ele != null),
    source,
  };
}

function decodePolyline(encoded) {
  if (!encoded) return [];
  const points = [];
  let index = 0;
  let latitude = 0;
  let longitude = 0;
  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let byte;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index <= encoded.length);
    latitude += result & 1 ? ~(result >> 1) : result >> 1;
    result = 0;
    shift = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index <= encoded.length);
    longitude += result & 1 ? ~(result >> 1) : result >> 1;
    points.push({ lat: latitude / 1e5, lon: longitude / 1e5, ele: null, time: null });
  }
  return points;
}

function resampleCoordinates(points, sampleCount = 18) {
  if (points.length < 2) return points;
  const withDistance = [{ point: points[0], distance: 0 }];
  for (let index = 1; index < points.length; index += 1) {
    withDistance.push({
      point: points[index],
      distance: withDistance[index - 1].distance + haversine(points[index - 1], points[index]),
    });
  }
  const total = withDistance.at(-1).distance;
  if (!total) return points.slice(0, 1);
  const samples = [];
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const target = total * sample / (sampleCount - 1);
    let index = 1;
    while (index < withDistance.length - 1 && withDistance[index].distance < target) index += 1;
    const before = withDistance[index - 1];
    const after = withDistance[index];
    const span = after.distance - before.distance;
    const fraction = span ? (target - before.distance) / span : 0;
    samples.push({
      lat: before.point.lat + (after.point.lat - before.point.lat) * fraction,
      lon: before.point.lon + (after.point.lon - before.point.lon) * fraction,
    });
  }
  return samples;
}

function routeSimilarity(a, b) {
  if (!a.shape?.length || !b.shape?.length) return false;
  const ratio = Math.abs(a.activity.distance_m - b.activity.distance_m) /
    Math.max(a.activity.distance_m, b.activity.distance_m, 1);
  if (ratio > 0.18) return false;
  const direct = a.shape.reduce((sum, point, index) => sum + haversine(point, b.shape[index]), 0) / a.shape.length;
  const reverse = a.shape.reduce((sum, point, index) => sum + haversine(point, b.shape[b.shape.length - index - 1]), 0) / a.shape.length;
  return Math.min(direct, reverse) <= 150;
}

function makeRouteFromStreams(activity, streamResponse) {
  const streams = streamResponse.streams;
  const byType = Array.isArray(streams) ?
    Object.fromEntries(streams.map((stream) => [stream.type, stream])) : streams;
  const coords = byType?.latlng?.data || decodePolyline(activity.summary_polyline).map((point) => [point.lat, point.lon]);
  if (!Array.isArray(coords) || coords.length < 2) throw new Error("Strava did not provide a usable route track.");
  const altitudes = byType?.altitude?.data || [];
  const times = byType?.time?.data || [];
  const segments = [[]];
  coords.slice(0, ROUTE_SAMPLE_LIMIT).forEach((coordinate, index) => {
    if (!Array.isArray(coordinate) || coordinate.length < 2) return;
    const ele = Number.isFinite(Number(altitudes[index])) ? Number(altitudes[index]) : null;
    segments[0].push({
      lat: Number(coordinate[0]),
      lon: Number(coordinate[1]),
      ele,
      time: Number.isFinite(Number(times[index])) ? Number(times[index]) : null,
    });
  });
  const route = enrichRoute(activity.name, segments, "Strava");
  if (route.points.length < 2) throw new Error("Strava route track did not contain enough valid GPS points.");
  route.source_activity_id = activity.id;
  route.source_date = activity.start_date;
  return route;
}

function routePointAt(distanceM) {
  const route = state.route;
  if (!route?.points?.length) return null;
  const points = route.points;
  const distance = Math.max(0, Math.min(distanceM, route.distance_m));
  for (let index = 1; index < points.length; index += 1) {
    const before = points[index - 1];
    const after = points[index];
    if (distance <= after.distance_m && after.distance_m > before.distance_m) {
      const fraction = (distance - before.distance_m) / (after.distance_m - before.distance_m);
      return {
        lat: before.lat + (after.lat - before.lat) * fraction,
        lon: before.lon + (after.lon - before.lon) * fraction,
        ele: before.smooth_ele == null || after.smooth_ele == null ? null :
          before.smooth_ele + (after.smooth_ele - before.smooth_ele) * fraction,
        grade_pct: after.grade_pct || 0,
      };
    }
  }
  const last = points.at(-1);
  return { lat: last.lat, lon: last.lon, ele: last.smooth_ele, grade_pct: 0 };
}

function projectionFor(allPoints) {
  const valid = allPoints.filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lon));
  if (!valid.length) return () => ({ x: 450, y: 250 });
  const meanLat = valid.reduce((sum, point) => sum + point.lat, 0) / valid.length;
  const cosine = Math.max(.1, Math.cos(meanLat * Math.PI / 180));
  const raw = valid.map((point) => ({ x: point.lon * cosine, y: point.lat }));
  const minX = Math.min(...raw.map((point) => point.x));
  const maxX = Math.max(...raw.map((point) => point.x));
  const minY = Math.min(...raw.map((point) => point.y));
  const maxY = Math.max(...raw.map((point) => point.y));
  const scale = Math.min(810 / Math.max(maxX - minX, .00001), 410 / Math.max(maxY - minY, .00001));
  const offsetX = (900 - (maxX - minX) * scale) / 2;
  const offsetY = (500 - (maxY - minY) * scale) / 2;
  return (point) => ({
    x: offsetX + (point.lon * cosine - minX) * scale,
    y: 250 - (point.lat - (minY + maxY) / 2) * scale,
  });
}

function pathFor(points, project) {
  return points.length ? `M ${points.map((point) => {
    const p = project(point);
    return `${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
  }).join(" L ")}` : "";
}

function partialRoutePoints(distanceM) {
  const points = [];
  for (const segment of state.route?.segments || []) {
    for (const point of segment) {
      if (point.distance_m <= distanceM) points.push(point);
      else break;
    }
    if (points.length && points.at(-1).distance_m < distanceM) {
      const end = segment.find((point) => point.distance_m >= distanceM);
      if (end) {
        const before = segment[Math.max(0, segment.indexOf(end) - 1)];
        if (before && end.distance_m > before.distance_m) {
          const ratio = (distanceM - before.distance_m) / (end.distance_m - before.distance_m);
          points.push({
            lat: before.lat + (end.lat - before.lat) * ratio,
            lon: before.lon + (end.lon - before.lon) * ratio,
          });
        }
      }
    }
  }
  return points;
}

function ghostMarker(ghost, elapsedS) {
  if (!ghost.points.length) return null;
  const target = Math.max(0, elapsedS);
  let index = ghost.points.findIndex((point) => point.time_s >= target);
  if (index === -1) return ghost.points.at(-1);
  if (index === 0) return ghost.points[0];
  const before = ghost.points[index - 1];
  const after = ghost.points[index];
  const span = after.time_s - before.time_s;
  const fraction = span > 0 ? Math.max(0, Math.min(1, (target - before.time_s) / span)) : 0;
  return {
    lat: before.lat + (after.lat - before.lat) * fraction,
    lon: before.lon + (after.lon - before.lon) * fraction,
  };
}

function renderMap() {
  const layers = $("#map-layers");
  const emptyTexts = document.querySelectorAll(".map-empty, .map-empty-sub");
  if (!state.route?.points?.length) {
    layers.innerHTML = "";
    emptyTexts.forEach((element) => { element.style.display = ""; });
    return;
  }
  emptyTexts.forEach((element) => { element.style.display = "none"; });
  const ghostPoints = state.ghosts.map((ghost) => ghostMarker(ghost, state.ride?.elapsed_s || 0)).filter(Boolean);
  const project = projectionFor([...state.route.points, ...ghostPoints]);
  const segmentPaths = state.route.segments.map((segment) => pathFor(segment, project)).filter(Boolean);
  const progressPath = pathFor(partialRoutePoints(state.routeDistanceM), project);
  const first = state.route.points[0];
  const last = state.route.points.at(-1);
  const current = routePointAt(state.routeDistanceM);
  const start = project(first);
  const finish = project(last);
  const marker = current && project(current);
  const ghostMarkup = ghostPoints.map((point) => {
    const p = project(point);
    return `<circle class="ghost-marker" cx="${p.x}" cy="${p.y}" r="6"/>`;
  }).join("");
  layers.innerHTML = `
    ${segmentPaths.map((path) => `<path class="route-line" d="${path}"/>`).join("")}
    <path class="route-progress" d="${progressPath}"/>
    <circle class="route-start" cx="${start.x}" cy="${start.y}" r="6"/>
    <circle class="route-end" cx="${finish.x}" cy="${finish.y}" r="5"/>
    ${ghostMarkup}
    ${state.ride && marker ? `<circle class="live-marker" cx="${marker.x}" cy="${marker.y}" r="7"/>` : ""}
  `;
}

function renderElevation() {
  const svg = $("#elevation-chart");
  if (!state.route?.points?.length || !state.route.has_elevation) {
    svg.innerHTML = `<text x="450" y="68" text-anchor="middle" fill="#718078" font-size="10" font-family="monospace">ELEVATION DATA NOT AVAILABLE</text>`;
    $("#elevation-range").textContent = "NO DATA";
    return;
  }
  const points = state.route.points.filter((point) => point.smooth_ele != null);
  const minElevation = Math.min(...points.map((point) => point.smooth_ele));
  const maxElevation = Math.max(...points.map((point) => point.smooth_ele));
  const distance = Math.max(state.route.distance_m, 1);
  const x = (point) => 12 + 876 * point.distance_m / distance;
  const y = (point) => 110 - 88 * (point.smooth_ele - minElevation) / Math.max(maxElevation - minElevation, 1);
  const line = `M ${points.map((point) => `${x(point).toFixed(1)} ${y(point).toFixed(1)}`).join(" L ")}`;
  const area = `${line} L 888 118 L 12 118 Z`;
  const marker = routePointAt(state.routeDistanceM);
  const markerElevation = marker?.ele;
  const markerX = 12 + 876 * state.routeDistanceM / distance;
  const markerY = markerElevation == null ? 0 : 110 - 88 * (markerElevation - minElevation) / Math.max(maxElevation - minElevation, 1);
  svg.innerHTML = `
    <path class="elevation-grid" d="M12 22 H888 M12 66 H888 M12 110 H888"/>
    <path class="elevation-area" d="${area}"/>
    <path class="elevation-line" d="${line}"/>
    ${state.ride ? `<circle cx="${markerX}" cy="${markerY}" r="4" fill="#f2a76f" stroke="#1b2421" stroke-width="2"/>` : ""}
  `;
  $("#elevation-range").textContent = `${Math.round(minElevation)} — ${Math.round(maxElevation)} M`;
}

function renderRoute() {
  const route = state.route;
  if (!route) {
    $("#route-name").textContent = "Choose a route";
    $("#route-hint").textContent = "Import a GPX file or load one of your Strava rides.";
    $("#route-distance").textContent = "—";
    $("#route-ascent").textContent = "—";
    $("#route-descent").textContent = "—";
    $("#route-grade").textContent = "0.0";
    $("#map-distance").textContent = "— KM";
    renderMap();
    renderElevation();
    $("#start-ride").disabled = true;
    return;
  }
  $("#route-name").textContent = route.name;
  $("#route-hint").textContent = `${route.source} ROUTE${route.source_date ? ` · ORIGINAL RIDE ${formatDate(route.source_date)}` : ""}${route.has_elevation ? "" : " · NO ELEVATION DATA, SIMULATING FLAT"}`;
  $("#route-distance").textContent = formatDistance(route.distance_m);
  $("#route-ascent").textContent = Math.round(route.ascent_m).toLocaleString();
  $("#route-descent").textContent = Math.round(route.descent_m).toLocaleString();
  $("#map-distance").textContent = `${formatDistance(state.routeDistanceM)} / ${formatDistance(route.distance_m)} KM`;
  const current = routePointAt(state.routeDistanceM);
  $("#route-grade").textContent = `${(current?.grade_pct || 0).toFixed(1)}`;
  renderMap();
  renderElevation();
  $("#start-ride").disabled = !state.trainer?.controlActive || Boolean(state.ride);
}

function parseIndoorBikeData(value) {
  const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
  if (view.byteLength < 2) return null;
  const flags = view.getUint16(0, true);
  let offset = 2;
  const parsed = { speedKmh: null, powerW: null, cadenceRpm: null };
  const need = (size) => offset + size <= view.byteLength;
  const readU16 = () => { const result = view.getUint16(offset, true); offset += 2; return result; };
  const readI16 = () => { const result = view.getInt16(offset, true); offset += 2; return result; };
  const skip = (size) => { offset += size; };

  if (!(flags & 0x0001) && need(2)) parsed.speedKmh = readU16() / 100;
  if (flags & 0x0002) { if (!need(2)) return parsed; readU16(); }
  if (flags & 0x0004) { if (!need(2)) return parsed; parsed.cadenceRpm = readU16() / 2; }
  if (flags & 0x0008) { if (!need(2)) return parsed; readU16(); }
  if (flags & 0x0010) { if (!need(3)) return parsed; skip(3); }
  if (flags & 0x0020) { if (!need(2)) return parsed; readI16(); }
  if (flags & 0x0040) { if (!need(2)) return parsed; parsed.powerW = readI16(); }
  if (flags & 0x0080) { if (!need(2)) return parsed; readI16(); }
  if (flags & 0x0100) { if (!need(5)) return parsed; skip(5); }
  if (flags & 0x0200) { if (!need(1)) return parsed; skip(1); }
  if (flags & 0x0400) { if (!need(1)) return parsed; skip(1); }
  if (flags & 0x0800) { if (!need(2)) return parsed; skip(2); }
  if (flags & 0x1000) { if (!need(2)) return parsed; skip(2); }
  return parsed;
}

function onBikeData(event) {
  const parsed = parseIndoorBikeData(event.target.value);
  if (!parsed) return;
  if (parsed.speedKmh != null) state.telemetry.speedKmh = parsed.speedKmh;
  if (parsed.powerW != null) state.telemetry.powerW = parsed.powerW;
  if (parsed.cadenceRpm != null) state.telemetry.cadenceRpm = parsed.cadenceRpm;
  renderMetrics();
}

function renderMetrics() {
  $("#metric-speed").textContent = Number(state.telemetry.speedKmh || 0).toFixed(1);
  $("#metric-power").textContent = state.telemetry.powerW == null ? "—" : Math.round(state.telemetry.powerW);
  $("#metric-cadence").textContent = state.telemetry.cadenceRpm == null ? "—" : Math.round(state.telemetry.cadenceRpm);
  $("#metric-time").textContent = formatDuration(state.ride?.elapsed_s || 0);
}

function onControlResponse(event) {
  if (!state.trainer?.pending) return;
  const bytes = new Uint8Array(event.target.value.buffer, event.target.value.byteOffset, event.target.value.byteLength);
  if (bytes.length < 3 || bytes[0] !== 0x80 || bytes[1] !== state.trainer.pending.opcode) return;
  const pending = state.trainer.pending;
  state.trainer.pending = null;
  clearTimeout(pending.timeout);
  pending.resolve(bytes[2]);
}

function sendControl(opcode, payload = []) {
  return new Promise(async (resolve, reject) => {
    if (!state.trainer?.controlPoint) {
      reject(new Error("Trainer control point is not available."));
      return;
    }
    if (state.trainer.pending) {
      reject(new Error("Trainer is still responding to the previous command."));
      return;
    }
    const pending = {
      opcode,
      resolve,
      reject,
      timeout: setTimeout(() => {
        if (state.trainer?.pending === pending) state.trainer.pending = null;
        reject(new Error("Trainer did not acknowledge the control command."));
      }, 4000),
    };
    state.trainer.pending = pending;
    try {
      await state.trainer.controlPoint.writeValueWithResponse(Uint8Array.from([opcode, ...payload]));
    } catch (error) {
      clearTimeout(pending.timeout);
      state.trainer.pending = null;
      reject(new Error(`Could not write trainer control command: ${error.message}`));
    }
  });
}

async function connectTrainer() {
  let device = null;
  try {
    if (!navigator.bluetooth) throw new Error("Web Bluetooth is unavailable. Use a recent Chrome or Edge browser.");
    setMessage("#trainer-message", "Choose the KICKR in the Bluetooth device picker…");
    device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: [FTMS_SERVICE, "00001818-0000-1000-8000-00805f9b34fb"],
    });
    device.addEventListener("gattserverdisconnected", () => {
      if (state.trainer?.device !== device) return;
      state.trainer.controlActive = false;
      state.trainer.connected = false;
      setTag("#trainer-indicator", "DISCONNECTED", "warning");
      $("#trainer-message").textContent = "Bluetooth disconnected. Check trainer resistance before continuing.";
      $("#connect-trainer").disabled = false;
      $("#disconnect-trainer").disabled = true;
      $("#enable-control").disabled = true;
      $("#start-ride").disabled = true;
      if (state.ride) pauseRide("CONNECTION LOST");
    });
    const server = await device.gatt.connect();
    let service;
    try {
      service = await server.getPrimaryService(FTMS_SERVICE);
    } catch {
      throw new Error("The KICKR did not expose the standard FTMS service. Confirm the model and update its firmware in the Wahoo app. This app does not support ANT+ or proprietary Wahoo control.");
    }
    const trainer = {
      device, server, service, controlPoint: null, controlActive: false, connected: true,
      pending: null, lastGrade: null, lastCommandAt: 0,
      inclineRange: { min: MIN_GRADE, max: MAX_GRADE },
      zeroGradeSupported: true,
    };
    state.trainer = trainer;
    let dataCharacteristic = null;
    try {
      dataCharacteristic = await service.getCharacteristic(FTMS_INDOOR_BIKE_DATA);
      await dataCharacteristic.startNotifications();
      dataCharacteristic.addEventListener("characteristicvaluechanged", onBikeData);
    } catch {
      dataCharacteristic = null;
    }
    try {
      trainer.controlPoint = await service.getCharacteristic(FTMS_CONTROL_POINT);
      await trainer.controlPoint.startNotifications();
      trainer.controlPoint.addEventListener("characteristicvaluechanged", onControlResponse);
    } catch {
      trainer.controlPoint = null;
    }
    const details = [];
    if (dataCharacteristic) details.push("Indoor Bike Data: notifications enabled");
    else details.push("Indoor Bike Data: unavailable");
    if (trainer.controlPoint) details.push("Control Point: available; no resistance command sent");
    else details.push("Control Point: unavailable");
    try {
      const feature = await service.getCharacteristic(FTMS_FEATURE);
      const featureValue = await feature.readValue();
      const value = new Uint8Array(featureValue.buffer, featureValue.byteOffset, featureValue.byteLength);
      details.push(`FTMS features: ${Array.from(value).map((byte) => byte.toString(16).padStart(2, "0")).join(" ")}`);
    } catch {
      details.push("FTMS features: unreadable");
    }
    try {
      const range = await service.getCharacteristic(FTMS_INCLINATION_RANGE);
      const rangeValue = await range.readValue();
      const value = new DataView(rangeValue.buffer, rangeValue.byteOffset, rangeValue.byteLength);
      if (value.byteLength >= 4) {
        const hardwareMin = value.getInt16(0, true) / 10;
        const hardwareMax = value.getInt16(2, true) / 10;
        const safeMin = Math.max(MIN_GRADE, hardwareMin);
        const safeMax = Math.min(MAX_GRADE, hardwareMax);
        if (safeMin <= safeMax) trainer.inclineRange = { min: safeMin, max: safeMax };
        trainer.zeroGradeSupported = hardwareMin <= 0 && hardwareMax >= 0;
        details.push(`Incline range: ${hardwareMin.toFixed(1)}% to ${hardwareMax.toFixed(1)}% (app limit ${trainer.inclineRange.min.toFixed(1)}% to ${trainer.inclineRange.max.toFixed(1)}%)`);
        if (!trainer.zeroGradeSupported) details.push("Control disabled: hardware range does not include 0%.");
      }
    } catch {
      details.push("Incline range: not reported");
    }
    $("#trainer-diagnostics").textContent = details.join(" · ");
    $("#trainer-message").textContent = device.name ? `${device.name} connected. Read-only until you enable trainer control.` : "Trainer connected. Read-only until you enable trainer control.";
    setTag("#trainer-indicator", "CONNECTED", "connected");
    $("#connect-trainer").disabled = true;
    $("#disconnect-trainer").disabled = false;
    $("#enable-control").disabled = !trainer.controlPoint || !trainer.zeroGradeSupported;
    renderRoute();
  } catch (error) {
    try { if (device?.gatt?.connected) device.gatt.disconnect(); } catch { /* Device may already be disconnected. */ }
    if (state.trainer?.device === device) state.trainer = null;
    $("#trainer-message").textContent = error.message || "Could not connect to the trainer.";
    setTag("#trainer-indicator", "NOT CONNECTED", "warning");
    $("#trainer-diagnostics").textContent = "No control command was sent.";
    $("#connect-trainer").disabled = false;
  }
}

async function enableTrainerControl() {
  let controlRequested = false;
  try {
    $("#enable-control").disabled = true;
    if (!state.trainer?.zeroGradeSupported) throw new Error("Trainer reports an incline range that excludes 0%; control stays disabled.");
    setMessage("#trainer-message", "Requesting trainer control…");
    const controlResult = await sendControl(0x00);
    if (controlResult !== 0x01) throw new Error(`Trainer refused control (result ${controlResult}).`);
    controlRequested = true;
    const startResult = await sendControl(0x07);
    if (startResult !== 0x01) throw new Error(`Trainer did not accept start/resume (result ${startResult}).`);
    state.trainer.controlActive = true;
    state.trainer.lastGrade = null;
    await setTrainerGrade(0, true);
    $("#trainer-message").textContent = "Trainer control enabled. Start an easy route when ready.";
    $("#enable-control").textContent = "CONTROL ENABLED";
    $("#start-ride").disabled = !state.route;
  } catch (error) {
    let releaseMessage = "";
    if (controlRequested && state.trainer?.connected) {
      try { await sendControl(0x08, [0x01]); }
      catch (releaseError) { releaseMessage = ` Could not release trainer control: ${releaseError.message}`; }
    }
    state.trainer.controlActive = false;
    $("#trainer-message").textContent = `${error.message}${releaseMessage}`;
    $("#enable-control").disabled = !state.trainer?.controlPoint || !state.trainer?.zeroGradeSupported;
    $("#enable-control").textContent = "ENABLE CONTROL";
  }
}

async function setTrainerGrade(value, force = false) {
  if (!state.trainer?.controlActive) return;
  const target = Math.max(state.trainer.inclineRange.min, Math.min(state.trainer.inclineRange.max, Number(value) || 0));
  const grade = !force && state.trainer.lastGrade != null ?
    Math.max(state.trainer.lastGrade - 1, Math.min(state.trainer.lastGrade + 1, target)) : target;
  const now = Date.now();
  if (!force && state.trainer.lastGrade != null &&
      Math.abs(grade - state.trainer.lastGrade) < 0.25 && now - state.trainer.lastCommandAt < 4000) return;
  if (!force && now - state.trainer.lastCommandAt < 1000) return;
  const gradeHundredths = Math.round(grade * 100);
  const bytes = [
    0x00, 0x00,
    gradeHundredths & 0xff, (gradeHundredths >> 8) & 0xff,
    40, 0,
  ];
  const result = await sendControl(0x11, bytes);
  if (result !== 0x01) throw new Error(`Trainer rejected the grade command (result ${result}).`);
  state.trainer.lastGrade = grade;
  state.trainer.lastCommandAt = now;
}

async function releaseTrainerControl() {
  if (!state.trainer?.controlActive) return;
  try {
    await setTrainerGrade(0, true);
    await sendControl(0x08, [0x01]);
  } catch (error) {
    $("#trainer-message").textContent = `Could not return trainer to neutral: ${error.message}`;
  } finally {
    state.trainer.controlActive = false;
    $("#enable-control").disabled = !state.trainer?.controlPoint;
    $("#enable-control").textContent = "ENABLE CONTROL";
    $("#start-ride").disabled = true;
  }
}

async function disconnectTrainer() {
  if (state.ride) await finishRide(false);
  await releaseTrainerControl();
  try { state.trainer?.device?.gatt?.disconnect(); } catch { /* Device may already be disconnected. */ }
  state.trainer = null;
  setTag("#trainer-indicator", "NOT CONNECTED");
  $("#trainer-message").textContent = "Trainer disconnected.";
  $("#trainer-diagnostics").textContent = "FTMS diagnostics will appear after connecting.";
  $("#connect-trainer").disabled = false;
  $("#disconnect-trainer").disabled = true;
  $("#enable-control").disabled = true;
  $("#start-ride").disabled = true;
}

function currentRidePoint() {
  return routePointAt(state.routeDistanceM);
}

function appendRideSample() {
  if (!state.ride || state.ride.points.length >= ROUTE_SAMPLE_LIMIT) return;
  const routePoint = currentRidePoint();
  const sample = {
    elapsed_s: state.ride.elapsed_s,
    distance_m: state.routeDistanceM,
    lat: routePoint?.lat ?? null,
    lon: routePoint?.lon ?? null,
    altitude_m: routePoint?.ele ?? null,
    speed_mps: Math.max(0, Number(state.telemetry.speedKmh || 0) / 3.6),
    power_w: state.telemetry.powerW,
    cadence_rpm: state.telemetry.cadenceRpm,
    heart_rate_bpm: null,
  };
  const last = state.ride.points.at(-1);
  if (!last || sample.elapsed_s > last.elapsed_s) state.ride.points.push(sample);
}

async function rideTick() {
  if (!state.ride || state.ride.paused) return;
  const now = Date.now();
  const elapsed = Math.max(0, (now - state.ride.started_at_ms) / 1000 - state.ride.paused_s);
  const delta = Math.max(0, Math.min(5, (now - state.lastTickAt) / 1000));
  state.lastTickAt = now;
  state.ride.elapsed_s = elapsed;
  state.routeDistanceM = Math.min(
    state.route.distance_m,
    state.routeDistanceM + Math.max(0, state.telemetry.speedKmh / 3.6) * delta,
  );
  const routePoint = currentRidePoint();
  const grade = state.route.has_elevation ? routePoint?.grade_pct || 0 : 0;
  try {
    await setTrainerGrade(grade);
  } catch (error) {
    setMessage("#ride-message", error.message, true);
    await pauseRide("CONTROL ERROR");
  }
  appendRideSample();
  $("#route-grade").textContent = grade.toFixed(1);
  $("#map-distance").textContent = `${formatDistance(state.routeDistanceM)} / ${formatDistance(state.route.distance_m)} KM`;
  $("#ride-state").textContent = "RIDING";
  renderMetrics();
  renderMap();
  renderElevation();
}

async function startRide() {
  if (!state.route || !state.trainer?.controlActive) return;
  state.routeDistanceM = 0;
  const now = Date.now();
  state.ride = {
    name: state.route.name,
    external_id: `ella-zwift-${crypto.randomUUID()}`,
    start_time: new Date(now).toISOString(),
    elapsed_s: 0,
    distance_m: 0,
    points: [],
    paused: false,
    paused_s: 0,
    started_at_ms: now,
  };
  state.lastTickAt = now;
  appendRideSample();
  $("#ride-state").textContent = "RIDING";
  $("#start-ride").disabled = true;
  $("#pause-ride").disabled = false;
  $("#finish-ride").disabled = false;
  $("#pause-ride").textContent = "PAUSE";
  setMessage("#ride-message", "Ride recording started. No heart-rate sensor is connected.");
  state.rideTimer = setInterval(rideTick, 1000);
  await rideTick();
}

async function pauseRide(reason = "") {
  if (!state.ride || state.ride.paused) return;
  state.ride.paused = true;
  state.ride.paused_at_ms = Date.now();
  $("#ride-state").textContent = reason ? `PAUSED · ${reason}` : "PAUSED";
  $("#pause-ride").textContent = "RESUME";
  if (!reason) {
    try { await setTrainerGrade(0, true); } catch (error) { setMessage("#ride-message", error.message, true); }
  } else {
    setMessage("#ride-message", "Trainer control was interrupted. Stop pedaling and inspect the trainer before resuming.", true);
  }
}

async function resumeRide() {
  if (!state.ride?.paused || !state.trainer?.controlActive) {
    if (!state.trainer?.controlActive) setMessage("#ride-message", "Reconnect and enable trainer control before resuming.", true);
    return;
  }
  state.ride.paused_s += (Date.now() - state.ride.paused_at_ms) / 1000;
  state.ride.paused = false;
  state.lastTickAt = Date.now();
  $("#ride-state").textContent = "RIDING";
  $("#pause-ride").textContent = "PAUSE";
  setMessage("#ride-message", "Ride resumed.");
}

async function finishRide(upload = true) {
  if (!state.ride) return;
  clearInterval(state.rideTimer);
  if (state.ride.paused) state.ride.paused_s += (Date.now() - state.ride.paused_at_ms) / 1000;
  state.ride.elapsed_s = Math.max(0, (Date.now() - state.ride.started_at_ms) / 1000 - state.ride.paused_s);
  state.ride.distance_m = state.routeDistanceM;
  appendRideSample();
  const finishedRide = {
    name: state.ride.name,
    start_time: state.ride.start_time,
    elapsed_s: state.ride.elapsed_s,
    distance_m: state.routeDistanceM,
    points: state.ride.points,
  };
  state.ride = null;
  $("#ride-state").textContent = "SAVING";
  $("#pause-ride").disabled = true;
  $("#finish-ride").disabled = true;
  $("#start-ride").disabled = !state.trainer?.controlActive || !state.route;
  try {
    if (state.trainer?.controlActive) await setTrainerGrade(0, true);
  } catch (error) {
    setMessage("#ride-message", `Ride saved, but trainer did not acknowledge neutral grade: ${error.message}`, true);
  }
  try {
    await api("/api/rides", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(finishedRide),
    });
    setMessage("#ride-message", `Saved locally · ${formatDistance(finishedRide.distance_m)} km · ${formatDuration(finishedRide.elapsed_s)}.`);
    await loadRideHistory();
    if (upload && $("#auto-upload").checked && state.stravaConnected) await uploadRide(finishedRide);
    else if (upload && $("#auto-upload").checked && !state.stravaConnected) {
      setMessage("#ride-message", "Saved locally. Connect Strava to upload this ride.");
    }
  } catch (error) {
    setMessage("#ride-message", `Ride ended, but local save failed: ${error.message}`, true);
  } finally {
    $("#ride-state").textContent = "READY";
    $("#pause-ride").textContent = "PAUSE";
    $("#pause-ride").disabled = true;
    $("#finish-ride").disabled = true;
    renderMetrics();
    renderRoute();
  }
}

async function uploadRide(ride) {
  setMessage("#ride-message", "Uploading TCX activity to Strava…");
  try {
    const upload = await api("/api/strava/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ride),
    });
    if (!upload.id) throw new Error(upload.error || "Strava did not return an upload ID.");
    const deadline = Date.now() + 60_000;
    let result = upload;
    while (Date.now() < deadline) {
      if (result.activity_id) {
        setMessage("#ride-message", `Uploaded to Strava · activity ${result.activity_id}.`);
        return;
      }
      if (result.error) throw new Error(result.error);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      result = await api(`/api/strava/uploads/${upload.id}`);
    }
    setMessage("#ride-message", `Strava is still processing upload ${upload.id}. Check your Strava activities shortly.`);
  } catch (error) {
    setMessage("#ride-message", `Local copy saved, Strava upload failed: ${error.message}`, true);
  }
}

async function importGpx(file) {
  if (!file) return;
  if (!file.name.toLowerCase().endsWith(".gpx")) {
    setMessage("#ride-message", "Choose a .gpx file.", true);
    return;
  }
  setMessage("#ride-message", "Reading GPX route…");
  try {
    const raw = await file.arrayBuffer();
    if (raw.byteLength > 10 * 1024 * 1024) throw new Error("GPX files must be 10 MB or smaller.");
    const route = await api("/api/route/parse", {
      method: "POST",
      headers: { "Content-Type": "application/gpx+xml" },
      body: raw,
    });
    state.route = route;
    state.route.source = "GPX";
    state.routeDistanceM = 0;
    state.ghosts = [];
    setMessage("#ride-message", `Loaded ${route.points.length.toLocaleString()} route points.`);
    renderRoute();
  } catch (error) {
    setMessage("#ride-message", error.message, true);
  } finally {
    $("#gpx-file").value = "";
  }
}

async function loadStatus() {
  try {
    const status = await api("/api/status");
    state.stravaConnected = status.strava_connected;
    state.stravaConfigured = status.strava_configured;
    setTag("#strava-indicator", state.stravaConnected ? "CONNECTED" : "NOT CONNECTED", state.stravaConnected ? "connected" : "");
    $("#connect-strava").textContent = status.strava_configured ? "CONNECT STRAVA" : "SET UP STRAVA FIRST";
    $("#connect-strava").disabled = !status.strava_configured || !status.keyring_available || state.stravaConnected;
    $("#refresh-strava").disabled = !state.stravaConnected;
    $("#load-older").disabled = !state.stravaConnected || !state.hasMoreActivities;
    $("#disconnect-strava").disabled = !state.stravaConnected;
    $("#register-webhook").disabled = !state.stravaConnected ||
      !status.webhook?.configured || !status.webhook?.reachable || status.webhook?.registered;
    if (status.webhook_notice) {
      setMessage("#strava-message", status.webhook_notice, true);
    } else if (!status.keyring_available && status.strava_configured) {
      setMessage("#strava-message", "Install requirements.txt to enable secure Strava token storage.", true);
    } else if (!status.strava_configured) {
      setMessage("#strava-message", "Create strava.local.json using the setup guide to enable Strava.");
    } else if (state.stravaConnected) {
      if (status.webhook?.configured && !status.webhook.reachable) {
        setMessage("#strava-message", `Webhook service unavailable: ${status.webhook.error}`, true);
      } else if (status.webhook?.registered) {
        setMessage("#strava-message", "Connected. Strava activity access and the deauthorization webhook are active.");
      } else if (status.webhook?.configured) {
        setMessage("#strava-message", "Connected. Register the webhook to receive Strava deauthorization events.");
      } else {
        setMessage("#strava-message", "Connected. Local Strava sync works; set up the optional public webhook from the guide.");
      }
    } else if (status.webhook?.revoked) {
      setMessage("#strava-message", "Strava access was revoked. Reconnect and approve access again.", true);
    }
  } catch (error) {
    setMessage("#strava-message", `Local service error: ${error.message}`, true);
  }
}

async function loadStravaActivities(reset = false) {
  if (reset) {
    state.stravaPage = 0;
    state.stravaActivities = [];
    state.activityGroups = [];
    state.hasMoreActivities = true;
  }
  if (!state.hasMoreActivities) return;
  $("#refresh-strava").disabled = true;
  $("#load-older").disabled = true;
  setMessage("#strava-message", reset ? "Fetching your recent Strava rides…" : "Fetching older Strava rides…");
  try {
    const page = state.stravaPage + 1;
    const result = await api(`/api/strava/activities?page=${page}`);
    const entries = result.activities.map((activity) => {
      const points = decodePolyline(activity.summary_polyline);
      return {
        activity,
        shape: points.length > 1 ? resampleCoordinates(points) : null,
      };
    }).filter((entry) => entry.shape);
    state.stravaActivities.push(...entries);
    state.stravaPage = page;
    state.hasMoreActivities = result.activities.length === 50;
    const groups = [];
    for (const entry of state.stravaActivities) {
      const group = groups.find((candidate) => routeSimilarity(candidate.entries[0], entry));
      if (group) group.entries.push(entry);
      else groups.push({ entries: [entry] });
    }
    groups.sort((a, b) => b.entries.length - a.entries.length || b.entries[0].activity.start_date.localeCompare(a.entries[0].activity.start_date));
    state.activityGroups = groups;
    renderActivityGroups();
    setMessage("#strava-message", `Loaded ${state.stravaActivities.length} rides · grouped ${state.stravaActivities.length} with GPS routes into ${groups.length} route${groups.length === 1 ? "" : "s"}.`);
  } catch (error) {
    setMessage("#strava-message", error.message, true);
  } finally {
    $("#refresh-strava").disabled = !state.stravaConnected;
    $("#load-older").disabled = !state.stravaConnected || !state.hasMoreActivities;
  }
}

function renderActivityGroups() {
  const container = $("#activity-groups");
  if (!state.activityGroups.length) {
    container.innerHTML = `<div class="empty-note">No Strava rides with route geometry were found.</div>`;
    return;
  }
  container.innerHTML = state.activityGroups.map((group, groupIndex) => {
    const representative = group.entries[0].activity;
    return `<div class="activity-group">
      <div class="activity-group-head">
        <strong>ROUTE ${String(groupIndex + 1).padStart(2, "0")} · ${escapeHtml(representative.name)}</strong>
        <span>${group.entries.length} RIDE${group.entries.length === 1 ? "" : "S"} · ${formatDistance(representative.distance_m)} KM</span>
      </div>
      ${group.entries.map(({ activity }) => `
        <div class="activity-item">
          <div>
            <span class="activity-item-name">${escapeHtml(activity.name)}</span>
            <span class="activity-item-meta">${formatDate(activity.start_date)} · ${formatDuration(activity.moving_time_s)} · ${Math.round(activity.elevation_gain_m || 0)} M UP</span>
          </div>
          <button class="mini-button" data-route="${activity.id}">RIDE ROUTE</button>
          <button class="mini-button add-ghost" data-ghost="${activity.id}">ADD GHOST</button>
        </div>`).join("")}
    </div>`;
  }).join("");
  container.querySelectorAll("[data-route]").forEach((button) => {
    button.addEventListener("click", () => loadStravaRoute(button.dataset.route));
  });
  container.querySelectorAll("[data-ghost]").forEach((button) => {
    button.addEventListener("click", () => addStravaGhost(button.dataset.ghost));
  });
}

function findActivity(id) {
  for (const group of state.activityGroups) {
    const match = group.entries.find((entry) => String(entry.activity.id) === String(id));
    if (match) return match.activity;
  }
  return null;
}

async function getStravaStreams(activity) {
  const result = await api(`/api/strava/streams/${activity.id}`);
  return makeRouteFromStreams(activity, result);
}

async function loadStravaRoute(id) {
  const activity = findActivity(id);
  if (!activity) return;
  setMessage("#strava-message", `Loading route data for “${activity.name}”…`);
  try {
    state.route = await getStravaStreams(activity);
    state.routeDistanceM = 0;
    state.ghosts = [];
    setMessage("#strava-message", `Loaded ${activity.name}. Other versions of this route can be added as ghosts.`);
    renderRoute();
  } catch (error) {
    setMessage("#strava-message", error.message, true);
  }
}

async function addStravaGhost(id) {
  const activity = findActivity(id);
  if (!activity) return;
  if (state.ghosts.some((ghost) => String(ghost.id) === String(activity.id))) {
    setMessage("#strava-message", "That ride is already shown as a ghost.");
    return;
  }
  setMessage("#strava-message", `Loading ghost “${activity.name}”…`);
  try {
    const route = await getStravaStreams(activity);
    const timeBase = route.points.find((point) => Number.isFinite(point.time))?.time ?? 0;
    const points = route.points.map((point) => ({
      lat: point.lat,
      lon: point.lon,
      time_s: Number.isFinite(point.time) ? point.time - timeBase : point.distance_m / Math.max(activity.average_speed_mps, 1),
    }));
    state.ghosts.push({ id: activity.id, name: activity.name, points });
    renderMap();
    setMessage("#strava-message", `Added ${activity.name} as a ghost. Its position follows the elapsed time of the original activity.`);
  } catch (error) {
    setMessage("#strava-message", error.message, true);
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

async function loadRideHistory() {
  try {
    const result = await api("/api/rides");
    const container = $("#ride-history");
    if (!result.rides.length) {
      container.innerHTML = `<div class="empty-note">No recorded rides yet.</div>`;
      return;
    }
    container.innerHTML = result.rides.map((ride) => `
      <div class="ride-entry">
        <div><strong>${escapeHtml(ride.title)}</strong><span>${formatDate(ride.created_at)} · ${formatDuration(ride.duration_s)}</span></div>
        <b>${formatDistance(ride.distance_m)} KM</b>
      </div>`).join("");
  } catch (error) {
    $("#ride-history").innerHTML = `<div class="empty-note">${escapeHtml(error.message)}</div>`;
  }
}

async function disconnectStrava() {
  try {
    await api("/api/strava/disconnect", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    state.stravaConnected = false;
    state.stravaPage = 0;
    state.stravaActivities = [];
    state.hasMoreActivities = true;
    state.activityGroups = [];
    state.ghosts = [];
    await loadStatus();
    renderActivityGroups();
    renderMap();
    setMessage("#strava-message", "Strava disconnected. You can revoke app access in Strava settings as well.");
  } catch (error) {
    setMessage("#strava-message", error.message, true);
  }
}

async function registerWebhook() {
  setMessage("#strava-message", "Registering the Strava webhook…");
  try {
    const result = await api("/api/strava/webhook/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    await loadStatus();
    setMessage("#strava-message", `Strava webhook registered (subscription ${result.subscription_id}).`);
  } catch (error) {
    setMessage("#strava-message", error.message, true);
  }
}

function saveSettings() {
  const weight = Number($("#rider-weight").value);
  if (weight && weight >= 35 && weight <= 200) localStorage.setItem("riderWeightKg", String(weight));
  else localStorage.removeItem("riderWeightKg");
  localStorage.setItem("autoUpload", $("#auto-upload").checked ? "true" : "false");
}

function bindEvents() {
  $("#gpx-file").addEventListener("change", (event) => importGpx(event.target.files[0]));
  $("#connect-trainer").addEventListener("click", connectTrainer);
  $("#enable-control").addEventListener("click", enableTrainerControl);
  $("#disconnect-trainer").addEventListener("click", disconnectTrainer);
  $("#start-ride").addEventListener("click", startRide);
  $("#pause-ride").addEventListener("click", () => state.ride?.paused ? resumeRide() : pauseRide());
  $("#finish-ride").addEventListener("click", () => finishRide(true));
  $("#connect-strava").addEventListener("click", () => { window.location.href = "/api/strava/connect"; });
  $("#refresh-strava").addEventListener("click", () => loadStravaActivities(true));
  $("#load-older").addEventListener("click", () => loadStravaActivities(false));
  $("#disconnect-strava").addEventListener("click", disconnectStrava);
  $("#register-webhook").addEventListener("click", registerWebhook);
  $("#auto-upload").addEventListener("change", saveSettings);
  $("#rider-weight").addEventListener("change", saveSettings);
}

function restoreSettings() {
  const weight = localStorage.getItem("riderWeightKg");
  if (weight) $("#rider-weight").value = weight;
  $("#auto-upload").checked = localStorage.getItem("autoUpload") !== "false";
}

bindEvents();
restoreSettings();
renderMetrics();
renderRoute();
loadStatus();
loadRideHistory();
