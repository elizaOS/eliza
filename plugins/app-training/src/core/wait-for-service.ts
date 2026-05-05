/**
 * Poll a runtime's service registry until a named service becomes available,
 * or the timeout expires. Used by boot-time registrants that must wait until
 * a service (e.g. cron/Task scheduling) has registered.
 *
 * Callers stay loosely typed against `runtime.getService(name)` so app-training
 * does not need plugin-specific typings.
 */

interface RuntimeLike {
  getService: (name: string) => unknown;
}

export interface WaitForServiceOptions {
  /** Total time to wait before giving up (default: 10_000). */
  timeoutMs?: number;
  /** Polling interval (default: 250). */
  pollIntervalMs?: number;
}

/**
 * Resolves to the service instance once present, or `null` if the timeout
 * expires. Never throws — callers that need hard guarantees should handle
 * `null` explicitly.
 */
export async function waitForService<TService>(
  runtime: RuntimeLike,
  serviceName: string,
  options?: WaitForServiceOptions,
): Promise<TService | null> {
  const timeoutMs = options?.timeoutMs ?? 10_000;
  const pollIntervalMs = options?.pollIntervalMs ?? 250;
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const service = runtime.getService(serviceName);
    if (service) {
      return service as TService;
    }
    if (Date.now() >= deadline) {
      return null;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}
