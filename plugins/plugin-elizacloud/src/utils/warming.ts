/**
 * Cold-cache warming detection for raw-`Response` cloud media calls (STT/TTS).
 *
 * On a box whose text brain runs elsewhere (e.g. Cerebras), the cloud's
 * per-model billing/auth admission cache goes cold between rare media calls;
 * the first call after idle answers 503 with a machine-readable warming body
 * that clears within ~1s on retry. The throw-shaped SDK calls already ride
 * through this (`retryMediaWarming` in models/media.ts, inline handlers in
 * models/image.ts — #18323/#18325/#18333; server escape #18249); this helper
 * is the companion for handlers that receive a raw `Response` and must peek
 * its body instead of a thrown error. A non-warming 503 (or any other status)
 * returns null so the caller fails fast.
 */

interface WarmingPeek {
  error?: { code?: unknown; type?: unknown; retryAfter?: unknown };
  code?: unknown;
  type?: unknown;
  retryAfter?: unknown;
}

/**
 * Returns the seconds to wait before retrying a warming 503, or null when the
 * response is not the gateway's explicit cache-warming shape. Reads a clone so
 * the caller's body remains consumable.
 */
export async function warmingRetryWaitSeconds(
  response: Response,
): Promise<number | null> {
  if (response.status !== 503) return null;
  try {
    const peek = (await response.clone().json()) as WarmingPeek;
    const code = String(peek?.error?.code ?? peek?.code ?? "");
    const type = String(peek?.error?.type ?? peek?.type ?? "");
    const warming =
      code.endsWith("_cache_warming") ||
      code === "service_unavailable" ||
      type === "service_unavailable";
    if (!warming) return null;
    const ra = peek?.error?.retryAfter ?? peek?.retryAfter;
    return typeof ra === "number" && Number.isFinite(ra) && ra > 0
      ? Math.min(ra, 3)
      : 1.5;
  } catch {
    // error-policy:J3 a non-JSON 503 body is an explicit "not warming"
    // verdict; the caller surfaces the original HTTP failure.
    return null;
  }
}
