import type { PermissionType } from "../types.js";

type PermissionErrorOptions = {
  permissionType: PermissionType;
  operation: string;
  message: string;
  details?: string;
};

export type PermissionDeniedError = Error & {
  permissionDenied: true;
  permissionType: PermissionType;
  operation: string;
  details?: string;
};

function toMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function createPermissionDeniedError(
  options: PermissionErrorOptions,
): PermissionDeniedError {
  const error = new Error(options.message) as PermissionDeniedError;
  error.name = "PermissionDeniedError";
  error.permissionDenied = true;
  error.permissionType = options.permissionType;
  error.operation = options.operation;
  if (options.details) {
    error.details = options.details;
  }
  return error;
}

export function isPermissionDeniedError(
  value: unknown,
): value is PermissionDeniedError {
  return (
    value instanceof Error &&
    "permissionDenied" in value &&
    value.permissionDenied === true &&
    "permissionType" in value &&
    typeof value.permissionType === "string"
  );
}

function matchesAccessibilityPermissionError(message: string): boolean {
  return /accessibility|assistive access|not authorized to send apple events|osascript.*not allowed|osascript.*etimedout|spawnsync osascript etimedout|system events got an error|not permitted to send keystrokes|control.*not allowed/i.test(
    message,
  );
}

function matchesScreenRecordingPermissionError(message: string): boolean {
  return /screen recording|screen capture|not authorized|permission denied|could not create image from display|screencapture.*empty|cgwindowlistcreateimage|capture failed/i.test(
    message,
  );
}

export function classifyPermissionDeniedError(
  error: unknown,
  fallback: {
    permissionType: PermissionType;
    operation: string;
  },
): PermissionDeniedError | null {
  if (isPermissionDeniedError(error)) {
    return error;
  }

  const message = toMessage(error);

  if (
    fallback.permissionType === "accessibility" &&
    matchesAccessibilityPermissionError(message)
  ) {
    return createPermissionDeniedError({
      permissionType: "accessibility",
      operation: fallback.operation,
      message:
        "Desktop automation requires macOS Accessibility permission. Grant access in System Settings > Privacy & Security > Accessibility, then retry.",
      details: message,
    });
  }

  if (
    fallback.permissionType === "screen_recording" &&
    matchesScreenRecordingPermissionError(message)
  ) {
    return createPermissionDeniedError({
      permissionType: "screen_recording",
      operation: fallback.operation,
      message:
        "Screenshots require macOS Screen Recording permission. Grant access in System Settings > Privacy & Security > Screen Recording, then retry.",
      details: message,
    });
  }

  return null;
}
