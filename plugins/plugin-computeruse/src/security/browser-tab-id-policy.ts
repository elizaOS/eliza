/**
 * Canonical browser-tab identifier policy for Computer Use.
 *
 * The Puppeteer adapter publishes dense zero-based page indices as decimal
 * strings. Close/switch are destructive enough that prefix parsing (for
 * example, treating `1junk` as tab 1) must fail closed at every entry point.
 */

import { ElizaError } from "@elizaos/core";

const CANONICAL_BROWSER_TAB_ID = /^(?:0|[1-9]\d*)$/u;

export const INVALID_BROWSER_TAB_ID_MESSAGE =
  "Computer-use browser tab ID must be a canonical non-negative safe integer.";

export class InvalidBrowserTabIdError extends ElizaError {
  override readonly name = "InvalidBrowserTabIdError";

  constructor() {
    super(INVALID_BROWSER_TAB_ID_MESSAGE, {
      code: "COMPUTER_USE_BROWSER_TAB_ID_INVALID",
    });
  }
}

export function normalizeBrowserTabId(raw: unknown): string {
  const candidate = typeof raw === "number" ? String(raw) : raw;
  if (
    typeof candidate !== "string" ||
    !CANONICAL_BROWSER_TAB_ID.test(candidate) ||
    !Number.isSafeInteger(Number(candidate))
  ) {
    throw new InvalidBrowserTabIdError();
  }
  return candidate;
}
