/**
 * Structured browser-workspace error contract (issue #9476).
 *
 * The workspace command path (`executeBrowserWorkspaceCommand` and the helpers
 * in `browser-workspace-helpers.ts`) throws bare `new Error(...)` for many
 * distinct failure modes — an invalid URL, a missing tab, a desktop-only
 * subaction, a forbidden user script, a connector secret-export attempt — so
 * callers had to regex the human-readable message to react. Errors created
 * with {@link createBrowserWorkspaceError} carry a machine-readable
 * {@link BrowserWorkspaceErrorCode} instead.
 */

export type BrowserWorkspaceErrorCode =
  /** URL rejected: not a valid URL, or not http/https. */
  | "invalid_url"
  /** The referenced tab id does not exist (404). */
  | "tab_not_found"
  /** The subaction needs a current/target tab and none was available. */
  | "target_missing"
  /** The subaction is only available in the desktop app / bridge. */
  | "desktop_only"
  /** Arbitrary user/JSDOM script execution is disabled (GHSA-mhhr-9ph9-64j7). */
  | "script_forbidden"
  /** A connector session tried to export raw cookies/tokens/storage/state. */
  | "connector_secret_export_forbidden"
  /** Command filePath/outputPath/baselinePath escaped the workspace root. */
  | "path_forbidden"
  /** A snapshot element ref is stale/unknown (re-snapshot needed). */
  | "unknown_element_ref"
  /** The operation exceeded its timeout. */
  | "timeout"
  /** Any other workspace command failure. */
  | "command_failed";

/** An `Error` carrying a machine-readable {@link BrowserWorkspaceErrorCode}. */
export interface BrowserWorkspaceError extends Error {
  readonly browserWorkspaceErrorCode: BrowserWorkspaceErrorCode;
  /** The workspace operation that failed (e.g. `navigate`, `eval`). */
  readonly operation: string;
  /** Underlying message, when this wraps a lower-level failure. */
  readonly details?: string;
  /** HTTP status from an upstream workspace bridge, when available. */
  readonly status?: number;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export function isBrowserWorkspaceError(
  value: unknown,
): value is BrowserWorkspaceError {
  return (
    value instanceof Error &&
    "browserWorkspaceErrorCode" in value &&
    typeof (value as { browserWorkspaceErrorCode?: unknown })
      .browserWorkspaceErrorCode === "string"
  );
}

export function createBrowserWorkspaceError(
  code: BrowserWorkspaceErrorCode,
  operation: string,
  message: string,
  details?: string,
  status?: number,
): BrowserWorkspaceError {
  const error = new Error(message) as Mutable<BrowserWorkspaceError>;
  error.name = "BrowserWorkspaceError";
  error.browserWorkspaceErrorCode = code;
  error.operation = operation;
  if (details !== undefined) error.details = details;
  if (status !== undefined) error.status = status;
  return error;
}
