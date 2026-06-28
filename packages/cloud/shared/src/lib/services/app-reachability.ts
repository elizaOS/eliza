/**
 * App public-URL reachability probe (Apps / Product 2, #9853).
 *
 * A deploy must NOT report success until the app's public URL actually answers
 * an HTTP request through the ingress. "Reachable" means the request COMPLETES
 * with a status the app/ingress itself produced — a 2xx/3xx, or an auth gate
 * (401/403) — and NOT:
 *   - a connection refused / DNS failure / TLS error / per-attempt timeout, or
 *   - a Caddy gateway error (502/503/504), which means the ingress is up but the
 *     upstream container isn't answering yet.
 * So a phantom-success deploy (container `running`, route registered, but the
 * app never serving) is caught and surfaced instead of reported as `deployed`.
 *
 * NODE-ONLY: runs in the provisioning daemon (the CONTAINER_PROVISION executor),
 * never the Worker deploy route. Uses global `fetch` + `AbortSignal.timeout` —
 * the same primitive the warm-pool health probe uses — so it adds no new HTTP
 * client.
 */

const DEFAULT_MAX_ATTEMPTS = 10;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 5_000;
const DEFAULT_RETRY_DELAY_MS = 3_000;

/**
 * Whether an HTTP status counts as "the app answered". The bad-gateway family
 * (502 Bad Gateway / 503 Service Unavailable / 504 Gateway Timeout) means the
 * ingress is up but the upstream app isn't serving yet, so it is NOT reachable.
 * Every other completed status — incl. 2xx/3xx and auth gates (401/403) — is.
 */
export function isReachableStatus(status: number): boolean {
  return status !== 502 && status !== 503 && status !== 504;
}

/** A single probe: true iff the URL completes a request with a non-gateway status. */
export async function probeUrlReachable(url: string, timeoutMs: number): Promise<boolean> {
  try {
    const response = await fetch(url, {
      method: "GET",
      // Don't chase redirects (avoid loops / external hops); a 3xx already
      // proves the app answered — `isReachableStatus` treats it as reachable.
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return isReachableStatus(response.status);
  } catch {
    // Connection refused, DNS/TLS failure, or the per-attempt timeout aborted.
    return false;
  }
}

export interface ReachabilityOptions {
  /** Total probe attempts before giving up. Default 10. */
  maxAttempts?: number;
  /** Per-attempt request timeout (ms) — bounds each probe. Default 5000. */
  attemptTimeoutMs?: number;
  /** Delay between attempts (ms). Default 3000. */
  retryDelayMs?: number;
}

/**
 * Poll `url` until it is HTTP-reachable or the bounded window is exhausted. The
 * window is `maxAttempts` probes, each capped at `attemptTimeoutMs`, with
 * `retryDelayMs` between them — so it can never hang. Returns false when the URL
 * never became reachable.
 */
export async function waitForUrlReachable(
  url: string,
  options: ReachabilityOptions = {},
): Promise<boolean> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const attemptTimeoutMs = options.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (await probeUrlReachable(url, attemptTimeoutMs)) return true;
    if (attempt < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
  return false;
}
