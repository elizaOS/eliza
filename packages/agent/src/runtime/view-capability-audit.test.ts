/**
 * #8798 acceptance criterion 2 — STATIC view-capability audit.
 *
 * The runtime crawler under `scripts/view-audit/` walks a *running* shell and
 * checks every rendered control is agent-addressable. This is its source-static
 * complement: with no browser and no runtime it reads each registered plugin
 * view's `.tsx` source, enumerates the interactive controls it ships, and
 * asserts every control-bearing view exposes at least one of the three
 * reachability layers from the canonical contract
 * (`packages/ui/src/agent-surface/README.md` §"Canonical reachability contract"):
 *
 *   1. a universal agent-surface element  — `useAgentElement(...)` call site
 *   2. a declared `ViewCapability`        — `capabilities:` in the plugin entry
 *   3. a domain action in VIEW_ACTION_MAP — a non-empty entry for the view id
 *
 * It fails the moment someone adds a control-heavy view with no agent surface,
 * so the regression is caught in `bun run test` rather than only by the live
 * crawler. Cosmetic views (zero interactive controls) trivially pass.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  VIEW_ACTION_MAP,
  validateViewCoverage,
} from "./view-action-affinity.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");

/**
 * Map each audited view id → the plugin directory that owns its view source.
 * Only views whose `.tsx` actually live in a `plugins/<dir>/src` tree are listed
 * — host/built-in views (`lifeops`, `training`, `settings`) have no plugin
 * source to scan and are exercised through `validateViewCoverage` below instead.
 * Every key here is a real VIEW_ACTION_MAP entry (asserted in the suite) so this
 * stays a meaningful subset of the registered surface, not a parallel list.
 */
const VIEW_SOURCE_DIRS: Readonly<Record<string, string>> = {
  calendar: "plugin-calendar",
  wallet: "plugin-wallet-ui",
  health: "plugin-health",
  focus: "plugin-blocker",
  finances: "plugin-finances",
  inbox: "plugin-inbox",
  goals: "plugin-goals",
  todos: "plugin-todos",
  relationships: "plugin-relationships",
  documents: "plugin-documents",
  companion: "plugin-companion",
  orchestrator: "plugin-task-coordinator",
  facewear: "plugin-facewear",
  polymarket: "plugin-polymarket",
  hyperliquid: "plugin-hyperliquid",
  steward: "plugin-steward-app",
};

/** Recursively collect every production `.tsx` under a dir (no tests/stories). */
function collectViewTsx(dir: string): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      out.push(...collectViewTsx(full));
      continue;
    }
    if (!entry.name.endsWith(".tsx")) continue;
    if (
      entry.name.endsWith(".test.tsx") ||
      entry.name.endsWith(".stories.tsx")
    ) {
      continue;
    }
    out.push(full);
  }
  return out;
}

/** Plugin entry source where a `ViewDeclaration[]` (and any `capabilities:`) lives. */
function readPluginEntry(pluginDir: string): string {
  for (const name of ["plugin.ts", "index.ts"]) {
    const candidate = path.join(repoRoot, "plugins", pluginDir, "src", name);
    if (existsSync(candidate)) return readFileSync(candidate, "utf8");
  }
  return "";
}

interface ViewCoverage {
  viewId: string;
  pluginDir: string;
  files: number;
  /** onClick= / onSubmit= / <button / form input handlers across the view tsx. */
  controls: number;
  /** Layer 1 — `useAgentElement(...)` call sites (generic args allowed). */
  agentElements: number;
  /** Layer 2 — the plugin entry declares a `ViewCapability[]`. */
  hasCapabilities: boolean;
  /** Layer 3 — a non-empty VIEW_ACTION_MAP entry for the view id. */
  mappedActions: number;
}

