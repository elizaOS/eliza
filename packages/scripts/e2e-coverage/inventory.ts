/**
 * Canonical e2e coverage inventory.
 *
 * Two complementary surface inventories live here:
 *
 * 1. **Surface coverage matrix (issue #8802).** Enumerates, from real source,
 *    every surface that ships a behavioural effect a user can trigger — slash
 *    commands, pre-LLM shortcuts (#8791), plugin-declared HTTP routes, and
 *    views — then cross-checks each against the committed coverage manifest
 *    (`./manifest.ts`). A surface item is "covered" only when a real test
 *    artifact exists AND contains a declared signal string (the anti-larp
 *    check: a shape-only unit test that never names the real handler does not
 *    count). Items may instead be `exempt` with a written justification. This is
 *    the single source of truth for the ship-gate
 *    (`packages/scripts/__tests__/e2e-coverage.test.ts`) and the report CLI
 *    (`packages/scripts/e2e-coverage/write-coverage-matrix-report.ts`).
 *
 * 2. **Per-plugin keyless-e2e coverage (issue #8801).** For every checked-out
 *    plugin under `plugins/`, what agent surface it exposes (actions /
 *    connectors) and whether any keyless ("pr-deterministic") scenario
 *    exercises it. Consumed by the per-plugin coverage gate
 *    (`./check-e2e-coverage.ts`).
 *
 * Both inventories perform no network or runtime boot — they statically scan
 * the plugin tree and (for the matrix) import only the dependency-light
 * `getConnectorCommands` projection.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { commandShortcuts } from "../../../plugins/plugin-commands/src/actions/shortcuts.ts";
// Dependency-light: connector-catalog only imports ./registry + ./settings-sections
// + ./types (a type-only `@elizaos/core` import that erases at compile), so this
// pulls no runtime framework code.
import { getConnectorCommands } from "../../../plugins/plugin-commands/src/connector-catalog.ts";
import type { ManifestEntry } from "./manifest.ts";
import {
  COMMAND_COVERAGE,
  LARP_TEST_ARTIFACTS,
  PLUGIN_ROUTE_COVERAGE,
  SHORTCUT_COVERAGE,
  SHORTCUT_REGISTRY_HINTS,
  VIEW_COVERAGE_GATES,
} from "./manifest.ts";

export const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".turbo",
  "__tests__",
  "__mocks__",
  "test",
  "tests",
  "fixtures",
]);

function walkTsFiles(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walkTsFiles(full, out);
    } else if (
      entry.endsWith(".ts") &&
      !entry.endsWith(".d.ts") &&
      !entry.endsWith(".test.ts")
    ) {
      out.push(full);
    }
  }
  return out;
}

/**
 * A `routes:` property value is real route-wiring unless it is an empty array
 * (`routes: []`) or a bare type annotation (`routes: Route[]`, used in
 * interfaces/config types). Identifiers, spreads, array literals and factory
 * calls are real wiring.
 */
function isRealRoutesWiring(rawValue: string): boolean {
  const value = rawValue.trim().replace(/,$/, "").trim();
  if (value === "") return false;
  if (/^\[\s*\]$/.test(value)) return false; // routes: []
  // routes: Route[] / routes: readonly LinearRoute[] — a type annotation.
  if (/^(readonly\s+)?[A-Za-z_][A-Za-z0-9_]*\[\]$/.test(value)) return false;
  return true;
}

export interface RoutePluginInfo {
  plugin: string;
  /** The matched `routes:` wiring value (for diagnostics). */
  wiring: string;
}

/**
 * Plugins whose exported `Plugin` object wires a non-empty `routes` array — the
 * surfaces served in prod via `tryHandleRuntimePluginRoute`.
 */
export function discoverRoutePlugins(root = REPO_ROOT): RoutePluginInfo[] {
  const pluginsDir = path.join(root, "plugins");
  let dirs: string[];
  try {
    dirs = readdirSync(pluginsDir);
  } catch {
    return [];
  }
  const found: RoutePluginInfo[] = [];
  for (const plugin of dirs) {
    if (!plugin.startsWith("plugin-") && !plugin.startsWith("app-")) continue;
    const src = path.join(pluginsDir, plugin, "src");
    if (!existsSync(src)) continue;
    let wiring: string | null = null;
    for (const file of walkTsFiles(src)) {
      const text = readFileSync(file, "utf8");
      for (const line of text.split(/\r?\n/)) {
        const match = line.match(/^\s*routes:\s*(.+?)\s*$/);
        if (!match) continue;
        if (isRealRoutesWiring(match[1])) {
          wiring = match[1].trim();
          break;
        }
      }
      if (wiring) break;
    }
    if (wiring) found.push({ plugin, wiring });
  }
  return found.sort((a, b) => a.plugin.localeCompare(b.plugin));
}

