/** Errors safe to expose across the restricted renderer bridge. */
export class NativeHostError extends Error {
  constructor(message, { status, code, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "NativeHostError";
    this.status = status;
    this.code = code;
  }
}

/**
 * A coded failure from host task code, for example a host `authorizeGoal`
 * that refuses a goal. The interactive task route answers its `code` (with
 * 409, or 503 for `TASK_STORAGE_*`) instead of `TASK_UNAVAILABLE`.
 *
 * Host modules are plain JavaScript and cannot import `ElizaError` from the
 * task runtime bundle. This class has the brand that `@elizaos/core` uses so
 * that `instanceof ElizaError` works across separately bundled copies.
 */
export class TaskHostError extends NativeHostError {
  constructor(message, { code, status } = {}) {
    if (typeof code !== "string" || !code)
      throw new TypeError("A task host error needs a code");
    super(message, { code, status });
    this.name = "TaskHostError";
  }
}
Object.defineProperty(
  TaskHostError.prototype,
  Symbol.for("elizaos.core.ElizaError"),
  { value: true },
);
