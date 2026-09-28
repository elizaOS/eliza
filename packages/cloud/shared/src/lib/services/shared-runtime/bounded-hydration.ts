/**
 * Bounded joins of in-flight cache hydration on the Shared turn path.
 *
 * A cold first turn used to schedule authoritative hydration and fail at once
 * with the retryable warming 503, so the client paid a full retry cycle even
 * when hydration finished a few hundred milliseconds later. The turn now waits
 * for that same hydration up to a fixed bound; only hydration that is slower
 * than the bound (or that fails) still surfaces the retryable warming signal.
 */

/** Longest a Shared turn waits for one in-flight cache hydration. */
export const SHARED_TURN_HYDRATION_WAIT_MS = 4_000;

/**
 * Resolves true when `hydration` settles within `boundMs`, false on timeout.
 * Rejections resolve true: the caller re-reads the cache to decide.
 */
export async function hydrationSettledWithin(
  hydration: Promise<unknown>,
  boundMs: number = SHARED_TURN_HYDRATION_WAIT_MS,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), boundMs);
  });
  try {
    return await Promise.race([
      hydration.then(
        () => true,
        () => true,
      ),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
