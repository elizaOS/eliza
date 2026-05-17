// Typed errors for the macOS USB installer backend.
//
// These exist so the UI can distinguish "user clicked Cancel" from "diskutil
// refused due to permissions" from "the plist we got back was garbage", instead
// of getting an opaque generic Error.

export class UserCancelledAuthError extends Error {
  override readonly name = "UserCancelledAuthError";
  constructor(message = "Authentication cancelled by user.") {
    super(message);
  }
}

export class DiskutilPermissionError extends Error {
  override readonly name = "DiskutilPermissionError";
  constructor(
    message: string,
    public readonly target: string,
  ) {
    super(message);
  }
}

export class PlistParseError extends Error {
  override readonly name = "PlistParseError";
  constructor(
    message: string,
    public readonly snippet: string,
  ) {
    super(message);
  }
}

export class InvalidDevicePathError extends Error {
  override readonly name = "InvalidDevicePathError";
  constructor(
    message: string,
    public readonly value: string,
  ) {
    super(message);
  }
}

export class InvalidImagePathError extends Error {
  override readonly name = "InvalidImagePathError";
  constructor(
    message: string,
    public readonly value: string,
  ) {
    super(message);
  }
}
