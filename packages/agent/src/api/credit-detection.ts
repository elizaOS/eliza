/**
 * Credit/quota exhaustion and rate-limit detection for provider errors — the
 * agent API's import surface over the canonical classifiers in
 * `@elizaos/core` (`services/message/fallback-reply.ts`), so the direct chat
 * path and the connector failure-reply path classify with the same logic.
 *
 * Callers MUST check {@link isInsufficientCreditsError} first — a 429 *with*
 * billing context is credit exhaustion ("top up"), whereas a bare 429 is
 * "try again in a moment".
 */

export {
  isInsufficientCreditsError,
  isInsufficientCreditsMessage,
  isRateLimitError,
} from "@elizaos/core";
