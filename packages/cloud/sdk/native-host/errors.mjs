export class NativeCloudServiceError extends Error {
  constructor(message, { status = 500, code } = {}) {
    super(message);
    this.name = "NativeCloudServiceError";
    this.status = status;
    this.code = code;
  }
}
