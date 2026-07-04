/**
 * Drift check for the optional-plugin literal-import codegen: the generated
 * importer map's keys/specifiers match OPTIONAL_STATIC_PLUGIN_PACKAGES, every
 * entry is a literal-specifier import(), the bundled and unbundled lists stay
 * disjoint, and every getOptionalPlugin(...) in eliza.ts's descriptor table has a
 * literal importer or an explicit unbundled exemption. Reads the generated module
 * and eliza.ts as TEXT so vitest never eagerly resolves the unbuilt optional
 * specifiers.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  OPTIONAL_STATIC_PLUGIN_PACKAGES,
  renderOptionalPluginImportsModule,
  UNBUNDLED_OPTIONAL_PLUGINS,
} from "./optional-plugins.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

function readSource(file: string): string {
  return readFileSync(path.join(here, file), "utf8");
}

/**
 * Parse the generated importer map as TEXT. Importing the module would make
 * Vite/vitest eagerly resolve every literal `import()` specifier (several
 * optional plugins are intentionally unbuilt in this workspace), so the drift
 * check reads the source and asserts on the literal `"pkg": () => import("pkg")`
 * entries instead.
 */
function generatedImporterEntries(): { key: string; specifier: string }[] {
  const source = readSource("optional-plugin-imports.generated.ts");
  return [
    ...source.matchAll(/"([^"]+)":\s*\(\)\s*=>\s*import\(\s*"([^"]+)"\s*\)/g),
  ].map((m) => ({ key: m[1], specifier: m[2] }));
}

/**
 * Optional plugin packages the descriptor table (CORE_STATIC_PLUGIN_REGISTRATIONS
 * in eliza.ts) loads via getOptionalPlugin(...). Scanned from source so the
 * check needs no heavy import of eliza.ts.
 */
function descriptorTableOptionalPackages(): string[] {
  const source = readSource("eliza.ts");
  const matches = source.matchAll(/getOptionalPlugin\(\s*"([^"]+)"\s*\)/g);
  return [...new Set([...matches].map((m) => m[1]))];
}

describe("optional-plugin literal-import codegen", () => {
  it("generated importer keys match the source of truth exactly", () => {
    // Fails if optional-plugin-imports.generated.ts is stale — regenerate with
    // `bun run --cwd packages/agent gen:optional-plugin-imports`.
    const keys = generatedImporterEntries().map((e) => e.key);
    expect(keys).toEqual([...OPTIONAL_STATIC_PLUGIN_PACKAGES]);
  });

  it("every generated entry is a literal-specifier import (key === specifier)", () => {
    // The whole point: the bundler must see a string literal, never a variable.
    for (const { key, specifier } of generatedImporterEntries()) {
      expect(specifier, key).toBe(key);
    }
  });

  it("renderer emits a literal import() for every source package", () => {
    const rendered = renderOptionalPluginImportsModule(
      OPTIONAL_STATIC_PLUGIN_PACKAGES,
    );
    for (const pkg of OPTIONAL_STATIC_PLUGIN_PACKAGES) {
      expect(rendered, pkg).toContain(`"${pkg}": () => import("${pkg}")`);
    }
  });

  it("bundled and unbundled optional lists are disjoint", () => {
    const bundled = new Set(OPTIONAL_STATIC_PLUGIN_PACKAGES);
    for (const pkg of UNBUNDLED_OPTIONAL_PLUGINS) {
      expect(bundled.has(pkg), pkg).toBe(false);
    }
  });
});

describe("descriptor table ↔ generated imports consistency", () => {
  const declared = descriptorTableOptionalPackages();
  const resolvable = new Set<string>([
    ...OPTIONAL_STATIC_PLUGIN_PACKAGES,
    ...UNBUNDLED_OPTIONAL_PLUGINS,
  ]);

  it("finds the descriptor table's getOptionalPlugin entries", () => {
    // Guard against the scan silently matching nothing (e.g. a refactor renamed
    // getOptionalPlugin) which would make the check below vacuously pass.
    expect(declared.length).toBeGreaterThan(0);
  });

  it("every descriptor-table optional plugin has a literal importer or is explicitly unbundled", () => {
    // Adding getOptionalPlugin("@elizaos/plugin-new") to the descriptor table
    // must be paired with an entry in OPTIONAL_STATIC_PLUGIN_PACKAGES (then
    // regenerate) or UNBUNDLED_OPTIONAL_PLUGINS — no hand-written import branch,
    // and no plugin silently non-bundleable.
    for (const pkg of declared) {
      expect(resolvable.has(pkg), `${pkg} has no importer nor exemption`).toBe(
        true,
      );
    }
  });

  it("every bundled literal importer is referenced by the descriptor table", () => {
    // No orphan literal import bloating the mobile bundle for a plugin the
    // runtime never loads.
    const declaredSet = new Set(declared);
    for (const pkg of OPTIONAL_STATIC_PLUGIN_PACKAGES) {
      expect(declaredSet.has(pkg), `${pkg} is bundled but unused`).toBe(true);
    }
  });
});
