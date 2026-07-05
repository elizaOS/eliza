/** How long a /api/plugins request waits for the lazy plugin-registry module
 * before answering 503 (the import keeps loading; retries land once warm). */
export const PLUGIN_REGISTRY_LOAD_DEADLINE_MS = 2_000;

/** Resolve `promise` or null after `ms` - never rejects from the timer side. */
export async function resolveWithinDeadline<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
