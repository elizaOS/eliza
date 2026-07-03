/**
 * #8798 acceptance criterion 2 — STATIC view-capability audit (registration DENSITY).
 *
 * This is the source-static complement of the runtime crawler under
 * `scripts/view-audit/` (which walks a *running* shell and confirms every
 * *rendered* control is agent-addressable) and the agent-surface `__e2e__`
 * harness. With no browser, no runtime, and no mounted registry, it reads each
 * registered plugin view's `.tsx` source and asserts a per-view MINIMUM number
 * of agent-addressable element registrations proportional to that view's
 * interactive-control surface.
 *
 * What it PROVES — and ONLY this: a control-bearing view cannot ship a large
 * interactive surface while registering zero / too few agent-addressable
 * elements. It does NOT prove runtime hittability — that a given rendered
 * control is actually reachable end to end is the crawler's / e2e harness's job.
 *
 * Two agent-addressability dialects each count as a registration:
 *   1. DOM views     — `useAgentElement(...)` call sites (the ViewAgentRegistry).
 *   2. Spatial views — an `agent=` prop on a spatial primitive (`<Button
 *      agent=…>`, `<Field agent=…>`, `<VStack agent=…>`), which the spatial
 *      renderer emits as `data-agent-id`. A DOM-only grep is BLIND to these —
 *      they carry no `useAgentElement` call and few/no DOM handlers — so it
 *      would mis-read a fully-instrumented spatial view (e.g. `documents`,
 *      `inbox`, `goals`) as cosmetic and pass it for free.
 *
 * The gate fails a view whose registrations fall below
 * `ceil(controls / MAX_CONTROLS_PER_AGENT_ELEMENT)`. That catches the regression
 * the prior check advertised but could never see: it passed a control-heavy view
 * on a *single* `useAgentElement` occurrence anywhere — or, worse, on merely
 * having any view-action-affinity entry (which every audited view has, making
 * the old assertion unconditionally true). The control count is a conservative
 * lower-bound proxy over the dominant handler + spatial-primitive forms;
 * under-counting only relaxes the requirement, so it never causes a false
 * failure — it fails only on genuine under-instrumentation.
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
  registerPluginViews,
  unregisterPluginViews,
} from "../api/views-registry.ts";
import { validateViewCoverage } from "./view-action-affinity.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");

/**
 * Map each audited view id → the plugin directory that owns its view source.
 * Only views whose `.tsx` actually live in a `plugins/<dir>/src` tree are listed
 * — host/built-in views (`lifeops`, `training`, `settings`) have no plugin
 * source to scan and are exercised through `validateViewCoverage` below instead.
 * Every key here must declare relatedActions in its plugin entry (asserted in
 * the suite) so this stays a meaningful subset of the registered surface, not a
 * parallel list.
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
  orchestrator: "plugin-task-coordinator",
  facewear: "plugin-facewear",
  polymarket: "plugin-polymarket",
  hyperliquid: "plugin-hyperliquid",
};

/**
 * Spatial views — authored with the `@elizaos/ui/spatial` primitives, so they
 * instrument controls with an `agent=` prop (not `useAgentElement`) and carry
 * few/no DOM handlers. Listed so the suite can prove the spatial dialect is
 * actually exercised: a DOM-only grep would silently read every one of these as
 * cosmetic. (This is documentation of the audited set, not a second registry.)
 */
const SPATIAL_VIEWS: readonly string[] = [
  "documents",
  "inbox",
  "goals",
  "health",
  "finances",
  "relationships",
  "todos",
  "focus",
];

/**
 * Ceiling on interactive controls a view may ship per registered
 * agent-addressable element. The densest real audited view (`orchestrator`)
 * sits at ~2.7 controls per registration; a cap of 4 gives ~1.5× headroom over
 * it so ordinary view growth never false-fails, while still failing any view
 * that ships >4 controls per addressable id — and always failing a
 * control-bearing view with zero registrations.
 */
const MAX_CONTROLS_PER_AGENT_ELEMENT = 4;

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

// Interactive-control surface, both dialects — a conservative lower-bound proxy:
//   DOM handler / native control: onClick= / onSubmit= / onInput= / onChange= / <button
//   spatial interactive primitives: <Button / <Field (their onPress/onChange
//   handlers live inside @elizaos/ui, not the view source).
const CONTROL_RE =
  /onClick=|onSubmit=|onInput=|onChange=|<button\b|<Button\b|<Field\b/g;
