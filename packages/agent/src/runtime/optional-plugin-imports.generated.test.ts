/**
 * Behavioral coverage for the generated optional-plugin importer map.
 * Drives the real OPTIONAL_PLUGIN_IMPORTERS export: insertion order, unique
 * keys, missing-name lookup, unbundled exclusion, and the zero-arg function
 * values loadOptionalPlugin dispatches through.
 */
import { describe, expect, it } from "vitest";
import { OPTIONAL_PLUGIN_IMPORTERS } from "./optional-plugin-imports.generated.ts";
import {
  OPTIONAL_STATIC_PLUGIN_PACKAGES,
  optionalPluginImportSpecifier,
  UNBUNDLED_OPTIONAL_PLUGINS,
} from "./optional-plugins.ts";

const IMPORTER_KEYS = Object.keys(OPTIONAL_PLUGIN_IMPORTERS);

function requiredPackage(index: number): string {
  const pkg = OPTIONAL_STATIC_PLUGIN_PACKAGES[index];
  if (pkg === undefined) {
    throw new Error(`OPTIONAL_STATIC_PLUGIN_PACKAGES[${index}] is missing`);
  }
  return pkg;
}

describe("OPTIONAL_PLUGIN_IMPORTERS", () => {
  it("preserves source-of-truth package order as own keys", () => {
    expect(IMPORTER_KEYS).toEqual([...OPTIONAL_STATIC_PLUGIN_PACKAGES]);
  });

  it("lists each package once with a zero-arg importer function", () => {
    expect(IMPORTER_KEYS.length).toBeGreaterThan(0);
    expect(new Set(IMPORTER_KEYS).size).toBe(IMPORTER_KEYS.length);
    expect(Object.values(OPTIONAL_PLUGIN_IMPORTERS)).toHaveLength(
      IMPORTER_KEYS.length,
    );
    for (const pkg of IMPORTER_KEYS) {
      const importer = OPTIONAL_PLUGIN_IMPORTERS[pkg];
      expect(typeof importer, pkg).toBe("function");
      expect(importer?.length, pkg).toBe(0);
    }
  });

  it("returns the same function on repeated lookup of a single known package", () => {
    const firstPackage = requiredPackage(0);
    const lastPackage = requiredPackage(
      OPTIONAL_STATIC_PLUGIN_PACKAGES.length - 1,
    );
    const first = OPTIONAL_PLUGIN_IMPORTERS[firstPackage];
    const again = OPTIONAL_PLUGIN_IMPORTERS[firstPackage];
    expect(typeof first).toBe("function");
    expect(again).toBe(first);
    expect(OPTIONAL_PLUGIN_IMPORTERS[lastPackage]).not.toBe(first);
  });

  it("gives each package its own importer rather than an aliased shared function", () => {
    const importers = IMPORTER_KEYS.map(
      (pkg) => OPTIONAL_PLUGIN_IMPORTERS[pkg],
    );
    expect(new Set(importers).size).toBe(importers.length);
  });

  it("returns undefined for an empty or missing lookup, including unbundled plugins", () => {
    expect(OPTIONAL_PLUGIN_IMPORTERS[""]).toBeUndefined();
    expect(OPTIONAL_PLUGIN_IMPORTERS[" "]).toBeUndefined();
    expect(
      OPTIONAL_PLUGIN_IMPORTERS["@elizaos/plugin-missing"],
    ).toBeUndefined();
    expect(
      Object.hasOwn(OPTIONAL_PLUGIN_IMPORTERS, "@elizaos/plugin-missing"),
    ).toBe(false);
    for (const pkg of UNBUNDLED_OPTIONAL_PLUGINS) {
      expect(OPTIONAL_PLUGIN_IMPORTERS[pkg], pkg).toBeUndefined();
      expect(Object.hasOwn(OPTIONAL_PLUGIN_IMPORTERS, pkg), pkg).toBe(false);
    }
  });

  it("does not treat import specifiers, case variants, or overflow names as keys", () => {
    const inbox = "@elizaos/plugin-inbox";
    const inboxSpecifier = optionalPluginImportSpecifier(inbox);
    expect(inboxSpecifier).not.toBe(inbox);
    expect(OPTIONAL_PLUGIN_IMPORTERS[inboxSpecifier]).toBeUndefined();
    expect(typeof OPTIONAL_PLUGIN_IMPORTERS[inbox]).toBe("function");

    expect(OPTIONAL_PLUGIN_IMPORTERS["@elizaos/plugin-OpenAI"]).toBeUndefined();
    expect(OPTIONAL_PLUGIN_IMPORTERS["@ElizaOS/plugin-openai"]).toBeUndefined();
    expect(
      OPTIONAL_PLUGIN_IMPORTERS["@elizaos/plugin-openai "],
    ).toBeUndefined();
    expect(
      OPTIONAL_PLUGIN_IMPORTERS[String(OPTIONAL_STATIC_PLUGIN_PACKAGES.length)],
    ).toBeUndefined();
  });

  it("keeps capacity equal to the source list; deleting a missing key is a no-op", () => {
    const snapshotKeys = Object.keys(OPTIONAL_PLUGIN_IMPORTERS);
    const missing = "@elizaos/plugin-does-not-exist";
    expect(missing in OPTIONAL_PLUGIN_IMPORTERS).toBe(false);
    expect(delete OPTIONAL_PLUGIN_IMPORTERS[missing]).toBe(true);
    expect(Object.keys(OPTIONAL_PLUGIN_IMPORTERS)).toEqual(snapshotKeys);
    expect(Object.keys(OPTIONAL_PLUGIN_IMPORTERS)).toEqual([
      ...OPTIONAL_STATIC_PLUGIN_PACKAGES,
    ]);
  });
});
