import type { ModelRemoteError, ModelRemoteErrorCode } from "./protocol.ts";

export class ModelRemoteException extends Error {
  readonly code: ModelRemoteErrorCode;
  readonly modelId?: string;
  readonly path?: string;
  readonly status?: number;
  readonly details?: unknown;

  constructor(error: ModelRemoteError) {
    super(error.message);
    this.name = "ModelRemoteException";
    this.code = error.code;
    this.modelId = error.modelId;
    this.path = error.path;
    this.status = error.status;
    this.details = error.details;
  }

  toJSON(): ModelRemoteError {
    return createModelError({
      code: this.code,
      message: this.message,
      modelId: this.modelId,
      path: this.path,
      status: this.status,
      details: this.details,
    });
  }
}

export function createModelError(error: ModelRemoteError): ModelRemoteError {
  const payload: ModelRemoteError = {
    code: error.code,
    message: error.message,
  };
  if (error.modelId !== undefined) payload.modelId = error.modelId;
  if (error.path !== undefined) payload.path = error.path;
  if (error.status !== undefined) payload.status = error.status;
  if (error.details !== undefined) payload.details = error.details;
  return payload;
}

export function throwModelError(error: ModelRemoteError): never {
  throw new ModelRemoteException(createModelError(error));
}

export function isModelRemoteError(value: unknown): value is ModelRemoteError {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    typeof (value as { code?: unknown }).code === "string" &&
    "message" in value &&
    typeof (value as { message?: unknown }).message === "string"
  );
}

export function serializeError(error: unknown): ModelRemoteError {
  if (error instanceof ModelRemoteException) return error.toJSON();
  if (isModelRemoteError(error)) return createModelError(error);
  if (error instanceof Error) {
    return createModelError({
      code: "MODEL_UNKNOWN",
      message: error.message,
      details: error.stack,
    });
  }
  return createModelError({
    code: "MODEL_UNKNOWN",
    message: "Model Remote request failed.",
    details: error,
  });
}
