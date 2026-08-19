/**
 * HTTP(S)-only navigation policy for computer-use Puppeteer. FILE actions
 * already refuse credential and OS-private paths; `page.goto` did not, so a
 * `file:` or `javascript:` target bypassed that gate and loaded local bytes
 * into the screenshot surface.
 */

import { ElizaError } from "@elizaos/core";

export const BLOCKED_BROWSER_URL_SCHEME_MESSAGE =
  "Computer-use browser navigation requires an absolute http(s) URL without embedded credentials.";

export class BlockedBrowserUrlError extends ElizaError {
  override readonly name = "BlockedBrowserUrlError";

  constructor(options?: { cause?: unknown; protocol?: string }) {
    super(BLOCKED_BROWSER_URL_SCHEME_MESSAGE, {
      code: "COMPUTER_USE_BROWSER_URL_BLOCKED",
      ...(options?.cause === undefined ? {} : { cause: options.cause }),
      ...(options?.protocol === undefined
        ? {}
        : { context: { protocol: options.protocol } }),
    });
  }
}

export function assertHttpBrowserUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch (cause) {
    // error-policy:J3 untrusted navigation target; unparseable URL is denied.
    throw new BlockedBrowserUrlError({ cause });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new BlockedBrowserUrlError({ protocol: parsed.protocol });
  }
  if (parsed.username || parsed.password) {
    throw new BlockedBrowserUrlError({ protocol: parsed.protocol });
  }
  return parsed.href;
}
