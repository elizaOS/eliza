/**
 * Unit tests for the Launcher View Coverage app shell contract and coverage
 * guardrail.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type EnabledViewKinds, isViewVisible } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { BUILTIN_VIEWS } from "../../agent/src/api/builtin-views";

/**
 * Launcher-view e2e/smoke coverage gate (#10719, vitest, boot-free).
 *
 * Sibling to route-coverage.test.ts, but view-SPECIFIC: route-coverage proves
 * every reachable ROUTE has an all-pages smoke click; this proves every
 * default-LAUNCHER view (the tiles the /views grid renders from BUILTIN_VIEWS)
 * has a checked-in coverage entry — a smoke spec at minimum, plus the dedicated
 * e2e runner when one exists.
 *
 * The core acceptance criterion (issue #10719): adding a NEW launcher view to
 * BUILTIN_VIEWS without a coverage entry FAILS here. LAUNCHER_VIEW_COVERAGE is
 * the checked-in inventory the gate enforces; every launcher-visible view id
 * must appear in it, every referenced spec/runner file must exist on disk, and
 * every entry's smoke spec must actually cover the view's path in
 * builtin-views-visual.spec.ts (so the map can't drift from reality).
 *
 * Evidence lanes this gate DOES and DOES NOT enforce:
 *   - ENFORCED (automated, here): every launcher view is mapped, its spec/runner
 *     files exist, and its path is in the desktop+mobile screenshot-smoke matrix.
 *   - MANUAL / CI capture lane (NOT enforced here, tracked in
 *     docs/LAUNCHER_VIEW_COVERAGE.md): live full-page audit screenshots
 *     (`audit:app`), on-device captures (`capture:ios-sim` / `capture:android-emu`
 *     / desktop), and video walkthroughs. Those need a booted renderer / device
 *     and cannot run in cheap vitest.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");
const BUILTIN_VIEWS_VISUAL_SPEC = path.join(
  HERE,
  "ui-smoke",
  "builtin-views-visual.spec.ts",
);

/**
 * AOSP-ElizaOS-fork-only native device surfaces. `useAvailableViews` strips
 * these from the router + launcher on every other build (web, desktop, iOS,
 * stock Play-Store Android), so they are NOT default-launcher views and are not
 * gated here. Mirrors `NATIVE_OS_VIEW_IDS` in
 * packages/ui/src/hooks/useAvailableViews.ts — keep in sync.
 */
const NATIVE_OS_VIEW_IDS: ReadonlySet<string> = new Set([
  "phone",
  "messages",
  "contacts",
  "camera",
]);

/**
 * A view is a default-launcher view when the launcher filter would ever place
 * it in the /views grid. Replicates the predicate from `mergeViewCatalog`
 * (packages/ui/src/hooks/view-catalog.ts) + the native-OS strip in
 * `useAvailableViews`:
 *   - `visibleInManager !== false` (internal views are hidden), AND
 *   - not a native-OS-fork-only surface (stripped on the default builds).
 *
 * `viewKind`/`developerOnly` are NOT part of this predicate: developer/preview
 * views ARE launcher views — they render in the grid when the matching Settings
 * toggle is on (`isViewVisible` gates them per-toggle, not out of the launcher).
 * So they still require coverage.
 */
function isDefaultLauncherView(view: {
  id: string;
  visibleInManager?: boolean;
}): boolean {
  if (view.visibleInManager === false) return false;
  if (NATIVE_OS_VIEW_IDS.has(view.id)) return false;
  return true;
}

interface LauncherViewCoverage {
  /**
   * Smoke coverage: the desktop+mobile screenshot boot-smoke that guarantees the
   * view mounts without an uncaught page error at both viewports. Value is the
   * repo-relative path of the spec that covers it. Every launcher view MUST have
   * one — it is the floor.
   */
  smokeSpec: string;
  /**
   * Dedicated interaction/flow e2e runner, when one exists (bundles the real
   * view with esbuild → headless Chromium, drives real interactions, captures a
   * video). Absent for views whose only automated coverage is the boot-smoke.
   */
  e2e?: string;
}

