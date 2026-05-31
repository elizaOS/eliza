/** GHSA-rcvr-766c-4phv: arbitrary page.evaluate + AsyncFunction must not run agent-supplied code. */

export const BROWSER_EXECUTE_DISABLED_MESSAGE =
  "Arbitrary browser JavaScript execution is disabled for security (GHSA-rcvr-766c-4phv). " +
  "Use browser DOM, clickables, click, type, navigate, screenshot, and wait actions instead.";

export class BrowserExecuteDisabledError extends Error {
  readonly code = "browser_execute_disabled" as const;

  constructor(message = BROWSER_EXECUTE_DISABLED_MESSAGE) {
    super(message);
    this.name = "BrowserExecuteDisabledError";
  }
}

export function assertBrowserExecuteAllowed(): never {
  throw new BrowserExecuteDisabledError();
}

export function isBrowserExecuteAllowed(): boolean {
  return false;
}
