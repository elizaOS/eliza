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

// Linux backend errors.
export class LsblkParseError extends Error {
  override readonly name = "LsblkParseError";
  public readonly stdoutSnippet: string;
  constructor(stdoutSnippet: string, cause?: Error) {
    const causeMsg = cause ? `: ${cause.message}` : "";
    super(`Failed to parse lsblk output${causeMsg}`);
    this.stdoutSnippet = stdoutSnippet.slice(0, 500);
    if (cause) this.cause = cause;
  }
}

export class NoPrivilegeEscalatorError extends Error {
  override readonly name = "NoPrivilegeEscalatorError";
  constructor(
    message = "No privilege escalator found (tried pkexec, kdesu, doas, sudo). Install one and retry.",
  ) {
    super(message);
  }
}

export class UnmountFailedError extends Error {
  override readonly name = "UnmountFailedError";
  public readonly devicePath: string;
  public readonly stderr: string;
  constructor(devicePath: string, stderr: string) {
    super(`Failed to unmount ${devicePath}: ${stderr}`);
    this.devicePath = devicePath;
    this.stderr = stderr;
  }
}

export class WriteIncompleteError extends Error {
  override readonly name = "WriteIncompleteError";
  public readonly expectedBytes: number;
  public readonly actualBytes: number;
  constructor(expectedBytes: number, actualBytes: number) {
    super(
      `Partial write: expected ${expectedBytes} bytes, wrote ${actualBytes}.`,
    );
    this.expectedBytes = expectedBytes;
    this.actualBytes = actualBytes;
  }
}
