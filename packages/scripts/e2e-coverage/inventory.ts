/**
 * Per-plugin keyless-e2e coverage inventory.
 *
 * Builds the data the coverage gate (`check-e2e-coverage.ts`) consumes: for
 * every checked-out plugin under `plugins/`, what agent surface it exposes
 * (actions / connectors) and whether any keyless ("pr-deterministic") scenario
 * exercises it.
 *
 * "Keyless e2e" here means a scenario that runs on a PR under the deterministic
 * LLM proxy with zero credentials — i.e. a scenario in the
 * `packages/scenario-runner/test/scenarios` deterministic corpus, or one in the
 * big `packages/test/scenarios` corpus tagged `lane: "pr-deterministic"`. A
 * plugin "has keyless e2e" when at least one such scenario names it in its
 * `requires.plugins`.
 *
 * Detection is static (source read, no plugin import) so the inventory stays
 * cheap and works even for plugins that cannot be imported under Node.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

const PLUGINS_DIR = path.join(REPO_ROOT, "plugins");

/** Scenario corpora that run keyless on a PR. */
const KEYLESS_SCENARIO_ROOTS = [
  path.join(REPO_ROOT, "packages", "scenario-runner", "test", "scenarios"),
  path.join(REPO_ROOT, "packages", "test", "scenarios"),
];

/** The lane string a corpus scenario must declare to count as keyless. */
const KEYLESS_LANE = "pr-deterministic";

export interface PluginSurface {
  /** Directory name, e.g. `plugin-discord`. */
  dir: string;
  /** Package name from package.json, e.g. `@elizaos/plugin-discord`. */
  packageName: string;
  /** True when the plugin wires an agent action surface. */
  hasActions: boolean;
  /** True when the plugin implements/registers a message connector. */
  hasConnector: boolean;
}

export interface PluginCoverage extends PluginSurface {
  /** Scenario ids (keyless) that name this plugin in `requires.plugins`. */
  keylessScenarioIds: string[];
  /** True when the plugin exposes an action/connector surface. */
  hasSurface: boolean;
  /** True when the plugin has a keyless scenario for its surface. */
  hasKeylessE2e: boolean;
}

function listDirs(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((entry) => {
      const full = path.join(root, entry);
      return statSync(full).isDirectory();
    })
    .sort();
}

function readPackageName(pluginDir: string): string | null {
  const pkgPath = path.join(pluginDir, "package.json");
  if (!existsSync(pkgPath)) return null;
  const parsed = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    name?: unknown;
  };
  return typeof parsed.name === "string" ? parsed.name : null;
}

function readSourceFiles(srcDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (
        entry === "node_modules" ||
        entry === "dist" ||
        entry === "__tests__" ||
        entry === "test" ||
        entry === "tests"
      ) {
        continue;
      }
      const full = path.join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
      } else if (
        entry.endsWith(".ts") &&
        !entry.endsWith(".test.ts") &&
        !entry.endsWith(".d.ts")
      ) {
        out.push(full);
      }
    }
  };
  walk(srcDir);
  return out;
}

/** A plugin wires actions when its barrel declares a non-empty `actions:`. */
function detectActions(srcDir: string): boolean {
  if (existsSync(path.join(srcDir, "actions"))) return true;
  for (const indexName of ["index.ts", "plugin.ts"]) {
    const indexPath = path.join(srcDir, indexName);
    if (!existsSync(indexPath)) continue;
    const source = readFileSync(indexPath, "utf8");
    // Match `actions: [ ... ]` with at least one entry inside the brackets.
    if (/\bactions\s*:\s*\[\s*[^\]\s]/.test(source)) return true;
  }
  return false;
}

