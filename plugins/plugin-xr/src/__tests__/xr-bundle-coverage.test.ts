/**
 * XR view bundle coverage — validates that every registered XR view plugin
 * has a built dist/views/bundle.js that is non-empty, valid JavaScript,
 * and exports the component named in the plugin manifest.
 *
 * This is the "real elizaOS plugin infrastructure" layer the simulator tests
 * cannot reach: it proves that the actual view content (the React component
 * that loads inside the XR shell) is built, present, and structurally sound.
 *
 * What is tested:
 *   - bundle.js exists for all 23 source-buildable plugins
 *   - bundle.js is non-empty (not a build stub)
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

function missingBundlePaths(): string[] {
  return PLUGIN_BUNDLES.map(({ pluginDir }) => bundlePathFor(pluginDir)).filter(
    (bundlePath) => !fileExists(bundlePath),
  );
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

// The 24 plugin manifests → (plugin directory, manifest path)
const PLUGIN_BUNDLES: Array<{ pluginDir: string; manifestPath: string }> = [
  {
    pluginDir: "plugins/plugin-companion",
    manifestPath: "plugins/plugin-companion/src/plugin.ts",
  },
  {
    pluginDir: "plugins/plugin-contacts",
    manifestPath: "plugins/plugin-contacts/src/plugin.ts",
  },
  {
    pluginDir: "plugins/plugin-hyperliquid-app",
    manifestPath: "plugins/plugin-hyperliquid-app/src/plugin.ts",
  },
  {
    pluginDir: "plugins/plugin-lifeops",
    manifestPath: "plugins/plugin-lifeops/src/plugin.ts",
  },
  {
    pluginDir: "plugins/plugin-messages",
    manifestPath: "plugins/plugin-messages/src/plugin.ts",
  },
  {
    pluginDir: "plugins/app-model-tester",
    manifestPath: "plugins/app-model-tester/src/plugin.ts",
  },
  {
    pluginDir: "plugins/plugin-phone",
    manifestPath: "plugins/plugin-phone/src/plugin.ts",
  },
  {
    pluginDir: "plugins/plugin-polymarket-app",
    manifestPath: "plugins/plugin-polymarket-app/src/plugin.ts",
  },
  {
    pluginDir: "plugins/plugin-shopify-ui",
    manifestPath: "plugins/plugin-shopify-ui/src/plugin.ts",
  },
  {
    pluginDir: "plugins/plugin-steward-app",
    manifestPath: "plugins/plugin-steward-app/src/plugin.ts",
  },
  {
    pluginDir: "plugins/plugin-vincent",
    manifestPath: "plugins/plugin-vincent/src/plugin.ts",
  },
  {
    pluginDir: "plugins/plugin-wallet-ui",
    manifestPath: "plugins/plugin-wallet-ui/src/plugin.ts",
  },
  {
    pluginDir: "plugins/plugin-2004scape",
    manifestPath: "plugins/plugin-2004scape/src/index.ts",
  },
  {
    pluginDir: "plugins/plugin-feed",
    manifestPath: "plugins/plugin-feed/src/index.ts",
  },
  {
    pluginDir: "plugins/plugin-app-control",
    manifestPath: "plugins/plugin-app-control/src/index.ts",
  },
  {
    pluginDir: "plugins/plugin-clawville",
    manifestPath: "plugins/plugin-clawville/src/index.ts",
  },
  {
    pluginDir: "plugins/plugin-defense-of-the-agents",
    manifestPath: "plugins/plugin-defense-of-the-agents/src/index.ts",
  },
  {
    pluginDir: "plugins/plugin-hyperscape",
    manifestPath: "plugins/plugin-hyperscape/src/index.ts",
  },
  {
    pluginDir: "plugins/plugin-scape",
    manifestPath: "plugins/plugin-scape/src/index.ts",
  },
  {
    pluginDir: "plugins/plugin-screenshare",
    manifestPath: "plugins/plugin-screenshare/src/index.ts",
  },
  {
    pluginDir: "plugins/plugin-task-coordinator",
    manifestPath: "plugins/plugin-task-coordinator/src/index.ts",
  },
  {
    pluginDir: "plugins/plugin-trajectory-logger",
    manifestPath: "plugins/plugin-trajectory-logger/src/index.ts",
  },
  {
    pluginDir: "plugins/plugin-training",
    manifestPath: "plugins/plugin-training/src/setup-routes.ts",
  },
  {
    pluginDir: "plugins/plugin-facewear",
    manifestPath: "plugins/plugin-facewear/src/index.ts",
  },
];

describe("XR view bundle coverage — all 24 plugin bundles built and valid", () => {
  it("declares dist/views/bundle.js for every plugin with an XR view", () => {
    const missingDeclarations: string[] = [];
    for (const { pluginDir, manifestPath } of PLUGIN_BUNDLES) {
      const xrViews = extractXrViews(readFile(manifestPath));
      if (xrViews.length === 0) {
        missingDeclarations.push(pluginDir);
      }
    }
    expect(
      missingDeclarations,
      "plugins without view build declarations",
    ).toEqual([]);
  });

  it("dist/views/bundle.js exists for every plugin with an XR view", () => {
    expect(
      missingBundlePaths(),
      "plugins with missing XR view bundles (run each plugin's build:views)",
    ).toEqual([]);
  });

  it("built bundle.js files are non-empty (at least 1 KB of content)", () => {
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

  it("bundle.js size is consistent with real plugin content (not a stub)", () => {
    // A real built view bundle should be at least 5 KB. Stubs or empty files are typically < 1 KB.
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

  it("plugin manifest bundlePath uses the standard view bundle location", () => {
    const mismatches: string[] = [];
    for (const { pluginDir, manifestPath } of PLUGIN_BUNDLES) {
      const manifestSource = readFile(manifestPath);
      const xrViews = extractXrViews(manifestSource);
      for (const view of xrViews) {
        if (view.bundlePath !== "dist/views/bundle.js") {
          mismatches.push(
            `${pluginDir}: manifest says bundlePath="${view.bundlePath}"`,
          );
        }
      }
    }
    expect(
      mismatches,
      "manifest bundlePath using non-standard locations",
    ).toEqual([]);
  });
});
