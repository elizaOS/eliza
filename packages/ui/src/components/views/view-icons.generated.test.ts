/**
 * Unit tests for view icons generated catalog: validates icon URL lookup.
 */
import { describe, expect, it } from "vitest";
import { VIEW_ICONS, viewIconDataUri } from "./view-icons.generated.ts";

describe("view-icons.generated", () => {
  it("exports populated VIEW_ICONS catalog map", () => {
    expect(VIEW_ICONS.activity).toBeDefined();
    expect(VIEW_ICONS.chat).toBeDefined();
    expect(VIEW_ICONS.settings).toBeDefined();
    expect(VIEW_ICONS.default).toBeDefined();
  });

  it("resolves icon URI for known view IDs", () => {
    const chatIcon = viewIconDataUri("chat");
    expect(typeof chatIcon).toBe("string");
    expect(chatIcon.length).toBeGreaterThan(0);
  });

  it("falls back to default icon URI for unknown view IDs", () => {
    const unknownIcon = viewIconDataUri("non-existent-view-id");
    expect(unknownIcon).toBe(VIEW_ICONS.default);
  });
});