// `onClick=` / `onSubmit=` are JSX handler attrs; `<button` is a native control;
// `onChange=` / `onInput=` are the form-input handlers the contract counts.
const CONTROL_RE = /onClick=|onSubmit=|<button|onChange=|onInput=/g;
// Allow `useAgentElement<HTMLButtonElement>({...})` — the generic precedes `(`.
const AGENT_ELEMENT_RE = /useAgentElement(?:<[^>]*>)?\(/g;
const countMatches = (src: string, re: RegExp): number =>
  src.match(re)?.length ?? 0;

const coverage: ViewCoverage[] = Object.entries(VIEW_SOURCE_DIRS).map(
  ([viewId, pluginDir]) => {
    const viewSrc = path.join(repoRoot, "plugins", pluginDir, "src");
    const files = collectViewTsx(viewSrc);
    const joined = files.map((f) => readFileSync(f, "utf8")).join("\n");
    const entry = readPluginEntry(pluginDir);
    return {
      viewId,
      pluginDir,
      files: files.length,
      controls: countMatches(joined, CONTROL_RE),
      agentElements: countMatches(joined, AGENT_ELEMENT_RE),
      hasCapabilities: /\bcapabilities:\s*\[/.test(entry),
      mappedActions: (VIEW_ACTION_MAP[viewId] ?? []).length,
    };
  },
);

const isReachable = (c: ViewCoverage): boolean =>
  c.agentElements > 0 || c.hasCapabilities || c.mappedActions > 0;

// Opt-in machine-readable export of the per-view coverage the audit computes.
// Off by default (the suite's behavior is unchanged when VIEW_AUDIT_REPORT is
// unset); set VIEW_AUDIT_REPORT=1 to also serialize the coverage array to JSON
// under the package test-output dir for CI dashboards / drift tracking. (#8798)
if (process.env.VIEW_AUDIT_REPORT) {
  const outDir = path.join(here, "../../test-output");
  mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, "view-capability-audit.json");
  writeFileSync(
    outFile,
    `${JSON.stringify(
      {
        issue: "#8798",
        generatedAt: new Date().toISOString(),
        viewCount: coverage.length,
        coverage: coverage.map((c) => ({ ...c, reachable: isReachable(c) })),
      },
      null,
      2,
    )}\n`,
  );
}

describe("static view-capability audit (#8798)", () => {
  it("every audited view id is a real VIEW_ACTION_MAP entry", () => {
    for (const viewId of Object.keys(VIEW_SOURCE_DIRS)) {
      expect(
        Object.hasOwn(VIEW_ACTION_MAP, viewId),
        `audited view "${viewId}" must be a registered VIEW_ACTION_MAP key`,
      ).toBe(true);
    }
  });

  it("every audited view's source dir exists and ships view .tsx", () => {
    for (const c of coverage) {
      expect(
        c.files,
        `${c.viewId} (plugins/${c.pluginDir}/src) has no production .tsx — stale mapping?`,
      ).toBeGreaterThan(0);
    }
  });

  // The load-bearing assertion: a control-bearing view must expose at least one
  // agent-reachable mechanism. This is the regression gate — adding a view full
  // of onClick handlers with no useAgentElement / ViewCapability / action entry
  // fails here, naming the view, its control count, and its zero reachability.
  it("every control-bearing view is agent-reachable", () => {
    const interactive = coverage.filter((c) => c.controls > 0);
    // Guard against a regex/path regression silently emptying the audit.
    expect(
      interactive.length,
      "no interactive views found — audit is not exercising real plugin source",
    ).toBeGreaterThan(0);

    const unreachable = interactive.filter((c) => !isReachable(c));
    expect(
      unreachable,
      unreachable
        .map(
          (c) =>
            `view "${c.viewId}" (plugins/${c.pluginDir}) ships ${c.controls} interactive control(s) ` +
            `but is agent-unreachable: useAgentElement=${c.agentElements}, ViewCapability=${c.hasCapabilities}, ` +
            `VIEW_ACTION_MAP actions=${c.mappedActions}. Add a useAgentElement element, a declared ` +
            `ViewCapability, or a VIEW_ACTION_MAP entry (see packages/ui/src/agent-surface/README.md §reachability).`,
        )
        .join("\n"),
    ).toEqual([]);
  });

  // Per-view sanity: a view with interactive controls MUST expose an agent
  // surface; a cosmetic (zero-control) view trivially satisfies the contract.
  // Single non-vacuous invariant — fails iff controls>0 AND unreachable.
  it.each(coverage)("$viewId — controls reach the agent", (c: ViewCoverage) => {
    expect(
      c.controls === 0 || isReachable(c),
      `view "${c.viewId}" has ${c.controls} control(s) but no agent surface ` +
        `(useAgentElement=${c.agentElements}, capabilities=${c.hasCapabilities}, actions=${c.mappedActions})`,
    ).toBe(true);
  });

  // Reuse the exported helper. Positive control proves the assertion has teeth:
  // an unmapped, capability-less sentinel MUST be reported uncovered. The real
  // audited set must then come back clean.
  it("validateViewCoverage flags an uncovered view and passes the audited set", () => {
    const registered = Object.keys(VIEW_SOURCE_DIRS);
    const withCapabilities = coverage
      .filter((c) => c.hasCapabilities)
      .map((c) => c.viewId);

    const sentinel = "__unmapped_sentinel_view__";
    const flagged = validateViewCoverage(
      [...registered, sentinel],
      withCapabilities,
      { warn: () => {} },
    );
    expect(flagged, "sentinel must surface as uncovered").toContain(sentinel);

    const warnings: string[] = [];
    const uncovered = validateViewCoverage(registered, withCapabilities, {
      warn: (m) => warnings.push(m),
    });
    expect(
      uncovered,
      `uncovered registered views: ${uncovered.join(", ")}`,
    ).toEqual([]);
    expect(warnings).toEqual([]);
  });
});