const BUILTIN_VIEWS_VISUAL_SPEC_REL = path.relative(
  REPO_ROOT,
  BUILTIN_VIEWS_VISUAL_SPEC,
);

/**
 * The checked-in launcher-view coverage inventory. Every default-launcher view
 * id from BUILTIN_VIEWS MUST appear here. `smokeSpec` is the boot-smoke that
 * covers the view (asserted below to actually cover the view's path); `e2e`
 * names the dedicated interaction runner when one exists.
 *
 * Human-readable table + evidence-lane notes: docs/LAUNCHER_VIEW_COVERAGE.md.
 */
const LAUNCHER_VIEW_COVERAGE: Record<string, LauncherViewCoverage> = {
  chat: {
    smokeSpec: BUILTIN_VIEWS_VISUAL_SPEC_REL,
    e2e: "packages/ui/src/components/shell/__e2e__/run-chat-sheet-e2e.mjs",
  },
  character: { smokeSpec: BUILTIN_VIEWS_VISUAL_SPEC_REL },
  documents: { smokeSpec: BUILTIN_VIEWS_VISUAL_SPEC_REL },
  automations: { smokeSpec: BUILTIN_VIEWS_VISUAL_SPEC_REL },
  "plugins-page": { smokeSpec: BUILTIN_VIEWS_VISUAL_SPEC_REL },
  trajectories: { smokeSpec: BUILTIN_VIEWS_VISUAL_SPEC_REL },
  memories: { smokeSpec: BUILTIN_VIEWS_VISUAL_SPEC_REL },
  database: { smokeSpec: BUILTIN_VIEWS_VISUAL_SPEC_REL },
  logs: { smokeSpec: BUILTIN_VIEWS_VISUAL_SPEC_REL },
  settings: { smokeSpec: BUILTIN_VIEWS_VISUAL_SPEC_REL },
  background: {
    smokeSpec: BUILTIN_VIEWS_VISUAL_SPEC_REL,
    e2e: "packages/ui/src/components/pages/__e2e__/run-background-e2e.mjs",
  },
};

/** Repo-relative → path values the builtin-views-visual smoke spec covers. */
function smokeSpecCoveredPaths(specRelPath: string): Set<string> {
  const source = readFileSync(path.resolve(REPO_ROOT, specRelPath), "utf8");
  return new Set(
    [...source.matchAll(/path:\s*"([^"]+)"/g)].map((match) => match[1] ?? ""),
  );
}

function defaultLauncherViews() {
  return BUILTIN_VIEWS.filter(isDefaultLauncherView);
}

