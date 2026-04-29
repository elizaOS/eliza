/**
 * probe-local-agent.ts
 *
 * Liveness probe for an on-device Eliza agent listening on loopback.
 *
 * Phase E of the local-agent-on-Android effort gates the "Local Agent" tile
 * in `RuntimeGate` behind a real check that the agent's `/api/health`
 * endpoint is reachable and reports `{ ok: true }`. Without this, a user on
 * Android with no native agent installed would see a tile that does nothing.
 *
 * Result is cached for `PROBE_CACHE_TTL_MS` so repeated renders during the
 * onboarding flow do not hammer loopback. The cache is keyed by URL.
 *
 * `clearLocalAgentProbeCache()` resets the cache between tests.
 */

export const DEFAULT_LOCAL_AGENT_HEALTH_URL =
  "http://127.0.0.1:31337/api/health";

const PROBE_CACHE_TTL_MS = 30_000;

interface CacheEntry {
  result: boolean;
  expiresAt: number;
}

const resultCache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<boolean>>();

/** Reset the probe cache. Test-only. */
export function clearLocalAgentProbeCache(): void {
  resultCache.clear();
  inflight.clear();
}

export interface LocalOptionGate {
  isDesktop: boolean;
  isDev: boolean;
  isAndroid: boolean;
}

/**
 * Whether the "Local Agent" tile should appear on the onboarding chooser.
 *
 * - Desktop and dev builds always show it (they manage the runtime themselves).
 * - On Android the tile only appears when the on-device agent is actually
 *   responding on `127.0.0.1:31337` — there is no point showing an option
 *   that would immediately fail.
 * - Other platforms (iOS, plain web) do not host a local agent.
 */
export async function shouldShowLocalOption(
  gate: LocalOptionGate,
): Promise<boolean> {
  if (gate.isDesktop || gate.isDev) return true;
  if (!gate.isAndroid) return false;
  return probeLocalAgent();
}

async function runProbe(url: string, timeoutMs: number): Promise<boolean> {
  if (typeof fetch !== "function") return false;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) return false;

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return false;
  }

  return (
    typeof body === "object" &&
    body !== null &&
    (body as { ok?: unknown }).ok === true
  );
}

/**
 * Probes a local agent's `/api/health` endpoint with a timeout.
 *
 * Returns `true` only when the response is HTTP 200 and the JSON body
 * contains `{ ok: true }`. Any other outcome (timeout, network error,
 * non-200, non-JSON, missing field) returns `false`.
 *
 * Results are memoized per URL for 30 seconds.
 */
export async function probeLocalAgent(
  timeoutMs = 1500,
  url: string = DEFAULT_LOCAL_AGENT_HEALTH_URL,
): Promise<boolean> {
  const now = Date.now();
  const cached = resultCache.get(url);
  if (cached && cached.expiresAt > now) {
    return cached.result;
  }

  const existing = inflight.get(url);
  if (existing) return existing;

  const promise = runProbe(url, timeoutMs)
    .then((result) => {
      resultCache.set(url, {
        result,
        expiresAt: Date.now() + PROBE_CACHE_TTL_MS,
      });
      return result;
    })
    .finally(() => {
      inflight.delete(url);
    });

  inflight.set(url, promise);
  return promise;
}
