// GPS cleanup and stop detection. Pure functions, no dependency on HA or Google.

export interface RawPoint {
  lat: number;
  lng: number;
  /** epoch in ms */
  t: number;
  /** gps_accuracy in meters */
  acc?: number;
}

export interface Stop {
  lat: number;
  lng: number;
  start: number;
  end: number;
  /** still stopped here (last known position) */
  ongoing: boolean;
}

export interface Track {
  /** path to draw; each stop collapses into two points (arrival and departure) */
  path: RawPoint[];
  stops: Stop[];
}

export interface TrackOptions {
  /** drops points with gps_accuracy above this (m) */
  maxAccuracy: number;
  /** radius considered the "same place" (m) */
  stopRadius: number;
  /** minimum time to count as a stop (min) */
  stopMinutes: number;
  /** speeds above this (m/s) mean a GPS jump */
  maxSpeed?: number;
  now?: number;
}

type LatLng = { lat: number; lng: number };

const EARTH = 6371000;
const RAD = Math.PI / 180;
/** speed assumed when estimating when a stop ended (m/s) */
const DEPART_SPEED = 10;

export function distance(a: LatLng, b: LatLng): number {
  const dLat = (b.lat - a.lat) * RAD;
  const dLng = (b.lng - a.lng) * RAD;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH * Math.asin(Math.min(1, Math.sqrt(h)));
}

function speed(a: RawPoint, b: RawPoint): number {
  const dt = Math.abs(b.t - a.t) / 1000;
  return dt === 0 ? Infinity : distance(a, b) / dt;
}

/** Sorts and removes inaccurate points, duplicates and "spikes" (a GPS jump that goes and comes back). */
export function cleanPoints(points: RawPoint[], maxAccuracy: number, maxSpeed = 70): RawPoint[] {
  const sorted = points
    .filter((p) => p.acc === undefined || p.acc <= maxAccuracy)
    .sort((a, b) => a.t - b.t);

  const dedup: RawPoint[] = [];
  for (const p of sorted) {
    const prev = dedup[dedup.length - 1];
    if (prev && ((prev.lat === p.lat && prev.lng === p.lng) || prev.t === p.t)) continue;
    dedup.push(p);
  }

  const out: RawPoint[] = [];
  for (let i = 0; i < dedup.length; i++) {
    const prev = out[out.length - 1];
    const cur = dedup[i];
    const next = dedup[i + 1];
    if (prev && next && speed(prev, cur) > maxSpeed && speed(cur, next) > maxSpeed) continue;
    out.push(cur);
  }
  return out;
}

type Segment =
  | { kind: 'stop'; lat: number; lng: number; start: number; end: number; ongoing: boolean; n: number }
  | { kind: 'move'; points: RawPoint[] };

export function buildTrack(raw: RawPoint[], opts: TrackOptions): Track {
  const pts = cleanPoints(raw, opts.maxAccuracy, opts.maxSpeed);
  const now = opts.now ?? Date.now();
  const minStay = opts.stopMinutes * 60_000;
  const segments: Segment[] = [];

  const pushMove = (p: RawPoint) => {
    const last = segments[segments.length - 1];
    if (last?.kind === 'move') last.points.push(p);
    else segments.push({ kind: 'move', points: [p] });
  };

  let i = 0;
  while (i < pts.length) {
    // grow a cluster from i while points stay close to its centroid
    let lat = pts[i].lat;
    let lng = pts[i].lng;
    let j = i + 1;
    // with few points the centroid is still far from the real center: allow more slack at first
    while (j < pts.length && distance({ lat, lng }, pts[j]) <= opts.stopRadius * (1 + 1 / (j - i))) {
      const n = j - i + 1;
      lat += (pts[j].lat - lat) / n;
      lng += (pts[j].lng - lng) / n;
      j++;
    }
    const start = pts[i].t;
    const last = pts[j - 1];
    const next = pts[j];
    // The app only reports when it moves: the person stayed until shortly before the next point,
    // minus the time needed to travel there.
    const end = next
      ? Math.max(last.t, next.t - distance({ lat, lng }, next) / DEPART_SPEED * 1000)
      : Math.max(last.t, now);

    if (end - start >= minStay) {
      segments.push({ kind: 'stop', lat, lng, start, end, ongoing: !next, n: j - i });
      i = j;
    } else {
      pushMove(pts[i]);
      i++;
    }
  }

  // merge stops at the same place separated by 1–2 noise points
  const merged: Segment[] = [];
  for (const seg of segments) {
    if (seg.kind === 'stop') {
      let k = merged.length - 1;
      const gap = merged[k];
      const smallGap = gap?.kind === 'move' && gap.points.length <= 2;
      if (smallGap) k--;
      const prev = merged[k];
      if (prev?.kind === 'stop' && distance(prev, seg) <= opts.stopRadius * 2) {
        const n = prev.n + seg.n;
        prev.lat = (prev.lat * prev.n + seg.lat * seg.n) / n;
        prev.lng = (prev.lng * prev.n + seg.lng * seg.n) / n;
        prev.n = n;
        prev.end = seg.end;
        prev.ongoing = seg.ongoing;
        if (smallGap) merged.splice(k + 1, 1);
        continue;
      }
    }
    merged.push(seg);
  }

  const path: RawPoint[] = [];
  const stops: Stop[] = [];
  for (const seg of merged) {
    if (seg.kind === 'stop') {
      stops.push({ lat: seg.lat, lng: seg.lng, start: seg.start, end: seg.end, ongoing: seg.ongoing });
      path.push({ lat: seg.lat, lng: seg.lng, t: seg.start }, { lat: seg.lat, lng: seg.lng, t: seg.end });
    } else {
      path.push(...seg.points);
    }
  }
  return { path, stops };
}
