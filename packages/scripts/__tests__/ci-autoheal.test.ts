/**
 * Exercises the pure decision and briefing logic of the CI auto-heal pipeline
 * (ci-autoheal-context.mjs, ci-autoheal-merge.mjs). These functions gate an
 * agent that opens and merges pull requests without a human, so every refusal
 * path is asserted here against a deterministic in-memory harness — no network,
 * no mocks of the module under test.
 */

import { describe, expect, test } from "bun:test";

import {
  AUTOHEAL_BRANCH_PREFIX,
  DEFAULT_MAX_ATTEMPTS,
  decide,
  excerptFailureLog,
  healBranchFor,
  renderBriefing,
  slugifyWorkflow,
  stripLogTimestamps,
} from "../ci-autoheal-context.mjs";
import {
  evaluateMergeReadiness,
  MERGE_BLOCKED,
  MERGE_READY,
  MERGE_WAIT,
  REQUIRED_GATE_CHECK,
} from "../ci-autoheal-merge.mjs";

function failedRun(overrides: Record<string, unknown> = {}) {
  return {
    status: "completed",
    conclusion: "failure",
    head_branch: "develop",
    head_sha: "abc123",
    name: "Develop PR",
    event: "push",
    html_url: "https://github.com/elizaOS/eliza/actions/runs/1",
    ...overrides,
  };
}

describe("slugifyWorkflow / healBranchFor", () => {
  test("produces branch-safe, collision-resistant slugs", () => {
    expect(slugifyWorkflow("Develop PR Gate")).toBe("develop-pr-gate");
    expect(slugifyWorkflow("ci")).toBe("ci");
    expect(slugifyWorkflow("Quality (Extended)")).toBe("quality-extended");
    expect(slugifyWorkflow("Develop PR")).not.toBe(
      slugifyWorkflow("Develop PR Gate"),
    );
    expect(healBranchFor("Develop PR")).toBe(
      `${AUTOHEAL_BRANCH_PREFIX}develop-pr`,
    );
  });

  test("rejects names that slug to nothing", () => {
    expect(() => slugifyWorkflow("™®")).toThrow(/empty slug/);
  });
});

describe("decide", () => {
  test("heals a completed failure on develop", () => {
    const verdict = decide({ run: failedRun(), openHealPr: null, attempt: 1 });
    expect(verdict.proceed).toBe(true);
  });

  test("refuses success, cancelled, and in-progress runs", () => {
    expect(
      decide({
        run: failedRun({ conclusion: "success" }),
        openHealPr: null,
        attempt: 1,
      }).proceed,
    ).toBe(false);
    expect(
      decide({
        run: failedRun({ conclusion: "cancelled" }),
        openHealPr: null,
        attempt: 1,
      }).proceed,
    ).toBe(false);
    expect(
      decide({
        run: failedRun({ status: "in_progress", conclusion: null }),
        openHealPr: null,
        attempt: 1,
      }).proceed,
    ).toBe(false);
  });

  test("refuses branches auto-heal does not own", () => {
    for (const branch of ["main", "feat/foo", "release/1.2", null]) {
      const verdict = decide({
        run: failedRun({ head_branch: branch }),
        openHealPr: null,
        attempt: 1,
      });
      expect(verdict.proceed).toBe(false);
      expect(verdict.reason).toContain("not healable");
    }
  });

  test("allows re-heal of its own heal branch (fix-the-fix)", () => {
    const verdict = decide({
      run: failedRun({ head_branch: `${AUTOHEAL_BRANCH_PREFIX}develop-pr` }),
      openHealPr: { number: 9 },
      attempt: 2,
    });
    expect(verdict.proceed).toBe(true);
  });

  test("enforces the attempt ceiling", () => {
    const verdict = decide({
      run: failedRun(),
      openHealPr: null,
      attempt: DEFAULT_MAX_ATTEMPTS + 1,
    });
    expect(verdict.proceed).toBe(false);
    expect(verdict.reason).toContain("human");
  });

  test("refuses a second concurrent heal of the same workflow", () => {
    const verdict = decide({
      run: failedRun(),
      openHealPr: { number: 17 },
      attempt: 1,
    });
    expect(verdict.proceed).toBe(false);
    expect(verdict.reason).toContain("#17");
  });
});

describe("excerptFailureLog", () => {
  test("strips timestamps and keeps error regions with context", () => {
    const noise = Array.from(
      { length: 200 },
      (_, i) => `2026-07-30T10:00:00.0000000Z setup line ${i}`,
    );
    const log = [
      ...noise,
      "2026-07-30T10:00:01.0000000Z src/foo.ts:12:5 - error TS2345: bad argument",
      ...Array.from(
        { length: 100 },
        (_, i) => `2026-07-30T10:00:02.0000000Z more output ${i}`,
      ),
    ].join("\n");
    const result = excerptFailureLog(log);
    expect(result.excerpt).toContain("error TS2345");
    expect(result.excerpt).not.toContain("2026-07-30T10:00:01");
    // context precedes the hit
    expect(result.excerpt).toContain("setup line 199");
    // far-away noise is dropped
    expect(result.excerpt).not.toContain("setup line 10\t");
    expect(result.matchedErrors).toBe(1);
    expect(result.totalLines).toBe(301);
  });

  test("always keeps the tail even without error matches", () => {
    const log = Array.from({ length: 500 }, (_, i) => `plain line ${i}`).join(
      "\n",
    );
    const result = excerptFailureLog(log);
    expect(result.excerpt).toContain("plain line 499");
    expect(result.excerpt).not.toContain("plain line 100\t");
  });

  test("honors the character budget and reports truncation", () => {
    const log = Array.from(
      { length: 3000 },
      (_, i) =>
        `##[error] failure number ${i} with a reasonably long explanatory suffix`,
    ).join("\n");
    const result = excerptFailureLog(log, 5_000);
    expect(result.truncated).toBe(true);
    expect(result.excerpt.length).toBeLessThanOrEqual(5_000 + 40);
    expect(result.excerpt).toContain("[excerpt truncated]");
  });

  test("recognizes the toolchain's failure shapes", () => {
    const shapes = [
      "##[error]Process completed with exit code 1.",
      "error TS2322: Type 'string' is not assignable",
      " FAIL  packages/core/src/foo.test.ts",
      "AssertionError: expected 1 to be 2",
      "npm ERR! code ELIFECYCLE",
      "Segmentation fault (core dumped)",
    ];
    for (const shape of shapes) {
      expect(excerptFailureLog(shape).matchedErrors).toBeGreaterThan(0);
    }
  });

  test("stripLogTimestamps only strips leading ISO stamps", () => {
    expect(stripLogTimestamps("2026-07-30T10:00:00.123Z hello")).toBe("hello");
    expect(stripLogTimestamps("keep 2026-07-30T10:00:00.123Z inline")).toBe(
      "keep 2026-07-30T10:00:00.123Z inline",
    );
  });
});

