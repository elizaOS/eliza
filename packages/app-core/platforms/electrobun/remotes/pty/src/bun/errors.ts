import type { PtyError, PtyErrorCode, PtySessionId } from "./protocol.ts";

export class PtyException extends Error {
  readonly code: PtyErrorCode;
  readonly sessionId?: PtySessionId;
  readonly details?: unknown;

  constructor(input: PtyError) {
    super(input.message);
    this.name = "PtyException";
    this.code = input.code;
    this.sessionId = input.sessionId;
    this.details = input.details;
  }
}

export function createPtyError(input: PtyError): PtyError {
  return {
    code: input.code,
    message: input.message,
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    ...(input.details === undefined ? {} : { details: input.details }),
  };
}

export function throwPtyError(input: PtyError): never {
  throw new PtyException(createPtyError(input));
}

export function isPtyError(value: unknown): value is PtyError {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.code === "string" && typeof record.message === "string";
}

export function serializePtyError(error: unknown): PtyError {
  if (error instanceof PtyException) {
    return createPtyError({
      code: error.code,
      message: error.message,
      sessionId: error.sessionId,
      details: error.details,
    });
  }
  if (isPtyError(error)) return createPtyError(error);
  if (error instanceof Error) {
    return createPtyError({
      code: "PTY_REQUEST_FAILED",
      message: error.message.length > 0 ? error.message : error.name,
    });
  }
  return createPtyError({
    code: "PTY_UNKNOWN",
    message: "Unknown Terminal Remote failure",
    details: typeof error === "string" ? error : undefined,
  });
}