/**
 * Plugins under `plugins/` with no test file at all (the issue's "zero-test"
 * list). Used to report them in the matrix; coverage/exemption is owned by the
 * manifest.
 */
export function discoverZeroTestPlugins(root = REPO_ROOT): string[] {
  const pluginsDir = path.join(root, "plugins");
  let dirs: string[];
  try {
    dirs = readdirSync(pluginsDir);
  } catch {
    return [];
  }
  const zero: string[] = [];
  for (const plugin of dirs) {
    if (!plugin.startsWith("plugin-") && !plugin.startsWith("app-")) continue;
    const dir = path.join(pluginsDir, plugin);
    if (!statSafe(dir)?.isDirectory()) continue;
    if (!isPluginInventoryDir(dir)) continue;
    if (!hasAnyTestFile(dir)) zero.push(plugin);
  }
  return zero.sort();
}

function isPluginInventoryDir(dir: string): boolean {
  return (
    existsSync(path.join(dir, "package.json")) ||
    existsSync(path.join(dir, "src")) ||
    existsSync(path.join(dir, "bun.lock"))
  );
}

function statSafe(p: string) {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

function hasAnyTestFile(dir: string): boolean {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist" || entry === ".turbo") {
      continue;
    }
    const full = path.join(dir, entry);
    const st = statSafe(full);
    if (!st) continue;
    if (st.isDirectory()) {
      if (hasAnyTestFile(full)) return true;
    } else if (/\.(test|spec|scenario)\.[cm]?tsx?$/.test(entry)) {
      return true;
    }
  }
  return false;
}

/** True when the #8791 pre-LLM shortcut registry exists in source yet. */
export function discoverShortcutRegistry(root = REPO_ROOT): string[] {
  const hits: string[] = [];
  for (const rel of SHORTCUT_REGISTRY_HINTS) {
    if (existsSync(path.join(root, rel))) hits.push(rel);
  }
  return hits;
}

export interface ShortcutSurfaceInfo {
  shortcutId: string;
  alias: string;
  targetKind: string;
  targetName: string;
  signal: string;
}

export function discoverCommandShortcutSurfaces(): ShortcutSurfaceInfo[] {
  const surfaces: ShortcutSurfaceInfo[] = [];
  for (const shortcut of commandShortcuts) {
    const target =
      shortcut.target.kind === "action"
        ? shortcut.target.name
        : "path" in shortcut.target
          ? shortcut.target.path
          : shortcut.target.kind;
    for (const alias of shortcut.aliases ?? []) {
      surfaces.push({
        shortcutId: shortcut.id,
        alias,
        targetKind: shortcut.target.kind,
        targetName: target,
        signal: `${shortcut.id}:${alias}->${target}`,
      });
    }
  }
  return surfaces.sort((a, b) => a.signal.localeCompare(b.signal));
}

export interface CoverageResolution {
  status: "covered" | "exempt" | "missing";
  detail: string;
  artifacts: string[];
  /** Signals that were required but not found in any artifact (larp risk). */
  missingSignals: string[];
}

