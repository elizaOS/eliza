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

const globalFetchLike: FetchLike | undefined =
  typeof globalThis.fetch === "function"
    ? (input, init) => globalThis.fetch(input, init)
    : undefined;

/** Append `/health` (or another path) to a base URL, collapsing slashes. */
export function healthUrl(base: string, path = "/health"): string {
  const trimmedBase = base.replace(/\/+$/, "");
  const trimmedPath = path.startsWith("/") ? path : `/${path}`;
  return `${trimmedBase}${trimmedPath}`;
}

/**
 * Caddy gateway statuses: the ingress is up but the upstream app isn't serving.
 * Any OTHER completed status (200/3xx/401/403/404/…) means the app answered.
 */
const GATEWAY_DOWN_STATUSES = new Set([502, 503, 504]);

/**
 * Whether a probe result means the app ANSWERED — the SAME rule the server uses
 * to mark an app READY (`isReachableStatus`: reachable unless the status is a
 * Caddy gateway error 502/503/504). A 401/403 auth gate or a 404 still proves
 * the container is up and serving; a network error / abort (no status at all) is
 * NOT reachable. Using this instead of a strict-2xx check keeps the DEPLOY_APP
 * completion gate from contradicting the server's own live decision (an
 * auth-gated app, or one with no `/health` route, is live per the server but a
 * strict-2xx check would report "not live").
 */
export function respondedLive(result: ReachabilityResult): boolean {
  return (
    typeof result.status === "number" &&
    !GATEWAY_DOWN_STATUSES.has(result.status)
  );
}

/**
 * Probe a URL with a bounded HTTP GET. Never throws — a network error or abort
 * resolves to `{ ok: false }` with no `status`; any HTTP response resolves with
 * its `status` (and `ok` reflecting a strict 2xx). Redirects are NOT followed
 * (same as the server's probe): a 3xx surfaces as its own status, which
 * {@link respondedLive} counts as live. Callers that want the server's "the app
 * answered" rule should use {@link respondedLive}.
 */
export async function probeReachable(
  url: string,
  options: ProbeOptions = {},
): Promise<ReachabilityResult> {
  const fetchImpl = options.fetchImpl ?? globalFetchLike;
  if (typeof fetchImpl !== "function") {
    return { ok: false, error: "no_fetch" };
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // SSRF note: `url` is NOT user-controlled — the deploy gate derives it from
    // `app.production_url`, read back from the authenticated Cloud row via
    // `getApp` (Cloud-authoritative first-party origin), never from message text.
    // So a raw bounded GET is acceptable here without the core network SSRF guard.
    //
    // `redirect: "manual"` MIRRORS the server's authoritative probe
    // (`probeUrlReachable` in cloud-shared app-reachability): don't chase
    // redirects (avoid loops / external hops) — a 3xx already proves the app
    // answered, and `respondedLive` treats it as live. Following redirects here
    // let a redirecting `/health` land on a failing target and contradict the
    // server's READY with a false "not live".
    const res = await fetchImpl(url, {
      method: "GET",
      signal: controller.signal,
      redirect: "manual",
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
