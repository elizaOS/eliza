/**
 * HTTP reachability probe for the DEPLOY_APP completion gate.
 *
 * After the deploy status flips to READY we still don't claim an app is "live"
 * until its public endpoint actually answers. {@link probeReachable} does a
 * bounded HTTP GET (default `/health`) and reports whether it returned 2xx.
 *
 * The network boundary (`fetchImpl`) is injectable so the deploy gate's unit
 * tests can drive reachable / unreachable / timeout without a live container —
 * production passes the global `fetch`.
 */

export interface ReachabilityResult {
  /** True iff the endpoint answered with a 2xx status. */
  ok: boolean;
  /** The HTTP status code, when a response was received. */
  status?: number;
  /** A short reason when the probe failed (network error / abort / no-fetch). */
  error?: string;
}

/** Minimal fetch surface the probe needs — satisfied by the global `fetch`. */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    signal?: AbortSignal;
    redirect?: "follow" | "manual";
  },
) => Promise<{ ok: boolean; status: number }>;

export interface ProbeOptions {
  /** Abort the probe after this many ms (default 10s). */
  timeoutMs?: number;
  /** Injected fetch (defaults to the global `fetch`). */
  fetchImpl?: FetchLike;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/** Append `/health` (or another path) to a base URL, collapsing slashes. */
export function healthUrl(base: string, path = "/health"): string {
  const trimmedBase = base.replace(/\/+$/, "");
  const trimmedPath = path.startsWith("/") ? path : `/${path}`;
  return `${trimmedBase}${trimmedPath}`;
}

/**
 * Probe a URL with a bounded HTTP GET. Never throws — a network error, abort, or
 * non-2xx all resolve to `{ ok: false, … }` so the caller can report a clear
 * "deployed but not reachable" failure instead of crashing the action.
 */
export async function probeReachable(
  url: string,
  options: ProbeOptions = {},
): Promise<ReachabilityResult> {
  const fetchImpl =
    options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined);
  if (typeof fetchImpl !== "function") {
    return { ok: false, error: "no_fetch" };
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      signal: controller.signal,
      redirect: "follow",
    });
    const ok =
      res.ok === true ||
      (typeof res.status === "number" && res.status >= 200 && res.status < 300);
    return { ok, status: res.status };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}
