/**
 * Dependency-free error types shared by the shared-runtime chat core, its
 * conversation coordinator, and the Durable Object transport. Kept
 * import-light deliberately: the coordinator and route boundaries need real
 * class identity for these errors without dragging the billing/runtime module
 * graph into their own graphs (several catch sites additionally match on
 * `error.name` because the class cannot survive the Durable Object fetch
 * boundary).
 */
import { ElizaError } from "@elizaos/core/protocol";

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

/**
 * A personal Shared turn reached the conversation while a Shared→Dedicated
 * cutover held it (#22934). Before commit the seal refuses new Shared turns;
 * after commit the conversation belongs to Dedicated. Neither case executed
 * the turn, so connector ingress must hold the message and retry it — the
 * retry re-resolves the route and reaches Dedicated once it is attested. The
 * turn is never dropped and, because the refusal precedes the Shared claim,
 * never runs in both runtimes.
 */
export class PersonalCutoverHoldError extends Error {
  readonly retryAfterSeconds: number;

  constructor(
    readonly committed: boolean,
    retryAfterSeconds = 1,
  ) {
    super(
      committed
        ? "This personal Eliza moved to Dedicated; retry to reach it."
        : "Dedicated cutover is finishing; retry this turn shortly.",
    );
    this.name = "PersonalCutoverHoldError";
    this.retryAfterSeconds = retryAfterSeconds;
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

export interface SharedRuntimeTurnFailureClassification {
  failureName: SharedRuntimeTurnFailureName;
  retryable: boolean;
  /** Numeric upstream status only; provider messages and payloads stay private. */
  providerStatus?: number;
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

export function classifySharedRuntimeTurnFailure(
  error: unknown,
): SharedRuntimeTurnFailureClassification {
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
    // The message pipeline normalizes a delivered failure to a terminal
    // outcome. The Shared adapter brands that outcome before throwing;
    // preserve its disposition instead of losing it because the original SDK
    // Error no longer survives on the normalized cause.
    if (current instanceof ElizaError && current.code === "SHARED_RUNTIME_MESSAGE_FAILED") {
      const kind = current.context?.failureKind;
      const transient = current.context?.transient;
      if (transient === true && (kind === "transient_failure" || kind === "rate_limited")) {
        return {
          failureName: "SharedRuntimeProviderUnavailableError",
          retryable: true,
        };
      }
      if (transient === false && kind === "no_provider") {
        return {
          failureName: "SharedRuntimeProviderConfigurationError",
          retryable: false,
        };
      }
      if (transient === false && (kind === "provider_issue" || kind === "insufficient_credits")) {
        return {
          failureName: "SharedRuntimeProviderRejectedError",
          retryable: false,
        };
      }
    }
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
            providerStatus: status,
          }
        : {
            failureName: "SharedRuntimeProviderRejectedError",
            retryable: false,
            providerStatus: status,
          };
    }
  }
  return {
    failureName: "SharedRuntimeUnknownError",
    retryable: false,
  };
}

/**
 * Preserve the qualified authorization/transient HTTP failures at core's
 * boundary without letting its provider-detail extractor see SDK payloads.
 * Other provider classes retain their existing behavior until qualified.
 */
export function projectQualifiedSharedProviderFailure(
  error: unknown,
): (ElizaError & { readonly statusCode: 401 | 503 }) | undefined {
  const { providerStatus } = classifySharedRuntimeTurnFailure(error);
  if (providerStatus !== 401 && providerStatus !== 503) return undefined;
  return Object.assign(
    new ElizaError(
      providerStatus === 503
        ? "Shared model provider temporarily unavailable (HTTP 503)."
        : "Shared model provider rejected the request (HTTP 401).",
      {
        code: "SHARED_RUNTIME_PROVIDER_CALL_FAILED",
        context: { providerStatus },
        severity: providerStatus === 503 ? "ephemeral" : "fatal",
      },
    ),
    { statusCode: providerStatus } as const,
  );
}

export interface SharedModelCompletionDiagnostic {
  operation: "generate" | "stream";
  textPresent: boolean;
  toolCount: number | null;
  finishClass: "stop" | "length" | "content-filter" | "tool-calls" | "error" | "other" | "unknown";
}

/** Project completion shape only; provider output and tool contents stay private. */
export function sharedModelCompletionDiagnostic(
  operation: "generate" | "stream",
  text: unknown,
  toolCount: number,
  finishReason: unknown,
): SharedModelCompletionDiagnostic {
  const finishClasses = new Set([
    "stop",
    "length",
    "content-filter",
    "tool-calls",
    "error",
    "other",
    "unknown",
  ]);
  return {
    operation,
    textPresent: typeof text === "string" && text.trim().length > 0,
    toolCount: Number.isSafeInteger(toolCount) && toolCount >= 0 ? Math.min(toolCount, 64) : null,
    finishClass:
      typeof finishReason === "string" && finishClasses.has(finishReason)
        ? (finishReason as SharedModelCompletionDiagnostic["finishClass"])
        : "unknown",
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