/** Resolve a manifest entry against the filesystem with anti-larp signal checks. */
export function resolveCoverage(
  entry: ManifestEntry | undefined,
  root = REPO_ROOT,
): CoverageResolution {
  if (!entry) {
    return {
      status: "missing",
      detail: "no manifest entry",
      artifacts: [],
      missingSignals: [],
    };
  }
  if (entry.status === "exempt") {
    return {
      status: "exempt",
      detail: entry.reason,
      artifacts: entry.artifacts ?? [],
      missingSignals: [],
    };
  }
  // covered — every artifact must exist; signals must each appear in ≥1 artifact.
  const sources: Array<{ rel: string; text: string }> = [];
  const missingFiles: string[] = [];
  for (const rel of entry.artifacts) {
    const full = path.join(root, rel);
    if (!existsSync(full)) {
      missingFiles.push(rel);
      continue;
    }
    sources.push({ rel, text: readFileSync(full, "utf8") });
  }
  if (missingFiles.length > 0) {
    return {
      status: "missing",
      detail: `covering artifact(s) not found: ${missingFiles.join(", ")}`,
      artifacts: entry.artifacts,
      missingSignals: [],
    };
  }
  // Anti-larp: a covering artifact must not be a known shape-only unit test.
  const larp = entry.artifacts.filter((rel) => LARP_TEST_ARTIFACTS.has(rel));
  if (larp.length > 0) {
    return {
      status: "missing",
      detail: `larp artifact(s) do not count as coverage: ${larp.join(", ")}`,
      artifacts: entry.artifacts,
      missingSignals: [],
    };
  }
  const missingSignals = entry.signals.filter(
    (signal) => !sources.some((s) => s.text.includes(signal)),
  );
  if (missingSignals.length > 0) {
    return {
      status: "missing",
      detail: `required signal(s) absent from every artifact: ${missingSignals.join(", ")}`,
      artifacts: entry.artifacts,
      missingSignals,
    };
  }
  return {
    status: "covered",
    detail: entry.note ?? `covered by ${entry.artifacts.length} artifact(s)`,
    artifacts: entry.artifacts,
    missingSignals: [],
  };
}

export interface SurfaceItem {
  id: string;
  kind: "command" | "shortcut" | "view" | "plugin-route";
  status: "covered" | "exempt" | "missing";
  detail: string;
  artifacts: string[];
  /** Whether a gap on this item blocks CI (false = advisory, e.g. shortcuts). */
  blocking: boolean;
  meta?: Record<string, unknown>;
}

export interface CoverageMatrix {
  schema: "eliza_e2e_coverage_matrix_v1";
  generatedAt: string;
  summary: {
    commands: { total: number; covered: number };
    shortcuts: { total: number; covered: number; gated: boolean };
    pluginRoutes: { total: number; covered: number; exempt: number };
    views: { gates: number };
    blockingGaps: number;
    advisoryGaps: number;
  };
  items: SurfaceItem[];
  blockingGaps: SurfaceItem[];
  advisoryGaps: SurfaceItem[];
}

/**
 * Build the full coverage matrix. `generatedAt` is injected (not read from the
 * clock) so callers control determinism of the emitted report.
 */
