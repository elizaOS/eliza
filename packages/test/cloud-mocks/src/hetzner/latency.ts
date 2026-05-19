export interface LatencyEntry {
  p50: number;
  jitter: number;
}

export const LATENCY_TABLE: Record<string, LatencyEntry> = {
  "POST /servers": { p50: 220, jitter: 60 },
  "GET /servers": { p50: 90, jitter: 25 },
  "GET /servers/:id": { p50: 80, jitter: 20 },
  "DELETE /servers/:id": { p50: 180, jitter: 40 },
  "GET /actions/:id": { p50: 70, jitter: 20 },
  "POST /servers/:id/actions/:cmd": { p50: 160, jitter: 40 },
  "POST /volumes": { p50: 200, jitter: 50 },
  "POST /volumes/:id/actions/attach": { p50: 160, jitter: 40 },
  "DELETE /volumes/:id": { p50: 180, jitter: 40 },
};

const DEFAULT_ENTRY: LatencyEntry = { p50: 100, jitter: 30 };

/**
 * Inject latency for a given route key. When `MOCK_HETZNER_LATENCY=0`,
 * resolves immediately. Otherwise sleeps for `p50 + uniformJitter(±jitter)`
 * scaled by `multiplier` (default 1).
 */
export async function injectLatency(routeKey: string, multiplier = 1): Promise<void> {
  if (process.env.MOCK_HETZNER_LATENCY === "0") return;
  if (multiplier === 0) return;
  const entry = LATENCY_TABLE[routeKey] ?? DEFAULT_ENTRY;
  const jitterOffset = (Math.random() * 2 - 1) * entry.jitter;
  const delay = Math.max(0, Math.round((entry.p50 + jitterOffset) * multiplier));
  if (delay === 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, delay));
}
