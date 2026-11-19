import type { Hass } from './types';
import type { RawPoint } from './track';

/** compressed format of the history/history_during_period websocket command */
interface CompressedState {
  s: string;
  a?: Record<string, any>;
  /** last_updated (s) — only present when it differs from lc */
  lu?: number;
  /** last_changed (s) */
  lc?: number;
}

export function pointFromAttributes(a: Record<string, any> | undefined, t: number): RawPoint | null {
  if (!a || a.latitude == null || a.longitude == null) return null;
  const lat = Number(a.latitude);
  const lng = Number(a.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const acc = a.gps_accuracy != null ? Number(a.gps_accuracy) : undefined;
  return { lat, lng, t, acc: Number.isFinite(acc) ? acc : undefined };
}

export async function fetchHistory(
  hass: Hass,
  entityIds: string[],
  start: Date,
  end = new Date(),
): Promise<Record<string, RawPoint[]>> {
  const res = await hass.callWS<Record<string, CompressedState[]>>({
    type: 'history/history_during_period',
    start_time: start.toISOString(),
    end_time: end.toISOString(),
    entity_ids: entityIds,
    include_start_time_state: true,
    // the position only changes in attributes, so every change is needed
    significant_changes_only: false,
    minimal_response: false,
    no_attributes: false,
  });

  const out: Record<string, RawPoint[]> = {};
  for (const id of entityIds) {
    const points: RawPoint[] = [];
    let attrs: Record<string, any> | undefined;
    for (const st of res[id] ?? []) {
      if (st.a) attrs = st.a;
      const p = pointFromAttributes(attrs, (st.lu ?? st.lc ?? 0) * 1000);
      if (p) points.push(p);
    }
    out[id] = points;
  }
  return out;
}
