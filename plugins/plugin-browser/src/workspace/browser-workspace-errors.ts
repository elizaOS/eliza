/**
 * Structured browser-workspace error contract (issue #9476).
 *
 * The workspace command path (`executeBrowserWorkspaceCommand` and the helpers
 * in `browser-workspace-helpers.ts`) throws bare `new Error(...)` for many
 * distinct failure modes — an invalid URL, a missing tab, a desktop-only
 * subaction, a forbidden user script, a connector secret-export attempt — so
 * callers today must regex the human-readable message to react. This mirrors the
 * CUA `screenshot-errors.ts` contract: a machine-readable
 * {@link BrowserWorkspaceErrorCode} added **additively** via
 * {@link tagBrowserWorkspaceError} (annotates the existing Error in place,
 * preserving its identity/message) plus a pure {@link classifyBrowserWorkspaceErrorCode}
 * that maps the well-known thrown-message shapes to a code — one testable source
 * of truth. This increment is the contract + classifier only; wiring
 * `tagBrowserWorkspaceError` into the `executeBrowserWorkspaceCommand` catch
 * boundary is a follow-up.
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

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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

/**
 * Map any thrown value to a {@link BrowserWorkspaceErrorCode} from the
 * well-known message shapes the workspace helpers throw. Already-tagged errors
 * return their own code. Pure — the single source of truth for the mapping.
 */
export function classifyBrowserWorkspaceErrorCode(
  error: unknown,
): BrowserWorkspaceErrorCode {
  if (isBrowserWorkspaceError(error)) return error.browserWorkspaceErrorCode;
  const message = toMessage(error);

  if (/rejected invalid URL|only supports http\/https/i.test(message)) {
    return "invalid_url";
  }
  if (/\(404\)|Tab .+ was not found/i.test(message)) {
    return "tab_not_found";
  }
  if (/requires a current tab/i.test(message)) {
    return "target_missing";
  }
  if (
    /only available in the desktop app|desktop bridge is unavailable/i.test(
      message,
    )
  ) {
    return "desktop_only";
  }
  if (
    /arbitrary (script execution|user script) is disabled|not supported on the web backend/i.test(
      message,
    )
  ) {
    return "script_forbidden";
  }
  if (
    /do not allow raw cookie, token, storage, or state export/i.test(message)
  ) {
    return "connector_secret_export_forbidden";
  }
  if (/Unknown browser snapshot element ref/i.test(message)) {
    return "unknown_element_ref";
  }
  if (/timed out|timeout|\bETIMEDOUT\b/i.test(message)) {
    return "timeout";
  }
  return "command_failed";
}

/**
 * Tag an existing thrown value with its {@link BrowserWorkspaceErrorCode} +
 * operation, **in place and additively** (preserves the original Error identity
 * and message). Idempotent: re-tagging keeps the first code. A non-Error value
 * is wrapped in a fresh `BrowserWorkspaceError`.
 */
export function tagBrowserWorkspaceError(
  error: unknown,
  operation: string,
): BrowserWorkspaceError {
  if (isBrowserWorkspaceError(error)) return error; // idempotent
  if (error instanceof Error) {
    const tagged = error as Mutable<BrowserWorkspaceError>;
    tagged.browserWorkspaceErrorCode = classifyBrowserWorkspaceErrorCode(error);
    tagged.operation = operation;
    return tagged;
  }
  return createBrowserWorkspaceError(
    classifyBrowserWorkspaceErrorCode(error),
    operation,
    toMessage(error),
  );
}
