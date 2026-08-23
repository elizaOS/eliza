/**
 * Coverage for browser-tabs-renderer-registry.
 */
import { describe, expect, it } from "vitest";
import { BROWSER_TAB_PRELOAD_SCRIPT } from "./browser-tabs-renderer-registry.js";
describe("browser-tabs-renderer-registry", () => {
  it("exports preload script", () => {
    expect(BROWSER_TAB_PRELOAD_SCRIPT).toContain("__elizaTabKit");
    expect(typeof BROWSER_TAB_PRELOAD_SCRIPT).toBe("string");
  });
  it("has content", () => {
    expect(BROWSER_TAB_PRELOAD_SCRIPT.length).toBeGreaterThan(100);
  });
});
