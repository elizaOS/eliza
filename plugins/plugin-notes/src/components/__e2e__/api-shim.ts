/** Minimal API error contract used by the browser-only Notes fixture. */
export class ApiError extends Error {
  readonly status?: number;
  readonly code?: string;
  readonly data?: unknown;

  constructor({
    status,
    code,
    message,
    data,
  }: {
    kind: "http" | "network" | "timeout" | "parse";
    path: string;
    status?: number;
    code?: string;
    message: string;
    data?: unknown;
  }) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}
