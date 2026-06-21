/**
 * Canonical e2e coverage inventory for issue #8802.
 *
 * Enumerates, from real source, every surface that ships a behavioural effect a
 * user can trigger — slash commands, pre-LLM shortcuts (#8791), plugin-declared
 * HTTP routes, and views — then cross-checks each against the committed coverage
 * manifest (`./manifest.ts`). A surface item is "covered" only when a real test
 * artifact exists AND contains a declared signal string (the anti-larp check: a
 * shape-only unit test that never names the real handler does not count). Items
 * may instead be `exempt` with a written justification.
 *
 * This module is the single source of truth for both the ship-gate
 * (`packages/scripts/__tests__/e2e-coverage.test.ts`) and the report CLI
 * (`packages/scripts/check-e2e-coverage.ts`). It performs no network or runtime
 * boot — it imports the dependency-light `getConnectorCommands` projection and
 * statically scans the plugin tree.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// Dependency-light: connector-catalog only imports ./registry + ./settings-sections
// + ./types (a type-only `@elizaos/core` import that erases at compile), so this
// pulls no runtime framework code.
import { getConnectorCommands } from "../../../plugins/plugin-commands/src/connector-catalog.ts";
import type { ManifestEntry } from "./manifest.ts";
import {
  COMMAND_COVERAGE,
  LARP_TEST_ARTIFACTS,
  PLUGIN_ROUTE_COVERAGE,
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
    if (!hasAnyTestFile(dir)) zero.push(plugin);
  }
  return zero.sort();
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
  // The registry does not exist yet, so the surface is empty and advisory. When
  // #8791 lands at one of SHORTCUT_REGISTRY_HINTS, this lights up and the gate
  // begins requiring shortcut coverage.
  const shortcutRegistry = discoverShortcutRegistry(root);
  const shortcutsGated = shortcutRegistry.length === 0;
  if (!shortcutsGated) {
    items.push({
      id: "shortcut:registry",
      kind: "shortcut",
      status: "missing",
      detail: `#8791 shortcut registry present (${shortcutRegistry.join(", ")}) but no shortcut coverage manifest exists yet`,
      artifacts: [],
      blocking: false, // advisory until shortcut coverage is wired
      meta: { registry: shortcutRegistry },
    });
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
        total: shortcutRegistry.length,
        covered: 0,
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