describe("launcher view coverage gate", () => {
  it("every default-launcher view is present in the coverage map", () => {
    const launcherViewIds = defaultLauncherViews().map((view) => view.id);
    const uncovered = launcherViewIds.filter(
      (id) => !(id in LAUNCHER_VIEW_COVERAGE),
    );

    expect(
      uncovered,
      [
        `New launcher view(s) added to BUILTIN_VIEWS without coverage: ${uncovered.join(", ")}.`,
        "To fix: (1) add a smoke case for the view's path to BUILTIN_VIEW_CASES in",
        "packages/app/test/ui-smoke/builtin-views-visual.spec.ts (and a dedicated",
        "e2e runner if the view has real interactions worth driving), then (2) add",
        "a LAUNCHER_VIEW_COVERAGE entry here and a row in",
        "packages/app/docs/LAUNCHER_VIEW_COVERAGE.md.",
      ].join(" "),
    ).toEqual([]);
  });

  it("coverage map has no stale entries (every mapped id is still a launcher view)", () => {
    const launcherViewIds = new Set(
      defaultLauncherViews().map((view) => view.id),
    );
    const stale = Object.keys(LAUNCHER_VIEW_COVERAGE).filter(
      (id) => !launcherViewIds.has(id),
    );

    expect(
      stale,
      `LAUNCHER_VIEW_COVERAGE references ids that are no longer default-launcher views: ${stale.join(", ")}. Remove them.`,
    ).toEqual([]);
  });

  it("every referenced smoke spec and e2e runner file exists on disk", () => {
    const missing: string[] = [];
    for (const [id, coverage] of Object.entries(LAUNCHER_VIEW_COVERAGE)) {
      const smokeAbs = path.resolve(REPO_ROOT, coverage.smokeSpec);
      if (!existsSync(smokeAbs)) {
        missing.push(`${id} smokeSpec ${coverage.smokeSpec}`);
      }
      if (coverage.e2e) {
        const e2eAbs = path.resolve(REPO_ROOT, coverage.e2e);
        if (!existsSync(e2eAbs)) {
          missing.push(`${id} e2e ${coverage.e2e}`);
        }
      }
    }

    expect(
      missing,
      `Coverage map references files that do not exist: ${missing.join(", ")}. Fix the path or add the missing spec/runner.`,
    ).toEqual([]);
  });

  it("every launcher view's smoke spec actually covers its declared path", () => {
    const byPathCache = new Map<string, Set<string>>();
    const failures: string[] = [];

    for (const view of defaultLauncherViews()) {
      const coverage = LAUNCHER_VIEW_COVERAGE[view.id];
      // Presence is asserted by a separate test; skip here so the failure is
      // reported once, by the right test.
      if (!coverage) continue;
      if (!view.path) {
        failures.push(`${view.id} has no path in BUILTIN_VIEWS`);
        continue;
      }
      let covered = byPathCache.get(coverage.smokeSpec);
      if (!covered) {
        covered = smokeSpecCoveredPaths(coverage.smokeSpec);
        byPathCache.set(coverage.smokeSpec, covered);
      }
      if (!covered.has(view.path)) {
        failures.push(
          `${view.id} (${view.path}) is not covered by ${coverage.smokeSpec}`,
        );
      }
    }

    expect(
      failures,
      [
        `Launcher view path(s) missing from their mapped smoke spec: ${failures.join("; ")}.`,
        "The smoke spec's BUILTIN_VIEW_CASES must include a case whose `path`",
        "matches the view's BUILTIN_VIEWS `path`.",
      ].join(" "),
    ).toEqual([]);
  });

  it("covers a stable, non-empty set of launcher views", () => {
    const launcherViewIds = defaultLauncherViews()
      .map((view) => view.id)
      .sort();
    // Guards against a bad predicate silently emptying the set (which would make
    // every other assertion trivially pass). This is the current default-launcher
    // roster; update it (and the doc) when BUILTIN_VIEWS changes intentionally.
    // `tutorial` was removed with the tutorial/help views (#14476); `transcripts`
    // folded into the Knowledge hub and is now `visibleInManager: false` (a
    // deep-link live-meeting surface, #13594/#11856), so neither is a default
    // launcher view anymore.
    expect(launcherViewIds).toEqual(
      [
        "automations",
        "background",
        "character",
        "chat",
        "database",
        "documents",
        "logs",
        "memories",
        "plugins-page",
        "settings",
        "trajectories",
      ].sort(),
    );
  });

  it("developer/preview launcher views are gated by their Settings toggle, not out of the launcher", () => {
    // A launcher view's per-build visibility is
    //   isDefaultLauncherView(v) && isViewVisible(v, enabledKinds).
    // Proving `isViewVisible` gates developer/preview views (rather than the
    // launcher predicate excluding them) is why the coverage map must still cover
    // them: they DO render in the grid when the toggle is on.
    const TOGGLES_OFF: EnabledViewKinds = { developer: false, preview: false };
    const TOGGLES_ON: EnabledViewKinds = { developer: true, preview: true };

    const gatedByToggle = defaultLauncherViews().filter(
      (view) =>
        !isViewVisible(view, TOGGLES_OFF) && isViewVisible(view, TOGGLES_ON),
    );
    const gatedIds = gatedByToggle.map((view) => view.id).sort();

    // trajectories/database/logs are developer-kind; background is preview-kind.
    expect(gatedIds).toEqual(
      ["background", "database", "logs", "trajectories"].sort(),
    );
    // Each toggle-gated view is still a default-launcher view and still covered.
    for (const view of gatedByToggle) {
      expect(
        LAUNCHER_VIEW_COVERAGE[view.id],
        `toggle-gated launcher view "${view.id}" must still be in the coverage map`,
      ).toBeDefined();
    }
  });
});
