/**
 * Unit tests for the cold-boot TTI + build-time regression gate. Fixtures mirror
 * the real `capture-startup-trace.mjs` artifact shape (runs[].timeline of
 * {name, atMs}) and the `run-mobile-build.mjs` timing json; the harness is
 * deterministic (no browser, no device) so the gate's grading logic is pinned
 * independent of an actual boot capture.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
// The gate ships as a Node CLI (.mjs) so it runs without a TS toolchain on CI;
// vitest imports its exported pure functions directly.
import {
  computeRegressionPct,
  DEFAULT_TTI_MARKS,
  evaluateAll,
  evaluateMetric,
  extractTtiMark,
  METRIC_STATUS,
  selectColdRun,
  shouldPassAfterBaselineUpdate,
} from "./check-startup-budget.mjs";

// Resolve the CLI relative to this test file (a sibling .mjs), not
// process.cwd(): the client test lane runs vitest from packages/app, so a
// cwd-relative "packages/app/..." path doubles into
// packages/app/packages/app/... and the spawned Node can't find the module.
// import.meta.dirname is a plain filesystem string, so it sidesteps jsdom's
// http base-URL override that breaks fileURLToPath(import.meta.url) here.
const SCRIPT_PATH = path.join(import.meta.dirname, "check-startup-budget.mjs");

function traceRun(kind: string, marks: Array<[string, number]>, extra = {}) {
  return {
    run: 0,
    kind,
    traceId: "t",
    timeline: marks.map(([name, atMs]) => ({ name, atMs, deltaMs: 0 })),
    ...extra,
  };
}

const COLD_TIMELINE: Array<[string, number]> = [
  ["module-eval", 0],
  ["main-start", 40],
  ["app-modules:start", 60],
  ["app-modules:end", 900],
  ["bridges:start", 910],
  ["bridges:end", 1200],
  ["react-mount:start", 1210],
  ["react-mount:end", 1600],
  ["startup-shell:mounted", 1850],
  ["coordinator:ready", 5200],
];

describe("selectColdRun", () => {
  it("prefers the cold run over warm runs", () => {
    const artifact = {
      runs: [
        traceRun("warm", [["startup-shell:mounted", 400]]),
        traceRun("cold", [["startup-shell:mounted", 1850]]),
      ],
    };
    expect(selectColdRun(artifact)?.kind).toBe("cold");
  });

  it("skips runs that errored (no trace on window)", () => {
    const artifact = {
      runs: [
        { run: 0, kind: "cold", error: "no __ELIZA_STARTUP_TRACE__" },
        traceRun("warm", [["startup-shell:mounted", 500]]),
      ],
    };
    // The only usable run is the warm one; a cold run that errored must not be
    // returned as a zero-time measurement.
    expect(selectColdRun(artifact)?.kind).toBe("warm");
  });

  it("returns null when there are no usable runs", () => {
    expect(selectColdRun({ runs: [] })).toBeNull();
    expect(selectColdRun({ runs: [{ error: "x" }] })).toBeNull();
    expect(selectColdRun(null)).toBeNull();
  });
});

describe("extractTtiMark", () => {
  it("returns the mounted mark as the usable-shell TTI", () => {
    const run = traceRun("cold", COLD_TIMELINE);
    expect(extractTtiMark(run)).toEqual({
      name: "startup-shell:mounted",
      atMs: 1850,
    });
  });

  it("falls back to first-paint then coordinator:ready by priority", () => {
    const noMounted = traceRun("cold", [
      ["module-eval", 0],
      ["startup-shell:first-paint", 2100],
      ["coordinator:ready", 5200],
    ]);
    expect(extractTtiMark(noMounted)?.name).toBe("startup-shell:first-paint");

    const onlyReady = traceRun("cold", [
      ["module-eval", 0],
      ["coordinator:ready", 5200],
    ]);
    expect(extractTtiMark(onlyReady)?.name).toBe("coordinator:ready");
  });

  it("returns null when no TTI mark is present (never fabricates 0)", () => {
    const stalled = traceRun("cold", [
      ["module-eval", 0],
      ["app-modules:start", 60],
    ]);
    expect(extractTtiMark(stalled)).toBeNull();
  });

  it("exposes the mark priority order", () => {
    expect(DEFAULT_TTI_MARKS[0]).toBe("startup-shell:mounted");
    expect(DEFAULT_TTI_MARKS).toContain("coordinator:ready");
  });
});

describe("computeRegressionPct", () => {
  it("is positive for a regression and negative for an improvement", () => {
    expect(computeRegressionPct(2200, 2000)).toBeCloseTo(10);
    expect(computeRegressionPct(1800, 2000)).toBeCloseTo(-10);
  });
  it("is null without a usable baseline", () => {
    expect(computeRegressionPct(2000, null)).toBeNull();
    expect(computeRegressionPct(2000, 0)).toBeNull();
  });
});

describe("evaluateMetric", () => {
  const budgetEntry = { budgetMs: 4000, baselineMs: 2000 };

  it("passes within budget and within tolerance of baseline", () => {
    const r = evaluateMetric({
      category: "tti",
      target: "ci-web",
      valueMs: 2100,
      budgetEntry,
      tolerancePct: 15,
    });
    expect(r.status).toBe(METRIC_STATUS.PASS);
  });

  it("fails when over the hard budget ceiling", () => {
    const r = evaluateMetric({
      category: "tti",
      target: "ci-web",
      valueMs: 4200,
      budgetEntry,
      tolerancePct: 15,
    });
    expect(r.status).toBe(METRIC_STATUS.OVER_BUDGET);
  });

  it("fails on a baseline regression past tolerance even while under budget", () => {
    const r = evaluateMetric({
      category: "tti",
      target: "ci-web",
      valueMs: 2400, // +20% vs 2000 baseline, still under 4000 budget
      budgetEntry,
      tolerancePct: 15,
    });
    expect(r.status).toBe(METRIC_STATUS.REGRESSED);
    expect(r.regressionPct).toBeCloseTo(20);
  });

  it("treats an absent measurement as a failure, not a pass", () => {
    const r = evaluateMetric({
      category: "tti",
      target: "ci-web",
      valueMs: Number.NaN,
      budgetEntry,
      tolerancePct: 15,
    });
    expect(r.status).toBe(METRIC_STATUS.MISSING_METRIC);
  });

  it("fails when the budget entry is missing", () => {
    const r = evaluateMetric({
      category: "tti",
      target: "unknown-device",
      valueMs: 1000,
      budgetEntry: undefined,
      tolerancePct: 15,
    });
    expect(r.status).toBe(METRIC_STATUS.MISSING_BUDGET);
  });

  it("passes with no baseline recorded (budget-only gating)", () => {
    const r = evaluateMetric({
      category: "tti",
      target: "ci-web",
      valueMs: 3000,
      budgetEntry: { budgetMs: 4000, baselineMs: null },
      tolerancePct: 15,
    });
    expect(r.status).toBe(METRIC_STATUS.PASS);
  });
});

describe("evaluateAll", () => {
  const budgets = {
    tolerancePct: 15,
    tti: { "ci-web": { budgetMs: 4000, baselineMs: 2000 } },
    build: { "android-apk": { budgetMs: 900000, baselineMs: 600000 } },
  };

  it("ok=true only when every row passes", () => {
    const res = evaluateAll({
      metrics: [
        { category: "tti", target: "ci-web", valueMs: 2100 },
        { category: "build", target: "android-apk", valueMs: 620000 },
      ],
      budgets,
    });
    expect(res.ok).toBe(true);
    expect(res.rows).toHaveLength(2);
  });

  it("ok=false when any single row fails the gate", () => {
    const res = evaluateAll({
      metrics: [
        { category: "tti", target: "ci-web", valueMs: 2100 },
        { category: "build", target: "android-apk", valueMs: 950000 },
      ],
      budgets,
    });
    expect(res.ok).toBe(false);
  });

  it("uses the budgets-file tolerance when none is passed", () => {
    const res = evaluateAll({
      metrics: [{ category: "tti", target: "ci-web", valueMs: 2250 }], // +12.5%
      budgets: { ...budgets, tolerancePct: 10 },
    });
    // 12.5% > 10% file tolerance → regressed
    expect(res.tolerancePct).toBe(10);
    expect(res.rows[0].status).toBe(METRIC_STATUS.REGRESSED);
  });
});

describe("shouldPassAfterBaselineUpdate", () => {
  it("allows recording over-budget values when every metric updated a budget", () => {
    expect(
      shouldPassAfterBaselineUpdate(
        [
          {
            category: "tti",
            target: "ci-web",
            status: METRIC_STATUS.OVER_BUDGET,
          },
        ],
        1,
      ),
    ).toBe(true);
  });

  it("fails recording runs that did not map every metric to a budget entry", () => {
    expect(
      shouldPassAfterBaselineUpdate(
        [
          {
            category: "build",
            target: "typo",
            status: METRIC_STATUS.MISSING_BUDGET,
          },
        ],
        0,
      ),
    ).toBe(false);
  });
});

describe("CLI baseline recording", () => {
  it("does not partially write baselines when one requested metric has no budget", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "startup-budget-"));
    const budgetsPath = path.join(dir, "budgets.json");
    writeFileSync(
      budgetsPath,
      `${JSON.stringify(
        {
          tolerancePct: 15,
          tti: { "ci-web": { budgetMs: 4000, baselineMs: null } },
        },
        null,
        2,
      )}\n`,
    );

    const result = spawnSync(
      process.execPath,
      [
        SCRIPT_PATH,
        "--budgets",
        budgetsPath,
        "--metric",
        "tti:ci-web=2300",
        "--metric",
        "tti:typo=2300",
        "--update-baseline",
      ],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Refusing to update baselines");
    const budgets = JSON.parse(readFileSync(budgetsPath, "utf8"));
    expect(budgets.tti["ci-web"].baselineMs).toBeNull();
  });
});
