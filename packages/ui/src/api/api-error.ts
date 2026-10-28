/** Browser-safe typed transport errors shared by clients and embedded views. */
export type ApiErrorKind = "timeout" | "network" | "http" | "parse";
export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status?: number;
  readonly path: string;
  /** Application error code from the JSON body (e.g. "rate_limit_exceeded"). */
  readonly code?: string;
  /** Seconds until the caller should retry, from the JSON body or Retry-After header. */
  readonly retryAfter?: number;
  /**
   * The parsed JSON error body, when the response carried one. Structured
   * error surfaces (e.g. the credit-gate 402's `welcomeBonusWithheld` flag)
   * need more than the flattened `message`/`code`, and the direct-cloud
   * request path already exposes the body as `data` — this keeps the two
   * transports symmetric for classifiers that read either.
   */
  readonly data?: unknown;
  constructor(options: {
    kind: ApiErrorKind;
    path: string;
    message: string;
    status?: number;
    code?: string;
    retryAfter?: number;
    data?: unknown;
    cause?: unknown;
  }) {
    super(options.message);
    this.name = "ApiError";
    this.kind = options.kind;
    this.path = options.path;
    this.status = options.status;
    this.code = options.code;
    this.retryAfter = options.retryAfter;
    if (options.data !== undefined) {
      // Error objects are routinely logged/spread. Keep the parsed body
      // directly readable by structured consumers without serializing every
      // endpoint's potentially sensitive error fields by default.
      Object.defineProperty(this, "data", {
        value: options.data,
        enumerable: false,
        configurable: false,
        writable: false,
      });
    }
    if (options.cause !== undefined) {
      (
        this as Error & {
          cause?: unknown;
        }
      ).cause = options.cause;
    }
  }
}
export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}
export function isRateLimitedError(value: unknown): value is ApiError {
  return (
    value instanceof ApiError &&
    (value.status === 429 || value.code === "rate_limit_exceeded")
  );
}
