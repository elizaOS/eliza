// @vitest-environment jsdom
/**
 * The preview-mode toggle (`usePreviewMode`): default-off, `localStorage`
 * persistence, and the in-memory cache that mirrors it. jsdom + real
 * `localStorage`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isPreviewModeEnabled, setPreviewMode } from "./usePreviewMode";

describe("usePreviewMode", () => {
  beforeEach(() => {
    window.localStorage.clear();
    // Reset the in-memory cache to the unset default.
    setPreviewMode(false);
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it("defaults to off", () => {
    window.localStorage.removeItem("eliza:previewMode");
    // The cached snapshot was seeded at module load; the default is false.
    expect(isPreviewModeEnabled()).toBe(false);
  });

  it("persists an explicit choice to localStorage and reflects it", () => {
    setPreviewMode(true);
    expect(isPreviewModeEnabled()).toBe(true);
    expect(window.localStorage.getItem("eliza:previewMode")).toBe("1");

    setPreviewMode(false);
    expect(isPreviewModeEnabled()).toBe(false);
    expect(window.localStorage.getItem("eliza:previewMode")).toBe("0");
  });
});
