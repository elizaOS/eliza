/**
 * Direct unit coverage for connector-imports helpers. Retained from the former
 * src/test-support/test-helpers.test.ts after removing HTTP-factory and waitMs
 * tests. The predicate exports (looksLikePlugin, extractPlugin) have non-obvious
 * precedence (default beats plugin, root-module name short-circuits before key
 * scan) that a refactor could silently break. Every live e2e importer is gated
 * behind describeIf, so without these tests a precedence regression would appear
 * only on a credentialed runner.
 */
import { describe, expect, it } from "vitest";
import {
  extractPlugin,
  looksLikePlugin,
  type PluginModuleShape,
} from "./connector-imports";

describe("looksLikePlugin", () => {
  it("rejects null, undefined, and non-objects", () => {
    expect(looksLikePlugin(null)).toBe(false);
    expect(looksLikePlugin(undefined)).toBe(false);
    expect(looksLikePlugin("plugin")).toBe(false);
    expect(looksLikePlugin(1)).toBe(false);
    expect(looksLikePlugin(true)).toBe(false);
  });

  it("rejects functions even when Function.name is a non-empty string", () => {
    function namedExport() {}
    expect(namedExport.name).toBe("namedExport");
    expect(looksLikePlugin(namedExport)).toBe(false);
  });

  it("rejects objects whose name is missing or not a string", () => {
    expect(looksLikePlugin({})).toBe(false);
    expect(looksLikePlugin({ Name: "wrong-case" })).toBe(false);
    expect(looksLikePlugin({ name: 42 })).toBe(false);
    expect(looksLikePlugin({ name: null })).toBe(false);
    expect(looksLikePlugin({ name: undefined })).toBe(false);
    expect(looksLikePlugin([])).toBe(false);
  });

  it("accepts a plain object whose name is a string, including empty", () => {
    expect(looksLikePlugin({ name: "telegram" })).toBe(true);
    expect(looksLikePlugin({ name: "" })).toBe(true);
    expect(looksLikePlugin({ name: "x", extra: 1 })).toBe(true);
  });
});

describe("extractPlugin", () => {
  it("returns null for an empty module and for modules with no plugin-shaped export", () => {
    expect(extractPlugin({})).toBeNull();
    expect(
      extractPlugin({
        default: { not: "a-plugin" },
        plugin: 1,
        helper: () => undefined,
      }),
    ).toBeNull();
  });

  it("prefers default over plugin when both look like plugins", () => {
    const mod: PluginModuleShape = {
      default: { name: "from-default" },
      plugin: { name: "from-plugin" },
    };
    expect(extractPlugin(mod)).toEqual({ name: "from-default" });
  });

  it("uses plugin when default is present but not plugin-shaped", () => {
    const mod: PluginModuleShape = {
      default: { name: 1 },
      plugin: { name: "from-plugin" },
    };
    expect(extractPlugin(mod)).toEqual({ name: "from-plugin" });
  });

  it("returns the module itself when it has a string name, before scanning other keys", () => {
    const nested = { name: "nested" };
    const mod: PluginModuleShape = {
      name: "root-module",
      other: nested,
    };
    expect(extractPlugin(mod)).toBe(mod);
  });

  it("skips default and plugin keys while scanning remaining exports, in insertion order", () => {
    const first = { name: "first-named" };
    const second = { name: "second-named" };
    const mod: PluginModuleShape = {
      default: { name: 0 },
      plugin: { nope: true },
      first,
      second,
    };
    expect(extractPlugin(mod)).toBe(first);
  });

  it("returns null when no export matches", () => {
    expect(
      extractPlugin({
        default: undefined,
        plugin: undefined,
        actions: [],
      }),
    ).toBeNull();
  });
});