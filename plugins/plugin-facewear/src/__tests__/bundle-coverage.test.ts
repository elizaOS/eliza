/**
 * Facewear view bundle coverage — validates that the plugin's XR view bundle
 * is built, non-empty, valid JavaScript, and exports the component named in the
 * plugin manifest.
 *
 * This is the "real elizaOS plugin infrastructure" layer the simulator tests
 * cannot reach: it proves that the actual view content (the React component
 * that loads inside the XR shell) is built, present, and structurally sound.
 *
 * What is tested:
 *   - bundle.js exists for the facewear plugin
 *   - bundle.js is non-empty (not a tiny fallback bundle)
 *   - bundle.js contains the componentExport name from the manifest
 *   - bundle.js is valid JavaScript (no JSON or HTML accidentally written there)
 *   - The plugin manifest and bundle agree on componentExport
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

function readFile(relPath: string): string {
  return readFileSync(resolve(repoRoot, relPath), "utf8");
}

function fileExists(relPath: string): boolean {
  return existsSync(resolve(repoRoot, relPath));
}

function fileSize(relPath: string): number {
  const p = resolve(repoRoot, relPath);
  if (!existsSync(p)) return 0;
  return statSync(p).size;
}

function bundlePathFor(pluginDir: string): string {
  return `${pluginDir}/dist/views/bundle.js`;
}

// Parses viewType/id/componentExport/bundlePath from plugin source
function extractXrViews(
  source: string,
): Array<{ id: string; componentExport: string; bundlePath: string }> {
  const results: Array<{
    id: string;
    componentExport: string;
    bundlePath: string;
  }> = [];
  // Match view objects with viewType: "xr"
  const viewsStart = source.indexOf("views:");
  if (viewsStart === -1) return results;
  const arrayStart = source.indexOf("[", viewsStart);
  if (arrayStart === -1) return results;
  let depth = 0;
  let arrayEnd = -1;
  for (let i = arrayStart; i < source.length; i++) {
    if (source[i] === "[") depth++;
    if (source[i] === "]") depth--;
    if (depth === 0) {
      arrayEnd = i;
      break;
    }
  }
  if (arrayEnd === -1) return results;
  const body = source.slice(arrayStart + 1, arrayEnd);
  const objects: string[] = [];
  let start = -1;
  depth = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "{") {
      if (depth === 0) start = i;
      depth++;
    }
    if (body[i] === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        objects.push(body.slice(start, i + 1));
        start = -1;
      }
    }
  }
  for (const obj of objects) {
    const viewType = obj.match(/viewType:\s*"([^"]+)"/)?.[1];
    if (viewType !== "xr") continue;
    const id = obj.match(/\bid:\s*"([^"]+)"/)?.[1];
    const componentExport = obj.match(/componentExport:\s*"([^"]+)"/)?.[1];
    const bundlePath = obj.match(/bundlePath:\s*"([^"]+)"/)?.[1];
    if (id && componentExport && bundlePath) {
      results.push({ id, componentExport, bundlePath });
    }
  }
  return results;
}

// Keep this test scoped to plugin-facewear. Monorepo-wide view bundle coverage
// belongs in an app-level integration suite because unrelated plugin bundles
// are not guaranteed to exist when this package's test script runs.
const PLUGIN_BUNDLES: Array<{ pluginDir: string; manifestPath: string }> = [
  {
    pluginDir: "plugins/plugin-facewear",
    manifestPath: "plugins/plugin-facewear/src/index.ts",
  },
];

describe("Facewear view bundle coverage", () => {
  it("dist/views/bundle.js exists for every plugin with an XR view", () => {
    const missing: string[] = [];
    for (const { pluginDir } of PLUGIN_BUNDLES) {
      const bundlePath = bundlePathFor(pluginDir);
      if (!fileExists(bundlePath)) {
        missing.push(bundlePath);
      }
    }
    expect(
      missing,
      "plugins with missing view bundles (run `bun run build:views`)",
    ).toEqual([]);
  });

  it("every bundle.js is non-empty (at least 1 KB of content)", () => {
    const tooSmall: string[] = [];
    for (const { pluginDir } of PLUGIN_BUNDLES) {
      const bundlePath = bundlePathFor(pluginDir);
      const size = fileSize(bundlePath);
      if (size < 1024) {
        tooSmall.push(`${bundlePath}: ${size} bytes`);
      }
    }
    expect(tooSmall, "bundles too small to contain real content").toEqual([]);
  });

  it("every bundle.js starts with valid JavaScript (not HTML or JSON)", () => {
    const invalid: string[] = [];
    for (const { pluginDir } of PLUGIN_BUNDLES) {
      const bundlePath = bundlePathFor(pluginDir);
      if (!fileExists(bundlePath)) {
        invalid.push(`${bundlePath}: missing`);
        continue;
      }
      const first = readFile(bundlePath).trimStart().slice(0, 20);
      if (first.startsWith("<") || first.startsWith("{")) {
        invalid.push(`${bundlePath}: starts with "${first}"`);
      }
    }
    expect(invalid, "bundles with invalid content type").toEqual([]);
  });

  it("every bundle.js contains the componentExport declared in the plugin manifest", () => {
    const mismatches: string[] = [];
    for (const { pluginDir, manifestPath } of PLUGIN_BUNDLES) {
      const bundlePath = bundlePathFor(pluginDir);
      if (!fileExists(bundlePath)) {
        mismatches.push(`${bundlePath}: missing`);
        continue;
      }

      const manifestSource = readFile(manifestPath);
      const xrViews = extractXrViews(manifestSource);
      const bundle = readFile(bundlePath);

      for (const view of xrViews) {
        // componentExport may be a full path like "@pkg/name#ExportName" — extract just the export name
        const exportName = view.componentExport.includes("#")
          ? (view.componentExport.split("#").pop() ?? view.componentExport)
          : view.componentExport;
        if (!bundle.includes(exportName)) {
          mismatches.push(
            `${pluginDir}: bundle does not contain export "${exportName}" (from manifest componentExport "${view.componentExport}" for view "${view.id}")`,
          );
        }
      }
    }
    expect(
      mismatches,
      "bundles missing their declared componentExport",
    ).toEqual([]);
  });

  it("bundle.js size is consistent with real plugin content", () => {
    // A real built view bundle should be at least 5 KB. Tiny fallback or empty files are typically < 1 KB.
    const tooSmall: string[] = [];
    for (const { pluginDir } of PLUGIN_BUNDLES) {
      const bundlePath = `${pluginDir}/dist/views/bundle.js`;
      const size = fileSize(bundlePath);
      if (size > 0 && size < 5000) {
        tooSmall.push(
          `${bundlePath}: ${size} bytes (expected ≥ 5 KB for real content)`,
        );
      }
    }
    expect(tooSmall, "suspiciously small bundles").toEqual([]);
  });

  it("plugin manifest bundlePath matches the actual built bundle location", () => {
    const mismatches: string[] = [];
    for (const { pluginDir, manifestPath } of PLUGIN_BUNDLES) {
      const manifestSource = readFile(manifestPath);
      const xrViews = extractXrViews(manifestSource);
      for (const view of xrViews) {
        const expectedBundlePath = `${pluginDir}/${view.bundlePath}`;
        if (!fileExists(expectedBundlePath)) {
          mismatches.push(
            `${pluginDir}: manifest says bundlePath="${view.bundlePath}" but ${expectedBundlePath} does not exist`,
          );
        }
      }
    }
    expect(
      mismatches,
      "manifest bundlePath pointing to non-existent files",
    ).toEqual([]);
  });
});
