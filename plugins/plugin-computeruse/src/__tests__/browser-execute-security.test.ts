/**
 * Guards that executeBrowser refuses arbitrary agent-supplied script and never
 * opens a page (GHSA-rcvr-766c-4phv). Deterministic unit test.
 */
import { describe, expect, it } from "vitest";
import { executeBrowser } from "../platform/browser.js";
import { BrowserExecuteDisabledError } from "../security/browser-script-policy.js";

describe("executeBrowser security", () => {
  it("rejects arbitrary script without opening a browser page", async () => {
    await expect(executeBrowser("document.cookie")).rejects.toThrow(
      BrowserExecuteDisabledError,
    );
  });
});
