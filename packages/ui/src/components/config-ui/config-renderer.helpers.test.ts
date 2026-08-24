/**
 * Unit tests for the default config field registry.
 *
 * Asserts the wiring `defineRegistry(defaultCatalog, defaultRenderers)` produces
 * — that catalog field types actually resolve to renderers, and that the
 * documented `text` fallback holds for unknown types. Checking only that the
 * export is an object would pass for `{}`.
 */
import { describe, expect, it } from "vitest";
import { defaultCatalog } from "../../config/config-catalog";
import { defaultRenderers } from "./config-field.helpers";
import { defaultRegistry } from "./config-renderer.helpers.ts";

describe("config-renderer.helpers", () => {
  it("wires defaultCatalog to defaultRenderers", () => {
    expect(defaultRegistry.catalog).toBe(defaultCatalog);
    expect(defaultRegistry.renderers).toBe(defaultRenderers);
  });

  it("resolves a renderer for every catalog field type that has one", () => {
    const catalogTypes = Object.keys(defaultCatalog.fields);
    expect(catalogTypes.length).toBeGreaterThan(0);
    // "text" is the documented fallback target, so it must always resolve.
    expect(typeof defaultRegistry.resolve("text")).toBe("function");

    const unrendered = catalogTypes.filter(
      (type) => defaultRenderers[type] && !defaultRegistry.resolve(type),
    );
    expect(unrendered).toEqual([]);
  });

  it("falls back to the text renderer for an unknown field type", () => {
    expect(
      defaultRegistry.resolve("definitely-not-a-field-type"),
    ).toBeUndefined();
    expect(
      defaultRegistry.resolveOrFallback("definitely-not-a-field-type"),
    ).toBe(defaultRegistry.resolve("text"));
  });
});
