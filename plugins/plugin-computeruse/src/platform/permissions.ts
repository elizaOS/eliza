import { execFileSync } from "node:child_process";
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

// ── Windows permission classifiers ───────────────────────────────────────────
//
// Windows surfaces privacy denials through a small set of recognizable error
// shapes:
//   - "Access is denied" / HRESULT 0x80070005 (E_ACCESSDENIED) — generic Win32
//   - "Class not registered" + Get-AppxPackage missing → camera/screen privacy
//     blocks expressed as the COM facade returning failure (Windows 10/11
//     returns this when the Settings → Privacy → Camera switch is off for
//     Win32 apps).
//   - "ConsentStore" — UWP camera/microphone consent store entries when
//     enumerated through PowerShell registry queries.
//   - "BlockedByPolicy" — Group Policy disabled the device.

function matchesWindowsPrivacyDeniedError(message: string): boolean {
  return /access(?:\s+is)?\s+denied|0x80070005|class not registered|consentstore|blockedbypolicy|the device is not ready|element not found.*camera|element not found.*microphone|requestedaccess.*denied/i.test(
    message,
  );
}

function matchesWindowsScreenCaptureDenied(message: string): boolean {
  return /screen capture.*denied|graphicscapturesession|capture is not supported|displaymanagement.*denied|monitor info.*access/i.test(
    message,
  );
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
  const platform = process.platform;

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

  // Windows privacy classifier — matches Windows 10/11 surface forms.
  // PARITY: code-complete; not runtime-tested against a real Windows host.
  if (platform === "win32") {
    if (
      fallback.permissionType === "screen_recording" &&
      (matchesWindowsScreenCaptureDenied(message) ||
        matchesWindowsPrivacyDeniedError(message))
    ) {
      return createPermissionDeniedError({
        permissionType: "screen_recording",
        operation: fallback.operation,
        message:
          "Screen capture is blocked by Windows privacy settings or Group Policy. Open Settings > Privacy & Security > Screen recording and enable access for this app, then retry.",
        details: message,
      });
    }
    if (
      (fallback.permissionType === "camera" ||
        fallback.permissionType === "microphone") &&
      matchesWindowsPrivacyDeniedError(message)
    ) {
      const deviceLabel =
        fallback.permissionType === "camera" ? "Camera" : "Microphone";
      return createPermissionDeniedError({
        permissionType: fallback.permissionType,
        operation: fallback.operation,
        message: `${deviceLabel} access is denied by Windows privacy settings or Group Policy. Open Settings > Privacy & Security > ${deviceLabel} and enable access for this app, then retry.`,
        details: message,
      });
    }
    if (
      fallback.permissionType === "accessibility" &&
      matchesWindowsPrivacyDeniedError(message)
    ) {
      // Windows does not require an accessibility permission for SendInput,
      // but UAC and protected-process targets surface the same denial shape.
      return createPermissionDeniedError({
        permissionType: "accessibility",
        operation: fallback.operation,
        message:
          "Input dispatch was refused by Windows. The target window is likely an elevated (UAC) or protected process; restart the host with matching elevation or target a different window.",
        details: message,
      });
    }
  }

  return null;
}

// ── Probe helpers ────────────────────────────────────────────────────────────
//
// Best-effort, side-effect-free permission probes. They never throw — callers
// use the returned `granted` field plus `details` to drive UX. macOS is the
// only platform with a real privacy DB we can read without prompting; Windows
// inspects the Capability Access Manager registry; Linux has no equivalent.

export interface PermissionProbeResult {
  /** True if the OS reports the permission is granted for this process. */
  readonly granted: boolean;
  /**
   * `null` when the OS doesn't expose a probe (Linux desktop, headless, etc.)
   * — caller should treat this as "unknown, attempt the operation and rely on
   * runtime classification".
   */
  readonly probed: boolean;
  readonly details?: string;
}

function probeWindowsCapabilityAccess(
  capability: "webcam" | "microphone" | "graphicsCaptureProgrammatic",
): PermissionProbeResult {
  // Windows stores per-capability consent under
  //   HKCU\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\<capability>
  // The `Value` REG_SZ is "Allow" / "Deny". This is read-only and never
  // triggers a consent prompt.
  // PARITY: code-complete; not runtime-tested against a real Windows host.
  const { execFileSync } = require("node:child_process") as {
    execFileSync: (
      cmd: string,
      args: string[],
      opts?: { encoding?: string; timeout?: number; stdio?: unknown },
    ) => string;
  };
  const command = `try { (Get-ItemProperty -ErrorAction Stop -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\${capability}').Value } catch { 'Unknown' }`;
  const stdout = execFileSync(
    "powershell",
    ["-NoProfile", "-Command", command],
    {
      encoding: "utf8",
      timeout: 4000,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  const value = String(stdout).trim();
  return {
    granted: /^allow$/i.test(value),
    probed: value.length > 0 && !/^unknown$/i.test(value),
    details: `CapabilityAccessManager.${capability}=${value || "<empty>"}`,
  };
}

export function probePermission(
  permissionType: PermissionType,
): PermissionProbeResult {
  if (process.platform !== "win32") {
    return { granted: false, probed: false };
  }
  if (permissionType === "camera") {
    try {
      return probeWindowsCapabilityAccess("webcam");
    } catch (err) {
      return { granted: false, probed: false, details: toMessage(err) };
    }
  }
  if (permissionType === "microphone") {
    try {
      return probeWindowsCapabilityAccess("microphone");
    } catch (err) {
      return { granted: false, probed: false, details: toMessage(err) };
    }
  }
  if (permissionType === "screen_recording") {
    try {
      return probeWindowsCapabilityAccess("graphicsCaptureProgrammatic");
    } catch (err) {
      return { granted: false, probed: false, details: toMessage(err) };
    }
  }
  // accessibility / shell — Windows has no per-app gate; treat as granted.
  return { granted: true, probed: false };
}
