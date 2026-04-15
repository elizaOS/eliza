/**
 * Structured permission-denied helpers for macOS desktop automation.
 *
 * The upstream Electron app surfaces Accessibility and Screen Recording
 * denials as typed results. This module mirrors that shape without tying the
 * plugin to Electron so the service layer can consume it later.
 */

import { currentPlatform } from "./helpers.js";

export type PermissionType = "accessibility" | "screen_recording";

export interface PermissionDeniedResult {
  success: false;
  error: string;
  permissionDenied: true;
  permissionType: PermissionType;
  operation: string;
  platform: string;
  details?: string;
}

export interface PermissionDeniedInput {
  permissionType: PermissionType;
  operation: string;
  message: string;
  details?: string;
}

const ACCESSIBILITY_DENIED_PATTERNS = [
  /not authorized to send apple events/i,
  /not allowed to send keystrokes/i,
  /not allowed to control/i,
  /accessibility/i,
  /system events/i,
  /operation not permitted/i,
];

const SCREEN_RECORDING_DENIED_PATTERNS = [
  /screen recording/i,
  /screen capture/i,
  /capture the screen/i,
  /screencapture/i,
  /empty screenshot/i,
  /not authorized to capture/i,
  /operation not permitted/i,
];

export class PermissionDeniedError extends Error implements PermissionDeniedResult {
  readonly success = false as const;
  readonly permissionDenied = true as const;
  readonly error: string;

  constructor(
    message: string,
    public readonly permissionType: PermissionType,
    public readonly operation: string,
    public readonly details: string | undefined = undefined,
  ) {
    super(message);
    this.name = "PermissionDeniedError";
    this.error = message;
  }

  get platform(): string {
    return currentPlatform();
  }

  toResult(): PermissionDeniedResult {
    return {
      success: false,
      error: this.message,
      permissionDenied: true,
      permissionType: this.permissionType,
      operation: this.operation,
      platform: this.platform,
      details: this.details,
    };
  }
}

export function createPermissionDeniedError(
  input: PermissionDeniedInput,
): PermissionDeniedError {
  return new PermissionDeniedError(
    input.message,
    input.permissionType,
    input.operation,
    input.details,
  );
}

export function isPermissionDeniedError(value: unknown): value is PermissionDeniedError {
  return Boolean(
    value
      && typeof value === "object"
      && (value as { permissionDenied?: unknown }).permissionDenied === true
      && typeof (value as { permissionType?: unknown }).permissionType === "string",
  );
}

export function permissionDeniedResultFromError(
  value: unknown,
): PermissionDeniedResult | null {
  if (isPermissionDeniedError(value)) {
    return value.toResult();
  }
  return null;
}

export function isAccessibilityPermissionDenied(value: unknown): boolean {
  return isMacPermissionDenied(value, ACCESSIBILITY_DENIED_PATTERNS);
}

export function isScreenRecordingPermissionDenied(value: unknown): boolean {
  return isMacPermissionDenied(value, SCREEN_RECORDING_DENIED_PATTERNS);
}

export function classifyPermissionDeniedError(
  value: unknown,
  input: Omit<PermissionDeniedInput, "message">,
): PermissionDeniedError | null {
  if (input.permissionType === "accessibility") {
    if (!isAccessibilityPermissionDenied(value)) {
      return null;
    }
  } else if (!isScreenRecordingPermissionDenied(value)) {
    return null;
  }

  return createPermissionDeniedError({
    ...input,
    message: buildPermissionDeniedMessage(input.permissionType),
    details: extractErrorText(value),
  });
}

function isMacPermissionDenied(value: unknown, patterns: RegExp[]): boolean {
  if (currentPlatform() !== "darwin") {
    return false;
  }

  const text = extractErrorText(value);
  if (!text) {
    return false;
  }

  return patterns.some((pattern) => pattern.test(text));
}

function extractErrorText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (value && typeof value === "object") {
    const parts: string[] = [];
    const error = value as {
      message?: unknown;
      stdout?: unknown;
      stderr?: unknown;
    };

    for (const part of [error.message, error.stderr, error.stdout]) {
      if (typeof part === "string" && part.trim()) {
        parts.push(part.trim());
      } else if (Buffer.isBuffer(part)) {
        const text = part.toString("utf-8").trim();
        if (text) {
          parts.push(text);
        }
      }
    }

    return parts.join("\n");
  }

  return String(value);
}

function buildPermissionDeniedMessage(permissionType: PermissionType): string {
  if (permissionType === "accessibility") {
    return "macOS Accessibility permission is required for desktop automation (clicks, typing, scrolling, and drag operations). Grant access in System Settings > Privacy & Security > Accessibility, then retry.";
  }

  return "macOS Screen Recording permission is required for screenshots. Grant access in System Settings > Privacy & Security > Screen Recording, then retry.";
}
