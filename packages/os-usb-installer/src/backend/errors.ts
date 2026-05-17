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

export class InvalidDiskNumberError extends Error {
  override readonly name = "InvalidDiskNumberError";
  constructor(
    message: string,
    public readonly value: number,
  ) {
    super(message);
  }
}

export class InvalidScriptPathError extends Error {
  override readonly name = "InvalidScriptPathError";
  constructor(
    message: string,
    public readonly value: string,
  ) {
    super(message);
  }
}

export class UserCancelledElevationError extends Error {
  override readonly name = "UserCancelledElevationError";
  constructor(message = "UAC elevation was cancelled by the user.") {
    super(message);
  }
}

export class WslDetectedError extends Error {
  override readonly name = "WslDetectedError";
  constructor(
    message = "Detected WSL — use the Linux installer or run from a real Windows shell.",
  ) {
    super(message);
  }
}

export class SystemDiskProtectedError extends Error {
  override readonly name = "SystemDiskProtectedError";
  constructor(
    message: string,
    public readonly diskNumber: number,
  ) {
    super(message);
  }
}

export class PowerShellExecutionError extends Error {
  override readonly name = "PowerShellExecutionError";
  constructor(
    message: string,
    public readonly exitCode: number | null,
    public readonly stderr: string,
  ) {
    super(message);
  }
}
