/**
 * Unit tests for view icons generated catalog: validates icon URL lookup.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

  it("maps every catalog key to its own view-icons/<key>.png asset", () => {
    const keys = Object.keys(VIEW_ICONS);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(VIEW_ICONS[key]).toBe(
        new URL(`./view-icons/${key}.png`, import.meta.url).href,
      );
    }
  });

  it("references a packaged PNG on disk for every catalog entry", () => {
    expect(Object.keys(VIEW_ICONS).length).toBe(52);
    for (const url of Object.values(VIEW_ICONS)) {
      expect(existsSync(fileURLToPath(url)), url).toBe(true);
    }
  });

  it("returns the exact catalog entry for every known id", () => {
    for (const [id, icon] of Object.entries(VIEW_ICONS)) {
      expect(viewIconDataUri(id)).toBe(icon);
    }
  });

  it("assigns a distinct asset to every id", () => {
    const values = Object.values(VIEW_ICONS);
    expect(new Set(values).size).toBe(values.length);
  });

  it("exposes parseable URLs whose paths end in .png under view-icons/", () => {
    for (const url of Object.values(VIEW_ICONS)) {
      const path = new URL(url).pathname;
      expect(path.endsWith(".png"), url).toBe(true);
      expect(path.includes("/view-icons/"), url).toBe(true);
    }
  });

  it("falls back to the default icon for an empty id", () => {
    expect(viewIconDataUri("")).toBe(VIEW_ICONS.default);
  });

  it("treats lookup as case-sensitive and falls back on mismatched case", () => {
    expect(viewIconDataUri("Chat")).toBe(VIEW_ICONS.default);
    expect(viewIconDataUri("SETTINGS")).toBe(VIEW_ICONS.default);
  });
});
