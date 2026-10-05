export class UnsupportedPlatformError extends Error {
  override readonly name = "UnsupportedPlatformError";
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

export class InvalidDiskNumberError extends Error {
  override readonly name = "InvalidDiskNumberError";
  constructor(
    message: string,
    public readonly value: number,
  ) {
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
export class WriteCancelledError extends Error {
  override readonly name = "WriteCancelledError";
  constructor(
    message = "Write cancelled. Media is incomplete and must be rewritten or restored before use.",
  ) {
    super(message);
  }
}

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
