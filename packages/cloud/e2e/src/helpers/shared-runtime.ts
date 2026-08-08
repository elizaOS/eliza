/**
 * Client-side handling of the shared-runtime cache-warming contract.
 *
 * Every shared-tier route (`/bridge`, `/api/conversations/.../messages`) runs
 * `resolveSharedAgent` and the billing gate in `cacheOnly` mode: a cold cache
 * NEVER hydrates inline. It schedules authoritative hydration under
 * `executionCtx.waitUntil` and answers `503 { retryable: true }` with
 * `Retry-After: 1`. A freshly created shared agent therefore takes a handful of
 * requests to converge (scope → conversation → billing, one cache each).
 *
 * That is the product's documented client contract, not a flake: the shipped
 * bridge poller `packages/cloud/scripts/admin/hetzner-e2e/hetzner-e2e-healthcheck.ts`
 * retries on exactly this signal. Specs must honour it too, and ONLY it —
 * any other 503 (a provider failure, `inference_unavailable`, an unavailable
 * Worker binding) stays an immediate failure.
 */

export interface SharedRuntimeWarmingRetryOptions {
  /** Total attempts, including the first. */
  maxAttempts?: number;
  /** Delay between attempts; the routes advertise `Retry-After: 1`. */
  intervalMs?: number;
}

const DEFAULT_MAX_ATTEMPTS = 15;
const DEFAULT_INTERVAL_MS = 250;

/**
 * True only for the explicit retryable cache-warming envelope the shared-runtime
 * routes emit: `{ success: false, error, retryable: true }` under a 503.
 */
export function isSharedRuntimeWarming(status: number, body: unknown): boolean {
  if (status !== 503 || typeof body !== "object" || body === null) return false;
  return (body as { retryable?: unknown }).retryable === true;
}

/**
 * Re-issue `request` while it answers the retryable cache-warming 503. Returns
 * the first non-warming response (or the last warming one once the budget is
 * spent, so the caller's assertion reports the real status and body).
 */
export async function retrySharedRuntimeWarming<T>(
  request: () => Promise<{ status: number; json: T }>,
  options: SharedRuntimeWarmingRetryOptions = {},
): Promise<{ status: number; json: T }> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  let response = await request();
  for (let attempt = 1; attempt < maxAttempts; attempt += 1) {
    if (!isSharedRuntimeWarming(response.status, response.json))
      return response;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    response = await request();
  }
  return response;
}