// Agent-addressable element registrations, both dialects:
//   DOM:     useAgentElement(...) / useAgentElement<HTMLButtonElement>(...)
//   spatial: an `agent="…"` / `agent={…}` prop on a spatial primitive (rendered
//            to `data-agent-id`). The `\b` before `agent=` avoids matching
//            `userAgent=`; requiring `=` immediately after avoids `data-agent-id=`.
const AGENT_REGISTRATION_RE = /useAgentElement(?:<[^>]*>)?\(|\bagent=(?:"|\{)/g;
const countMatches = (src: string, re: RegExp): number =>
  src.match(re)?.length ?? 0;

function relatedActionCount(entry: string): number {
  const match = entry.match(/\brelatedActions:\s*\[([\s\S]*?)\]/);
  if (!match) return 0;
  return match[1].match(/"[^"]+"/g)?.length ?? 0;
}

/** Static measure of a view's control surface and agent-element registrations. */
interface SourceMeasure {
  /** Interactive controls detected across both dialects (lower-bound proxy). */
  controls: number;
  /** Agent-addressable registrations: `useAgentElement(` + spatial `agent=`. */
  agentRegistrations: number;
}

function measureSource(src: string): SourceMeasure {
  return {
    controls: countMatches(src, CONTROL_RE),
    agentRegistrations: countMatches(src, AGENT_REGISTRATION_RE),
  };
}

/** Minimum registrations a view with `controls` controls must expose. */
function requiredAgentRegistrations(controls: number): number {
  return controls === 0
    ? 0
    : Math.ceil(controls / MAX_CONTROLS_PER_AGENT_ELEMENT);
}

/** The load-bearing invariant: registrations scale with the control surface. */
function meetsRegistrationDensity(m: SourceMeasure): boolean {
  return m.agentRegistrations >= requiredAgentRegistrations(m.controls);
}

interface ViewCoverage extends SourceMeasure {
  viewId: string;
  pluginDir: string;
  files: number;
  /** Minimum registrations required for this view's control count. */
  requiredRegistrations: number;
  /** The plugin entry declares a `ViewCapability[]` (reported, not gated on). */
  hasCapabilities: boolean;
  /** Non-empty relatedActions declaration for the view id. */
  relatedActions: number;
}

const coverage: ViewCoverage[] = Object.entries(VIEW_SOURCE_DIRS).map(
  ([viewId, pluginDir]) => {
    const viewSrc = path.join(repoRoot, "plugins", pluginDir, "src");
    const files = collectViewTsx(viewSrc);
    const joined = files.map((f) => readFileSync(f, "utf8")).join("\n");
    const entry = readPluginEntry(pluginDir);
    const measure = measureSource(joined);
    return {
      viewId,
      pluginDir,
      files: files.length,
      controls: measure.controls,
      agentRegistrations: measure.agentRegistrations,
      requiredRegistrations: requiredAgentRegistrations(measure.controls),
      hasCapabilities: /\bcapabilities:\s*\[/.test(entry),
      relatedActions: relatedActionCount(entry),
    };
  },
);

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
        maxControlsPerAgentElement: MAX_CONTROLS_PER_AGENT_ELEMENT,
        viewCount: coverage.length,
        coverage: coverage.map((c) => ({
          ...c,
          meetsDensity: meetsRegistrationDensity(c),
        })),
      },
      null,
      2,
    )}\n`,
  );
}

describe("static view-capability audit (#8798)", () => {
  it("every audited plugin view declares relatedActions", () => {
    for (const c of coverage) {
      expect(
        c.relatedActions,
        `audited view "${c.viewId}" must declare relatedActions in plugins/${c.pluginDir}/src`,
      ).toBeGreaterThan(0);
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

  // The audit must see BOTH dialects. A DOM-only grep reads every spatial view
  // as a zero-control cosmetic view and passes it for free; assert the spatial
  // set is detected as control-bearing AND instrumented, so the gate below is
  // actually exercising them rather than skipping them.
  it("sees the interactive surface of both DOM and spatial views", () => {
    const interactive = coverage.filter((c) => c.controls > 0);
    expect(
      interactive.length,
      "no interactive views found — audit is not exercising real plugin source",
    ).toBeGreaterThan(0);

    for (const id of SPATIAL_VIEWS) {
      const c = coverage.find((v) => v.viewId === id);
      if (!c) throw new Error(`spatial view "${id}" missing from coverage`);
      expect(
        c.controls,
        `spatial view "${id}" should register interactive controls (spatial <Button>/<Field>)`,
      ).toBeGreaterThan(0);
      expect(
        c.agentRegistrations,
        `spatial view "${id}" should register agent-addressable elements via an agent= prop`,
      ).toBeGreaterThan(0);
    }
  });

  // The load-bearing assertion: a control-bearing view must register
  // agent-addressable elements in proportion to its control surface (>= one
  // registration per MAX_CONTROLS_PER_AGENT_ELEMENT controls). This is the
  // regression gate — a view full of controls with zero/too-few useAgentElement
  // or spatial agent= registrations fails here, naming the view, its control
  // count, its registration count, and the minimum it must meet.
  it("every control-bearing view registers agent elements proportional to its control surface", () => {
    const interactive = coverage.filter((c) => c.controls > 0);
    const underInstrumented = interactive.filter(
      (c) => !meetsRegistrationDensity(c),
    );
    expect(
      underInstrumented,
      underInstrumented
        .map(
          (c) =>
            `view "${c.viewId}" (plugins/${c.pluginDir}) ships ${c.controls} interactive control(s) ` +
            `but registers only ${c.agentRegistrations} agent-addressable element(s) — needs >= ` +
            `${c.requiredRegistrations} (at most ${MAX_CONTROLS_PER_AGENT_ELEMENT} controls per registration). ` +
            `Instrument controls with useAgentElement (DOM) or an agent= prop on the spatial primitive ` +
            `(see packages/ui/src/agent-surface/README.md §"Converting a view").`,
        )
        .join("\n"),
    ).toEqual([]);
  });

  // Per-view: registration density holds. A cosmetic (zero-control) view
  // trivially satisfies it; a control-bearing view must meet the proportional
  // minimum. Fails iff controls>0 AND registrations < ceil(controls / cap).
  it.each(
    coverage,
  )("$viewId — registers agent elements proportional to its controls", (c: ViewCoverage) => {
    expect(
      meetsRegistrationDensity(c),
      `view "${c.viewId}" ships ${c.controls} control(s) but only ` +
        `${c.agentRegistrations} agent registration(s) (needs >= ${c.requiredRegistrations})`,
    ).toBe(true);
  });

  // Positive control — prove the density gate has teeth, exercising the SAME
  // measureSource + meetsRegistrationDensity the real audit uses (no parallel
  // reimplementation). Critically: a control-heavy view with a SINGLE
  // registration fails — the exact case the old "≥1 useAgentElement anywhere /
  // any view-action-affinity entry passes" check let through.
  it("registration-density gate has teeth (both dialects)", () => {
    // 8 controls, exactly 1 registration — the regression the old check missed.
    const oneRegManyControls = measureSource(
      `${Array.from({ length: 8 }, (_, i) => `<button>b${i}</button>`).join(
        "\n",
      )}\nuseAgentElement({ id: "only-one", role: "button", label: "x" })`,
    );
    expect(oneRegManyControls.controls).toBe(8);
    expect(oneRegManyControls.agentRegistrations).toBe(1);
    expect(meetsRegistrationDensity(oneRegManyControls)).toBe(false);

    // Spatial: 8 <Button> primitives, zero agent= props → unaddressable.
    const spatialUnder = measureSource(
      Array.from({ length: 8 }, (_, i) => `<Button>b${i}</Button>`).join("\n"),
    );
    expect(spatialUnder.controls).toBe(8);
    expect(spatialUnder.agentRegistrations).toBe(0);
    expect(meetsRegistrationDensity(spatialUnder)).toBe(false);

    // DOM well-instrumented: a useAgentElement per control passes.
    const domOk = measureSource(
      Array.from(
        { length: 4 },
        (_, i) => `useAgentElement({ id: "b${i}" });\n<button>b${i}</button>`,
      ).join("\n"),
    );
    expect(domOk.controls).toBe(4);
    expect(domOk.agentRegistrations).toBe(4);
    expect(meetsRegistrationDensity(domOk)).toBe(true);

    // Spatial well-instrumented: an agent= prop on every <Button> passes.
    const spatialOk = measureSource(
      Array.from(
        { length: 8 },
        (_, i) => `<Button agent="b${i}">b${i}</Button>`,
      ).join("\n"),
    );
    expect(spatialOk.controls).toBe(8);
    expect(spatialOk.agentRegistrations).toBe(8);
    expect(meetsRegistrationDensity(spatialOk)).toBe(true);

    // Cosmetic (zero controls) trivially passes.
    const cosmetic = measureSource('<Text tone="muted">Just a label</Text>');
    expect(cosmetic.controls).toBe(0);
    expect(meetsRegistrationDensity(cosmetic)).toBe(true);
  });

  // Reuse the exported helper. Positive control proves the assertion has teeth:
  // an unmapped, capability-less sentinel MUST be reported uncovered. The real
  // audited set must then come back clean.
  it("validateViewCoverage flags an uncovered view and passes the audited set", async () => {
    const pluginName = "@test/view-capability-audit";
    await registerPluginViews({
      name: pluginName,
      description: "Synthetic view capability audit fixtures.",
      views: coverage.map((c) => ({
        id: c.viewId,
        label: c.viewId,
        relatedActions: ["__STATIC_AUDIT_ACTION__"],
      })),
    });
    const registered = Object.keys(VIEW_SOURCE_DIRS);
    const withCapabilities = coverage
      .filter((c) => c.hasCapabilities)
      .map((c) => c.viewId);

    try {
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
    } finally {
      unregisterPluginViews(pluginName);
    }
  });
});
