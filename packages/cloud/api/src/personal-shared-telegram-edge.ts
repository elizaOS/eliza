/** Resolves the fail-closed Personal Shared Telegram edge rollout gate across its legacy and protected cutover bindings. */

export interface PersonalSharedTelegramEdgeBindings {
  ENVIRONMENT?: string;
  PERSONAL_SHARED_TELEGRAM_EDGE_ENABLED?: string;
  PERSONAL_SHARED_TELEGRAM_EDGE_CUTOVER_ENABLED?: string;
}

/**
 * The replacement binding lets staging escape a stale plaintext name without
 * weakening the old default/production guard. Only an exact true opts in.
 */
export function isPersonalSharedTelegramEdgeEnabled(
  env: PersonalSharedTelegramEdgeBindings,
): boolean {
  return (
    env.PERSONAL_SHARED_TELEGRAM_EDGE_ENABLED === "true" ||
    (env.ENVIRONMENT === "staging" &&
      env.PERSONAL_SHARED_TELEGRAM_EDGE_CUTOVER_ENABLED === "true")
  );
}
