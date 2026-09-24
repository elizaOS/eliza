/**
 * Dependency-free error types shared by the shared-runtime chat core, its
 * conversation coordinator, and the Durable Object transport. Kept
 * import-light deliberately: the coordinator and route boundaries need real
 * class identity for these errors without dragging the billing/runtime module
 * graph into their own graphs (several catch sites additionally match on
 * `error.name` because the class cannot survive the Durable Object fetch
 * boundary).
 */
import { ElizaError } from "@elizaos/core";

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

export type SharedRuntimeTurnFailureName =
  | "SharedRuntimeActionContractError"
  | "SharedRuntimeNoReplyError"
  | "SharedRuntimeProviderConfigurationError"
  | "SharedRuntimeProviderRejectedError"
  | "SharedRuntimeProviderUnavailableError"
  | "SharedRuntimeTimeoutError"
  | "SharedRuntimeUnknownError";

const SHARED_RUNTIME_TURN_FAILURE_NAMES = new Set<SharedRuntimeTurnFailureName>([
  "SharedRuntimeActionContractError",
  "SharedRuntimeNoReplyError",
  "SharedRuntimeProviderConfigurationError",
  "SharedRuntimeProviderRejectedError",
  "SharedRuntimeProviderUnavailableError",
  "SharedRuntimeTimeoutError",
  "SharedRuntimeUnknownError",
]);

const SHARED_RUNTIME_TURN_RETRY_DISPOSITION: Record<SharedRuntimeTurnFailureName, boolean> = {
  SharedRuntimeActionContractError: false,
  SharedRuntimeNoReplyError: false,
  SharedRuntimeProviderConfigurationError: false,
  SharedRuntimeProviderRejectedError: false,
  SharedRuntimeProviderUnavailableError: true,
  SharedRuntimeTimeoutError: true,
  SharedRuntimeUnknownError: false,
};

interface SharedRuntimeTurnFailureClassification {
  failureName: SharedRuntimeTurnFailureName;
  retryable: boolean;
}

/** Validate the only failure names allowed to cross the coordinator boundary. */
export function parseSharedRuntimeTurnFailureName(
  value: unknown,
): SharedRuntimeTurnFailureName | null {
  return typeof value === "string" &&
    SHARED_RUNTIME_TURN_FAILURE_NAMES.has(value as SharedRuntimeTurnFailureName)
    ? (value as SharedRuntimeTurnFailureName)
    : null;
}

function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  const pending = [error];
  const seen = new Set<unknown>();
  while (pending.length > 0 && chain.length < 12) {
    const current = pending.shift();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    chain.push(current);
    if ((typeof current === "object" && current !== null) || typeof current === "function") {
      const candidate = current as {
        cause?: unknown;
        lastError?: unknown;
      };
      if (candidate.lastError !== undefined) pending.push(candidate.lastError);
      if (candidate.cause !== undefined) pending.push(candidate.cause);
    }
  }
  return chain;
}

function boundedProviderStatus(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 100 || value > 599) {
    return null;
  }
  return value;
}

function classifySharedRuntimeTurnFailure(error: unknown): SharedRuntimeTurnFailureClassification {
  const chain = errorChain(error);
  for (const current of chain) {
    if (!(current instanceof Error)) continue;
    if (
      /^Eliza Shared runtime completed an executable [A-Z_]+ request without an action result$/u.test(
        current.message,
      )
    ) {
      return {
        failureName: "SharedRuntimeActionContractError",
        retryable: false,
      };
    }
    if (current.message === "Eliza Shared runtime completed without a user-visible reply") {
      return {
        failureName: "SharedRuntimeNoReplyError",
        retryable: false,
      };
    }
  }
  for (const current of chain) {
    const record =
      (typeof current === "object" && current !== null) || typeof current === "function"
        ? (current as { name?: unknown; statusCode?: unknown })
        : null;
    if (!record) continue;
    const name = typeof record.name === "string" ? record.name : "";
    if (name === "ProviderConfigurationError") {
      return {
        failureName: "SharedRuntimeProviderConfigurationError",
        retryable: false,
      };
    }
    if (name === "TimeoutError" || name === "AbortError") {
      return {
        failureName: "SharedRuntimeTimeoutError",
        retryable: true,
      };
    }
    if (name === "RateLimitError") {
      return {
        failureName: "SharedRuntimeProviderUnavailableError",
        retryable: true,
      };
    }
    const status = boundedProviderStatus(record.statusCode);
    if (status !== null) {
      return status === 408 || status === 425 || status === 429 || status >= 500
        ? {
            failureName: "SharedRuntimeProviderUnavailableError",
            retryable: true,
          }
        : {
            failureName: "SharedRuntimeProviderRejectedError",
            retryable: false,
          };
    }
  }
  return {
    failureName: "SharedRuntimeUnknownError",
    retryable: false,
  };
}

/**
 * Adds turn identity while retaining a bounded failure class and disposition.
 * Raw provider/action messages remain only on `cause` inside the isolate.
 */
export class SharedRuntimeTurnError extends ElizaError {
  override readonly name = "SharedRuntimeTurnError";
  readonly failureName: SharedRuntimeTurnFailureName;
  readonly retryable: boolean;

  constructor(
    message: string,
    cause: unknown,
    classification?: SharedRuntimeTurnFailureClassification,
  ) {
    const resolved = classification ?? classifySharedRuntimeTurnFailure(cause);
    super(message, {
      code: "SHARED_RUNTIME_TURN_FAILED",
      context: {
        failureName: resolved.failureName,
        retryable: resolved.retryable,
      },
      cause,
      severity: resolved.retryable ? "ephemeral" : "fatal",
    });
    this.failureName = resolved.failureName;
    this.retryable = resolved.retryable;
  }

  /**
   * Rehydrate only sanitized, allowlisted metadata after a Durable Object
   * fetch. Invalid or inconsistent input fails closed as a terminal unknown
   * error instead of trusting transport-controlled classification.
   */
  static fromClassification(failureName: unknown, retryable: unknown): SharedRuntimeTurnError {
    const parsedName = parseSharedRuntimeTurnFailureName(failureName);
    const classificationIsConsistent =
      parsedName !== null &&
      typeof retryable === "boolean" &&
      SHARED_RUNTIME_TURN_RETRY_DISPOSITION[parsedName] === retryable;
    const safeClassification: SharedRuntimeTurnFailureClassification = classificationIsConsistent
      ? { failureName: parsedName, retryable }
      : {
          failureName: "SharedRuntimeUnknownError",
          retryable: false,
        };
    return new SharedRuntimeTurnError(
      "Shared runtime turn failed.",
      new Error("Sanitized shared runtime failure crossed the coordinator boundary."),
      safeClassification,
    );
  }
}
