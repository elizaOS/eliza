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