export function buildCoverageMatrix(options?: {
  root?: string;
  generatedAt?: string;
}): CoverageMatrix {
  const root = options?.root ?? REPO_ROOT;
  const generatedAt = options?.generatedAt ?? "1970-01-01T00:00:00.000Z";
  const items: SurfaceItem[] = [];

  // ── Slash commands ──────────────────────────────────────────────────────
  // The served catalog is the source of truth; coverage is satisfied
  // collectively by the full-catalog contract artifacts (which assert the exact
  // served set == getConnectorCommands), plus the navigate/client/agent dispatch
  // specs. We list each command for visibility but resolve them as one surface.
  const commands = getConnectorCommands("gui");
  const commandCoverage = resolveCoverage(COMMAND_COVERAGE, root);
  let commandsCovered = 0;
  for (const command of commands) {
    const covered = commandCoverage.status === "covered";
    if (covered) commandsCovered += 1;
    items.push({
      id: `command:${command.name}`,
      kind: "command",
      status: commandCoverage.status,
      detail:
        commandCoverage.status === "covered"
          ? `target=${command.target.kind}; ${commandCoverage.detail}`
          : commandCoverage.detail,
      artifacts: commandCoverage.artifacts,
      blocking: true,
      meta: { targetKind: command.target.kind },
    });
  }

  // ── Shortcuts (#8791 — pre-LLM shortcut registry) ───────────────────────
  // While the registry is absent the surface is gated (empty + advisory). Once
  // #8791 lands at one of SHORTCUT_REGISTRY_HINTS it lights up and the gate
  // requires shortcut coverage, resolved from SHORTCUT_COVERAGE against the real
  // shortcut-gate e2e (runShortcutGate driving a real AgentRuntime).
  const shortcutRegistry = discoverShortcutRegistry(root);
  const shortcutSurfaces =
    shortcutRegistry.length === 0 ? [] : discoverCommandShortcutSurfaces();
  const shortcutsGated = shortcutRegistry.length === 0;
  let shortcutsCovered = 0;
  if (!shortcutsGated) {
    for (const shortcut of shortcutSurfaces) {
      const resolution = resolveCoverage(
        SHORTCUT_COVERAGE.status === "covered"
          ? {
              ...SHORTCUT_COVERAGE,
              signals: [...SHORTCUT_COVERAGE.signals, shortcut.signal],
            }
          : SHORTCUT_COVERAGE,
        root,
      );
      if (resolution.status === "covered") shortcutsCovered += 1;
      items.push({
        id: `shortcut:${shortcut.signal}`,
        kind: "shortcut",
        status: resolution.status,
        detail: `#8791 shortcut registry present (${shortcutRegistry.join(", ")}); alias=${shortcut.alias}; target=${shortcut.targetKind}:${shortcut.targetName}; ${resolution.detail}`,
        artifacts: resolution.artifacts,
        // A landed registry with no real e2e is a blocking gap (the contract:
        // every shortcut alias/target has deterministic e2e evidence).
        blocking: resolution.status !== "covered",
        meta: {
          registry: shortcutRegistry,
          shortcutId: shortcut.shortcutId,
          alias: shortcut.alias,
          targetKind: shortcut.targetKind,
          targetName: shortcut.targetName,
        },
      });
    }
  }

  // ── Plugin routes ───────────────────────────────────────────────────────
  const routePlugins = discoverRoutePlugins(root);
  let routesCovered = 0;
  let routesExempt = 0;
  for (const { plugin, wiring } of routePlugins) {
    const resolution = resolveCoverage(PLUGIN_ROUTE_COVERAGE[plugin], root);
    if (resolution.status === "covered") routesCovered += 1;
    if (resolution.status === "exempt") routesExempt += 1;
    items.push({
      id: `plugin-route:${plugin}`,
      kind: "plugin-route",
      status: resolution.status,
      detail: resolution.detail,
      artifacts: resolution.artifacts,
      blocking: true,
      meta: { wiring },
    });
  }

  // ── Views (delegated to the existing view gates — not re-implemented here) ─
  for (const gate of VIEW_COVERAGE_GATES) {
    const exists = existsSync(path.join(root, gate));
    items.push({
      id: `view-gate:${gate}`,
      kind: "view",
      status: exists ? "covered" : "missing",
      detail: exists
        ? "views covered by the existing view ship-gate (referenced, not re-implemented per #8796/#8797/#8798)"
        : `expected view gate file is missing: ${gate}`,
      artifacts: exists ? [gate] : [],
      blocking: true,
    });
  }

  const blockingGaps = items.filter(
    (item) => item.blocking && item.status === "missing",
  );
  const advisoryGaps = items.filter(
    (item) => !item.blocking && item.status === "missing",
  );

  return {
    schema: "eliza_e2e_coverage_matrix_v1",
    generatedAt,
    summary: {
      commands: { total: commands.length, covered: commandsCovered },
      shortcuts: {
        total: shortcutSurfaces.length,
        covered: shortcutsCovered,
        gated: shortcutsGated,
      },
      pluginRoutes: {
        total: routePlugins.length,
        covered: routesCovered,
        exempt: routesExempt,
      },
      views: { gates: VIEW_COVERAGE_GATES.length },
      blockingGaps: blockingGaps.length,
      advisoryGaps: advisoryGaps.length,
    },
    items,
    blockingGaps,
    advisoryGaps,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Per-plugin keyless-e2e coverage (issue #8801)
//
// "Keyless e2e" means a scenario that runs on a PR under the deterministic LLM
// proxy with zero credentials — i.e. a scenario in the
// `packages/scenario-runner/test/scenarios` deterministic corpus, or one in the
// big `packages/test/scenarios` corpus tagged `lane: "pr-deterministic"`. A
// plugin "has keyless e2e" when at least one such scenario names it in its
// `requires.plugins`. Detection is static (source read, no plugin import) so the
// inventory stays cheap and works even for plugins that cannot be imported under
// Node.
// ───────────────────────────────────────────────────────────────────────────

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
