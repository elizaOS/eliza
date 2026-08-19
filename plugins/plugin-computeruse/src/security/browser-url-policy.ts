/**
 * HTTP(S)-only navigation policy for computer-use Puppeteer. FILE actions
 * already refuse credential and OS-private paths; `page.goto` did not, so a
 * `file:` or `javascript:` target bypassed that gate and loaded local bytes
 * into the screenshot surface.
 */

export const BLOCKED_BROWSER_URL_SCHEME_MESSAGE =
  "Computer-use browser navigation allows only http and https URLs.";

export class BlockedBrowserUrlError extends Error {
  readonly code = "blocked_browser_url" as const;

  constructor(message = BLOCKED_BROWSER_URL_SCHEME_MESSAGE) {
    super(message);
    this.name = "BlockedBrowserUrlError";
  }
}

export function assertHttpBrowserUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    // error-policy:J3 untrusted navigation target; unparseable URL is denied.
    throw new BlockedBrowserUrlError(BLOCKED_BROWSER_URL_SCHEME_MESSAGE);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new BlockedBrowserUrlError(BLOCKED_BROWSER_URL_SCHEME_MESSAGE);
  }
  return parsed.href;
}
