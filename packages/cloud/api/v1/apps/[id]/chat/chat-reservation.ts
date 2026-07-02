/**
 * App-chat credit-reservation sizing (#10924).
 *
 * The app-chat route reserves credit up front, then forwards the caller's
 * `max_tokens` to the provider. Reserving a FIXED estimate while the provider is
 * allowed to generate up to `max_tokens` lets a low-balance caller consume far
 * more inference than was reserved — and the all-or-nothing reconcile leaves the
 * platform absorbing the shortfall. So the reservation must size to the caller's
 * output ceiling, not a constant.
 */

export const DEFAULT_ESTIMATED_OUTPUT_TOKENS = 500;

/**
 * Overflow / pathological-input guard. Real models cap their own output well
 * below this, so reserving up to this bound always covers the provider's actual
 * output even when a caller passes an absurd `max_tokens`.
 */
export const MAX_RESERVATION_OUTPUT_TOKENS = 128_000;

/**
 * Output tokens to RESERVE credit for. Reserve for the caller's requested
 * `max_tokens` ceiling (never below the default estimate, bounded above to guard
 * pathological values); an absent/invalid value falls back to the default.
 */
export function reservationOutputTokens(
  maxTokens: number | null | undefined,
): number {
  const requested = Number(maxTokens);
  if (!Number.isFinite(requested) || requested <= 0) {
    return DEFAULT_ESTIMATED_OUTPUT_TOKENS;
  }
  return Math.min(
    Math.max(requested, DEFAULT_ESTIMATED_OUTPUT_TOKENS),
    MAX_RESERVATION_OUTPUT_TOKENS,
  );
}
