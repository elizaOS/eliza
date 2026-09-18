/** Verifies bundler-visible optional imports and runtime source-condition parsing with deterministic contracts. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  hasElizaSourceRuntimeCondition,
  OPTIONAL_STATIC_PLUGIN_PACKAGES,
  optionalPluginImportSpecifier,
  UNBUNDLED_OPTIONAL_PLUGINS,
} from "./optional-plugins.ts";

// The bundler requires literal imports. Compare parsed entries against the actual
// map keys so a variable import cannot silently drop a plugin from the bundle.
const source = readFileSync(
  new URL("./optional-plugin-imports.ts", import.meta.url),
  "utf8",
);
const entries = [
  ...source.matchAll(
    /"([^"]+)":\s*\(\)\s*=>\s*(?:\/\/[^\n]*\n\s*)*import\(\s*"([^"]+)"\s*\)/g,
  ),
].map((match) => ({ key: match[1], specifier: match[2] }));

describe("optional plugin bundling contract", () => {
  it("uses literal imports for every registered bundled plugin", () => {
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.map(({ key }) => key)).toEqual(
      OPTIONAL_STATIC_PLUGIN_PACKAGES,
    );
    for (const { key, specifier } of entries) {
      expect(specifier, key).toBe(optionalPluginImportSpecifier(key));
    }
  });
  it("does not bundle plugins declared desktop-only", () => {
    for (const name of UNBUNDLED_OPTIONAL_PLUGINS) {
      expect(OPTIONAL_STATIC_PLUGIN_PACKAGES).not.toContain(name);
    }
  });
});

describe("workspace-source runtime condition", () => {
  it("recognizes both supported command-line condition forms", () => {
    expect(
      hasElizaSourceRuntimeCondition([
        "--no-install",
        "--conditions=eliza-source",
      ]),
    ).toBe(true);
    expect(
      hasElizaSourceRuntimeCondition(["--conditions", "eliza-source"]),
    ).toBe(true);
  });

  it("does not treat unrelated or missing conditions as source mode", () => {
    expect(hasElizaSourceRuntimeCondition(["--conditions=node"])).toBe(false);
    expect(hasElizaSourceRuntimeCondition(["--no-install"])).toBe(false);
  });
});
