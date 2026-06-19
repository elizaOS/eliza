import { describe, expect, it } from "vitest";
import { BrowserExecuteDisabledError } from "../security/browser-script-policy.js";
import { executeBrowser } from "../platform/browser.js";

describe("executeBrowser security", () => {
  it("rejects arbitrary script without opening a browser page", async () => {
    await expect(executeBrowser("document.cookie")).rejects.toThrow(
      BrowserExecuteDisabledError,
    );
  });
});
