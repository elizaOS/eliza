/**
 * Deterministic coverage for the computer-use browser navigation scheme gate.
 * No Puppeteer launch; the predicate is the system under test.
 */
import { ElizaError } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  assertHttpBrowserUrl,
  BLOCKED_BROWSER_URL_SCHEME_MESSAGE,
  BlockedBrowserUrlError,
} from "../security/browser-url-policy.js";

describe("assertHttpBrowserUrl", () => {
  it("admits http and https URLs", () => {
    expect(assertHttpBrowserUrl("https://example.com/path")).toBe(
      "https://example.com/path",
    );
    expect(assertHttpBrowserUrl("http://127.0.0.1:31337/")).toBe(
      "http://127.0.0.1:31337/",
    );
    expect(assertHttpBrowserUrl("HTTPS://EXAMPLE.COM")).toBe(
      "https://example.com/",
    );
  });

  it.each([
    "file:///etc/passwd",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "about:blank",
    "https://user@example.com/private",
    "https://user:password@example.com/private",
    "not a url",
  ])("rejects %s", (raw) => {
    expect(() => assertHttpBrowserUrl(raw)).toThrow(BlockedBrowserUrlError);
    expect(() => assertHttpBrowserUrl(raw)).toThrow(
      BLOCKED_BROWSER_URL_SCHEME_MESSAGE,
    );
  });

  it("uses the repository's typed domain error contract", () => {
    let thrown: unknown;
    try {
      assertHttpBrowserUrl("not a url");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ElizaError);
    expect(thrown).toMatchObject({
      name: "BlockedBrowserUrlError",
      code: "COMPUTER_USE_BROWSER_URL_BLOCKED",
    });
    expect((thrown as Error).cause).toBeInstanceOf(TypeError);
  });
});
