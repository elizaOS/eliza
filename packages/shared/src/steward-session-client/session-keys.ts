/** Canonical at-rest browser token key. */
export const STEWARD_TOKEN_KEY = "steward_session_token";

/** Non-secret durable quarantine for an unacknowledged native token write. */
export const STEWARD_PENDING_WRITE_KEY = "eliza:steward-token-pending-write";

/** Control-plane scope, independent of the scope attached to a minted token. */
export const STEWARD_ACTIVE_SCOPE_KEY = "steward_session_active_scope";
