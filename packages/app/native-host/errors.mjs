/** Errors safe to expose across the restricted renderer bridge. */
export class NativeHostError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = "NativeHostError";
    this.status = status;
    this.code = code;
  }
}
