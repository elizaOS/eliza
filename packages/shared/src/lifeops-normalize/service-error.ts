/**
 * Canonical LifeOps service error (runtime-level primitive).
 *
 * A status-carrying Error thrown by the LifeOps normalize/validation
 * primitives. Self-contained; no DB, no plugin imports. Consumed by
 * `@elizaos/plugin-personal-assistant`, which keeps a re-export at
 * `lifeops/service-types.ts` for historical import paths.
 */

export class LifeOpsServiceError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "LifeOpsServiceError";
  }
}

export function isLifeOpsServiceError(
  error: unknown,
): error is LifeOpsServiceError {
  return (
    error instanceof LifeOpsServiceError ||
    (error instanceof Error &&
      error.name === "LifeOpsServiceError" &&
      typeof (error as unknown as { status: unknown }).status === "number")
  );
}

export function toLifeOpsServiceError(
  error: unknown,
  fallbackStatus = 500,
): LifeOpsServiceError {
  if (isLifeOpsServiceError(error)) return error;
  if (error instanceof Error) {
    return new LifeOpsServiceError(fallbackStatus, error.message);
  }
  if (typeof error === "string") {
    return new LifeOpsServiceError(fallbackStatus, error);
  }
  return new LifeOpsServiceError(fallbackStatus, "An unknown error occurred");
}
