/** Resolves the fail-closed Personal Shared Telegram edge rollout gate across its legacy and protected cutover bindings. */

export interface PersonalSharedTelegramEdgeBindings {
  ENVIRONMENT?: string;
  PERSONAL_SHARED_TELEGRAM_EDGE_ENABLED?: string;
  PERSONAL_SHARED_TELEGRAM_EDGE_CUTOVER_ENABLED?: string;
  PERSONAL_SHARED_TELEGRAM_EDGE_CUTOVER_PRODUCTION_ENABLED?: string;
}

/**
 * The replacement bindings let each environment escape a stale plaintext name
 * without weakening the old default guard. Every cutover secret is fresh and
 * environment-pinned — staging and production names never cross-activate, so a
 * copied binding in the wrong environment stays inert. Only an exact true
 * opts in.
 */
export function isPersonalSharedTelegramEdgeEnabled(
  env: PersonalSharedTelegramEdgeBindings,
): boolean {
  return (
    env.PERSONAL_SHARED_TELEGRAM_EDGE_ENABLED === "true" ||
    (env.ENVIRONMENT === "staging" &&
      env.PERSONAL_SHARED_TELEGRAM_EDGE_CUTOVER_ENABLED === "true") ||
    (env.ENVIRONMENT === "production" &&
      env.PERSONAL_SHARED_TELEGRAM_EDGE_CUTOVER_PRODUCTION_ENABLED === "true")
  );
}