describe("renderBriefing", () => {
  test("carries run identity, attempt budget, prior attempt, and logs", () => {
    const briefing = renderBriefing({
      run: failedRun({
        path: ".github/workflows/develop-pr.yml",
        run_attempt: 2,
      }),
      failures: [
        {
          jobName: "typecheck",
          jobUrl: "https://github.com/x/y/runs/5",
          failedSteps: ["Run typecheck"],
          log: {
            excerpt: "42\terror TS2345: boom",
            truncated: false,
            keptLines: 1,
            totalLines: 900,
            matchedErrors: 1,
          },
        },
        {
          jobName: "lint",
          jobUrl: "https://github.com/x/y/runs/6",
          failedSteps: [],
          log: null,
          logError: "GitHub API 410",
        },
      ],
      attempt: 2,
      maxAttempts: 3,
      priorPr: { number: 101, state: "closed" },
    });
    expect(briefing).toContain("attempt 2");
    expect(briefing).toContain("Heal attempt: 2 of 3");
    expect(briefing).toContain("#101");
    expect(briefing).toContain("error TS2345: boom");
    expect(briefing).toContain("Log unavailable: GitHub API 410");
    expect(briefing).toContain("1 of 900 lines kept");
  });
});

describe("evaluateMergeReadiness", () => {
  function openPr(overrides: Record<string, unknown> = {}) {
    return {
      number: 7,
      state: "open",
      draft: false,
      mergeable: true,
      mergeable_state: "clean",
      ...overrides,
    };
  }
  const passingGate = {
    name: REQUIRED_GATE_CHECK,
    status: "completed",
    conclusion: "success",
    html_url: "https://github.com/x/y/runs/9",
  };

  test("merges only when the develop gate passed", () => {
    const verdict = evaluateMergeReadiness({
      pr: openPr(),
      checkRuns: [passingGate],
    });
    expect(verdict.action).toBe(MERGE_READY);
  });

  test("waits while the gate is absent or running", () => {
    expect(evaluateMergeReadiness({ pr: openPr(), checkRuns: [] }).action).toBe(
      MERGE_WAIT,
    );
    expect(
      evaluateMergeReadiness({
        pr: openPr(),
        checkRuns: [
          { ...passingGate, status: "in_progress", conclusion: null },
        ],
      }).action,
    ).toBe(MERGE_WAIT);
  });

  test("blocks on a failed gate and reports the run", () => {
    const verdict = evaluateMergeReadiness({
      pr: openPr(),
      checkRuns: [{ ...passingGate, conclusion: "failure" }],
    });
    expect(verdict.action).toBe(MERGE_BLOCKED);
    expect(verdict.gateUrl).toContain("/runs/9");
  });

  test("a lookalike check name does not satisfy the gate", () => {
    const verdict = evaluateMergeReadiness({
      pr: openPr(),
      checkRuns: [{ ...passingGate, name: "Develop PR Gate (fork)" }],
    });
    expect(verdict.action).toBe(MERGE_WAIT);
  });

  test("human CHANGES_REQUESTED always blocks, even over a green gate", () => {
    const verdict = evaluateMergeReadiness({
      pr: openPr(),
      checkRuns: [passingGate],
      reviews: [{ state: "CHANGES_REQUESTED" }, { state: "APPROVED" }],
    });
    expect(verdict.action).toBe(MERGE_BLOCKED);
    expect(verdict.reason).toContain("reviewer");
  });

  test("drafts wait; closed PRs block; conflicts block; unknown mergeability waits", () => {
    expect(
      evaluateMergeReadiness({
        pr: openPr({ draft: true }),
        checkRuns: [passingGate],
      }).action,
    ).toBe(MERGE_WAIT);
    expect(
      evaluateMergeReadiness({
        pr: openPr({ state: "closed" }),
        checkRuns: [passingGate],
      }).action,
    ).toBe(MERGE_BLOCKED);
    expect(
      evaluateMergeReadiness({
        pr: openPr({ mergeable: false, mergeable_state: "dirty" }),
        checkRuns: [passingGate],
      }).action,
    ).toBe(MERGE_BLOCKED);
    expect(
      evaluateMergeReadiness({
        pr: openPr({ mergeable: null, mergeable_state: "unknown" }),
        checkRuns: [passingGate],
      }).action,
    ).toBe(MERGE_WAIT);
    expect(
      evaluateMergeReadiness({
        pr: openPr({ mergeable_state: "behind" }),
        checkRuns: [passingGate],
      }).action,
    ).toBe(MERGE_WAIT);
  });
});
