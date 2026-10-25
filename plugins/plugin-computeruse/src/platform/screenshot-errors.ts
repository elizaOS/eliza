/**
 * Structured screenshot error contract (issue #9105, M3.5).
 *
 * Capture can fail for several distinct reasons, and a caller (the CUA Brain,
 * the GET_SCREEN op, the approval/telemetry layer) wants to react differently
 * to each: a missing OS permission needs a "grant access" prompt; a missing CLI
 * tool needs an "install scrot/ImageMagick" hint; an empty buffer or a timeout
 * is a transient retry. Before this contract, those were indistinguishable —
 * callers had to regex the human-readable message.
 *
 * This module adds a machine-readable {@link ScreenshotErrorCode} **additively**:
 * `tagScreenshotError` annotates the *existing* thrown error object with a code
 * rather than replacing it, so a `PermissionDeniedError` keeps its identity
 * (`isPermissionDeniedError` stays true) while also gaining a
 * `screenshotErrorCode` of `"permission_denied"`. No existing caller breaks; new
 * callers can switch on the code.
 */

import { isPermissionDeniedError } from "./permissions.js";

export type ScreenshotErrorCode =
  /** An OS privacy permission (Screen Recording / Accessibility) is denied. */
  | "permission_denied"
  /** No screenshot CLI tool is installed (e.g. Linux without scrot/import). */
  | "tool_missing"
  /** The capture tool ran but produced an empty/zero-byte image. */
  | "empty_output"
  /** The capture command exceeded its timeout. */
  | "timeout"
  /** Any other capture failure. */
  | "capture_failed";

/** An `Error` carrying a machine-readable {@link ScreenshotErrorCode}. */
export interface ScreenshotError extends Error {
  readonly screenshotErrorCode: ScreenshotErrorCode;
  /** The capture operation that failed (e.g. `screenshot_capture`). */
  readonly operation: string;
  /** Underlying error message, when this wraps a lower-level failure. */
  readonly details?: string;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isScreenshotError(value: unknown): value is ScreenshotError {
  return (
    value instanceof Error &&
    "screenshotErrorCode" in value &&
    typeof (value as { screenshotErrorCode?: unknown }).screenshotErrorCode ===
      "string"
  );
}

export function createScreenshotError(
  code: ScreenshotErrorCode,
  operation: string,
  message: string,
  details?: string,
): ScreenshotError {
  const error = new Error(message) as Mutable<ScreenshotError>;
  error.name = "ScreenshotError";
  error.screenshotErrorCode = code;
  error.operation = operation;
  if (details !== undefined) error.details = details;
  return error;
}

/**
 * Map any thrown value to a {@link ScreenshotErrorCode} by inspecting its type
 * and message. Permission denials win first (they are typed); the rest are
 * recognized from the well-known message shapes the capture functions throw.
 * Pure — exported so the mapping has a single, testable source of truth.
 */
export function classifyScreenshotErrorCode(
  error: unknown,
): ScreenshotErrorCode {
  if (isPermissionDeniedError(error)) return "permission_denied";
  if (isScreenshotError(error)) return error.screenshotErrorCode;

  const message = toMessage(error).toLowerCase();
  if (
    /no screenshot tool|install (imagemagick|scrot|gnome-screenshot)|command not found|\benoent\b|not recognized as (?:the name of )?an? (?:internal|cmdlet)/.test(
      message,
    )
  ) {
    return "tool_missing";
  }
  if (
    /empty (?:file|output|image|buffer)|zero[- ]?byte|returned an empty/.test(
      message,
    )
  ) {
    return "empty_output";
  }
  if (/timed out|timeout|\betimedout\b/.test(message)) {
    return "timeout";
  }
  return "capture_failed";
}

/**
 * Annotate `error` with a {@link ScreenshotErrorCode} and return it. Additive:
 * an `Error` (including a `PermissionDeniedError`) is mutated in place so its
 * identity and existing fields are preserved; a non-`Error` value is wrapped in
 * a fresh {@link ScreenshotError}. Idempotent — an already-tagged error is
 * returned unchanged.
 */
export function tagScreenshotError(
  error: unknown,
  operation: string,
): ScreenshotError {
  if (isScreenshotError(error)) return error;

  const code = classifyScreenshotErrorCode(error);
  if (error instanceof Error) {
    const tagged = error as Mutable<ScreenshotError>;
    tagged.screenshotErrorCode = code;
    if (typeof tagged.operation !== "string") tagged.operation = operation;
    return tagged;
  }
  return createScreenshotError(code, operation, toMessage(error));
}