/** A plugin is a connector when it implements/registers a message connector. */
function detectConnector(srcFiles: string[]): boolean {
  const markers = [
    /\bimplements\s+MessageConnector\b/,
    /\bsatisfies\s+MessageConnector\b/,
    /:\s*MessageConnector\b/,
    /\bregisterConnector\s*\(/,
    /\bregisterMessageConnector\s*\(/,
  ];
  for (const file of srcFiles) {
    const source = readFileSync(file, "utf8");
    if (markers.some((marker) => marker.test(source))) return true;
  }
  return false;
}

export function inventoryPluginSurfaces(): PluginSurface[] {
  const surfaces: PluginSurface[] = [];
  for (const dir of listDirs(PLUGINS_DIR)) {
    if (!dir.startsWith("plugin-")) continue;
    const pluginDir = path.join(PLUGINS_DIR, dir);
    const srcDir = path.join(pluginDir, "src");
    // Submodules that are not checked out have no `src/` — skip them; the gate
    // can only reason about plugins whose source is present in this tree.
    if (!existsSync(srcDir)) continue;
    const packageName = readPackageName(pluginDir);
    if (!packageName) continue;
    const srcFiles = readSourceFiles(srcDir);
    surfaces.push({
      dir,
      packageName,
      hasActions: detectActions(srcDir),
      hasConnector: detectConnector(srcFiles),
    });
  }
  return surfaces;
}

interface ScenarioRequire {
  id: string;
  requiredPlugins: string[];
}

function readStaticScenario(file: string): ScenarioRequire | null {
  const source = readFileSync(file, "utf8");
  const idMatch = source.match(/\bid\s*:\s*["'`]([^"'`]+)["'`]/);
  if (!idMatch) return null;
  const id = idMatch[1];

  // A scenario counts as keyless if it declares the keyless lane OR it lives in
  // the deterministic corpus (those run keyless by construction).
  const declaresKeylessLane = new RegExp(
    `\\blane\\s*:\\s*["'\`]${KEYLESS_LANE}["'\`]`,
  ).test(source);
  const isDeterministicCorpus = file.includes(
    `${path.sep}scenario-runner${path.sep}test${path.sep}scenarios${path.sep}`,
  );
  if (!declaresKeylessLane && !isDeterministicCorpus) return null;

  const requiredPlugins: string[] = [];
  const requiresMatch = source.match(
    /requires\s*:\s*{[\s\S]*?plugins\s*:\s*\[([\s\S]*?)\]/,
  );
  if (requiresMatch) {
    for (const m of requiresMatch[1].matchAll(/["'`]([^"'`]+)["'`]/g)) {
      requiredPlugins.push(m[1]);
    }
  }
  return { id, requiredPlugins };
}

function discoverScenarioFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith("_") || entry === "node_modules") continue;
      const full = path.join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
      } else if (entry.endsWith(".scenario.ts")) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

/** Map of package-name -> keyless scenario ids that require it. */
export function keylessScenariosByPlugin(): Map<string, string[]> {
  const byPlugin = new Map<string, string[]>();
  for (const root of KEYLESS_SCENARIO_ROOTS) {
    for (const file of discoverScenarioFiles(root)) {
      const scenario = readStaticScenario(file);
      if (!scenario) continue;
      for (const pluginRef of scenario.requiredPlugins) {
        const existing = byPlugin.get(pluginRef) ?? [];
        existing.push(scenario.id);
        byPlugin.set(pluginRef, existing);
      }
    }
  }
  return byPlugin;
}

export function buildPluginCoverage(): PluginCoverage[] {
  const surfaces = inventoryPluginSurfaces();
  const byPlugin = keylessScenariosByPlugin();
  return surfaces.map((surface) => {
    // Scenarios may reference a plugin by package name or by short name (the
    // `requires.plugins` field accepts both styles across the corpus).
    const shortName = surface.dir;
    const altNames = [
      surface.packageName,
      shortName,
      shortName.replace(/^plugin-/, ""),
    ];
    const keylessScenarioIds = [
      ...new Set(altNames.flatMap((name) => byPlugin.get(name) ?? [])),
    ].sort();
    const hasSurface = surface.hasActions || surface.hasConnector;
    return {
      ...surface,
      keylessScenarioIds,
      hasSurface,
      hasKeylessE2e: keylessScenarioIds.length > 0,
    };
  });
}
