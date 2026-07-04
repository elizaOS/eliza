/** Implements Electrobun file-system remote errors ts boundaries for desktop app-core. */
import type { FileRemoteError, FileRemoteErrorCode } from "./protocol.ts";

export class FileRemoteException extends Error {
  readonly code: FileRemoteErrorCode;
  readonly path?: string;
  readonly details?: unknown;

  constructor(input: FileRemoteError) {
    super(input.message);
    this.name = "FileRemoteException";
    this.code = input.code;
    this.path = input.path;
    this.details = input.details;
  }
}

export function createFileRemoteError(input: FileRemoteError): FileRemoteError {
  return {
    code: input.code,
    message: input.message,
    ...(input.path === undefined ? {} : { path: input.path }),
    ...(input.details === undefined ? {} : { details: input.details }),
  };
}

export function throwFileRemoteError(input: FileRemoteError): never {
  throw new FileRemoteException(createFileRemoteError(input));
}

export function isFileRemoteError(value: unknown): value is FileRemoteError {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.code === "string" && typeof record.message === "string";
}

export function serializeFileError(error: unknown): FileRemoteError {
  if (error instanceof FileRemoteException) {
    return createFileRemoteError({
      code: error.code,
      message: error.message,
      path: error.path,
      details: error.details,
    });
  }
  if (isFileRemoteError(error)) return createFileRemoteError(error);
  if (error instanceof Error) {
    return createFileRemoteError({
      code: "FS_REQUEST_FAILED",
      message: error.message.length > 0 ? error.message : error.name,
    });
  }
  return createFileRemoteError({
    code: "FS_UNKNOWN",
    message: "Unknown File Remote failure",
    details: typeof error === "string" ? error : undefined,
  });
}
