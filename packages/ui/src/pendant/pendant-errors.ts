/**
 * Typed pendant failure contracts for connection, permission, and ASR paths.
 *
 * UI surfaces keep rendering a human message, but recovery logic keys off these
 * stable codes instead of raw exception strings.
 */

export type PendantErrorCode =
  | "permission-denied"
  | "pendant-lost"
  | "reconnect-exhausted"
  | "asr-failed"
  | "connection"
  | "generic";

export type PendantRecoveryCategory =
  | "permission"
  | "reconnect"
  | "transcription"
  | "connection"
  | "generic";

export interface PendantTypedError {
  code: PendantErrorCode;
  category: PendantRecoveryCategory;
  message: string;
  recoverable: boolean;
}

export class PendantPermissionDeniedError extends Error {
  constructor(message = "Nearby Devices permission is off.") {
    super(message);
    this.name = "PendantPermissionDeniedError";
  }
}

/** Walk native `Error.cause` links without looping on malformed error objects. */
export function pendantErrorCauseChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  const seen = new Set<object>();
  let current: unknown = error;
  while (current !== undefined) {
    if (typeof current === "object" && current !== null) {
      if (seen.has(current)) break;
      seen.add(current);
    }
    chain.push(current);
    current = current instanceof Error ? current.cause : undefined;
  }
  return chain;
}

export function createPendantError(
  code: PendantErrorCode,
  detail?: string,
): PendantTypedError {
  switch (code) {
    case "permission-denied":
      return {
        code,
        category: "permission",
        message:
          "Nearby Devices permission is off. Eliza can't find the pendant until it is enabled.",
        recoverable: true,
      };
    case "pendant-lost":
      return {
        code,
        category: "reconnect",
        message:
          "Pendant connection was lost. Reconnecting while keeping this transcript session open.",
        recoverable: true,
      };
    case "reconnect-exhausted":
      return {
        code,
        category: "reconnect",
        message:
          "Pendant connection was lost and reconnect attempts were exhausted.",
        recoverable: true,
      };
    case "asr-failed":
      return {
        code,
        category: "transcription",
        message: "Could not transcribe this segment.",
        recoverable: true,
      };
    case "connection":
      return {
        code,
        category: "connection",
        message: detail
          ? `Pendant connection failed: ${detail}`
          : "Pendant connection failed.",
        recoverable: true,
      };
    case "generic":
      return {
        code,
        category: "generic",
        message: detail ?? "Pendant failed.",
        recoverable: true,
      };
  }
}

export function classifyPendantConnectionError(
  err: unknown,
): PendantTypedError {
  const chain = pendantErrorCauseChain(err);
  if (
    chain.some(
      (cause) =>
        cause instanceof PendantPermissionDeniedError ||
        (cause instanceof DOMException && cause.name === "NotAllowedError"),
    )
  ) {
    return createPendantError("permission-denied");
  }
  // Deepest Error in the chain carries the most specific message. Manual
  // reverse scan instead of Array#findLast: consumer packages type-check these
  // sources under lib targets older than es2023.
  let detail: string | undefined;
  for (let i = chain.length - 1; i >= 0; i--) {
    const cause = chain[i];
    if (cause instanceof Error) {
      detail = cause.message;
      break;
    }
  }
  return createPendantError("connection", detail);
}
