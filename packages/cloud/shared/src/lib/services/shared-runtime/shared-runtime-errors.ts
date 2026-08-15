/**
 * Dependency-free error types shared by the shared-runtime chat core, its
 * conversation coordinator, and the Durable Object transport. Kept
 * import-light deliberately: the coordinator and route boundaries need real
 * class identity for these errors without dragging the billing/runtime module
 * graph into their own graphs (several catch sites additionally match on
 * `error.name` because the class cannot survive the Durable Object fetch
 * boundary).
 */
export class SharedRuntimeCacheWarmingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SharedRuntimeCacheWarmingError";
  }
}

/**
 * A `clientMessageId` was reused with a different payload (#18045). The prior
 * turn's transcript pair must never be silently replaced, so the submission is
 * rejected rather than executed. Non-retryable by contract: the caller must
 * pick a new id for new content.
 */
export class SharedTurnConflictError extends Error {
  constructor(message = "clientMessageId was already used with a different message.") {
    super(message);
    this.name = "SharedTurnConflictError";
  }
}
