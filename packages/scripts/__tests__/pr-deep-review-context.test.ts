/**
 * Exercises the pure analysis behind the deep PR review dossier
 * (pr-deep-review-context.mjs): bandaid-signal detection with diff line
 * mapping, changed-source-vs-test coverage pairing, linked-issue extraction,
 * and the rendered dossier's load-bearing claims.
 */

import { describe, expect, test } from "bun:test";

import {
  detectBandaidSignals,
  extractLinkedIssues,
  renderDossier,
  summarizeTestCoverage,
} from "../pr-deep-review-context.mjs";

function file(
  filename: string,
  patch?: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    filename,
    patch,
    status: "modified",
    additions: 1,
    deletions: 1,
    ...overrides,
  };
}

describe("detectBandaidSignals", () => {
  test("flags skipped tests, deleted assertions, and swallowed errors with locations", () => {
    const patch = [
      "@@ -10,4 +10,5 @@",
      " context line",
      "+it.skip('was failing', () => {",
      "-  expect(result).toBe(4);",
      "+  try { run(); } catch (err) {}",
      " tail",
    ].join("\n");
    const signals = detectBandaidSignals([
      file("packages/core/src/foo.test.ts", patch),
    ]);
    const ids = signals.map((signal) => signal.id);
    expect(ids).toContain("disabled-test");
    expect(ids).toContain("removed-assertion");
    expect(ids).toContain("swallowed-error");

    const skip = signals.find((signal) => signal.id === "disabled-test");
    expect(skip?.file).toBe("packages/core/src/foo.test.ts");
    // hunk starts at +10; context is 10, the added skip is 11
    expect(skip?.line).toBe(11);
    const removed = signals.find((signal) => signal.id === "removed-assertion");
    expect(removed?.line).toBeNull();
  });

  test("flags fabricated defaults, weakened types, and CI failure masks", () => {
    const patch = [
      "@@ -1,2 +1,5 @@",
      "+const total = payload.total ?? 0;",
      "+const data = response as unknown as Report;",
      "+        continue-on-error: true",
      "+  run: bun test || true",
    ].join("\n");
    const ids = detectBandaidSignals([
      file("packages/core/src/report.ts", patch),
    ]).map((signal) => signal.id);
    expect(ids).toContain("fabricated-default");
    expect(ids).toContain("weakened-type");
    expect(ids).toContain("ci-failure-mask");
  });

  test("flags enlarged timeouts and focused tests", () => {
    const patch = [
      "@@ -1,1 +1,3 @@",
      "+await waitFor(() => ready, { timeout: 30000 });",
      "+test.only('just this one', () => {});",
    ].join("\n");
    const ids = detectBandaidSignals([
      file("packages/app/src/e2e/x.test.ts", patch),
    ]).map((signal) => signal.id);
    expect(ids).toContain("loosened-timing");
    expect(ids).toContain("focused-test");
  });

  test("stays quiet on an ordinary fix", () => {
    const patch = [
      "@@ -5,3 +5,4 @@",
      " function add(a: number, b: number) {",
      "-  return a - b;",
      "+  return a + b;",
      " }",
    ].join("\n");
    expect(
      detectBandaidSignals([file("packages/core/src/math.ts", patch)]),
    ).toEqual([]);
  });

  test("ignores files with no patch payload (binary, huge)", () => {
    expect(detectBandaidSignals([file("assets/logo.png", undefined)])).toEqual(
      [],
    );
  });
});

describe("summarizeTestCoverage", () => {
  test("pairs sources with same-stem tests across directory layouts", () => {
    const coverage = summarizeTestCoverage([
      file("packages/core/src/runtime.ts"),
      file("packages/core/src/__tests__/runtime.test.ts"),
      file("packages/agent/src/loader.ts"),
    ]);
    expect(coverage.changedSourceCount).toBe(2);
    expect(coverage.testFileCount).toBe(1);
    expect(coverage.uncovered).toEqual(["packages/agent/src/loader.ts"]);
  });

  test("non-behavioral files need no coverage", () => {
    const coverage = summarizeTestCoverage([
      file("README.md"),
      file(".github/workflows/ci.yaml"),
      file("packages/core/package.json"),
      file("docs/guide.mdx"),
    ]);
    expect(coverage.changedSourceCount).toBe(0);
    expect(coverage.uncovered).toEqual([]);
  });

  test("colocated foo.test.ts counts as covering foo.ts", () => {
    const coverage = summarizeTestCoverage([
      file("packages/scripts/ci-autoheal-context.mjs"),
      file("packages/scripts/ci-autoheal-context.test.mjs"),
    ]);
    expect(coverage.uncovered).toEqual([]);
  });
});

describe("extractLinkedIssues", () => {
  test("finds #refs and full URLs, deduped and sorted", () => {
    const body = [
      "Fixes #1234 and relates to #999.",
      "See https://github.com/elizaOS/eliza/issues/1234 and",
      "https://github.com/elizaOS/eliza/pull/17338.",
    ].join("\n");
    expect(extractLinkedIssues(body)).toEqual([999, 1234, 17338]);
  });

  test("ignores short numbers and empty bodies", () => {
    expect(extractLinkedIssues("bullet #1 and #22")).toEqual([]);
    expect(extractLinkedIssues(null)).toEqual([]);
  });
});

describe("renderDossier", () => {
  const basePr = {
    number: 42,
    title: "fix(core): stop dropping messages",
    user: { login: "dev" },
    base: { ref: "develop" },
    head: { sha: "deadbeef" },
    additions: 10,
    deletions: 2,
    changed_files: 2,
    commits: 1,
    draft: false,
    mergeable_state: "clean",
    body: "Fixes #1234",
  };

  test("surfaces failing evidence rows, red checks, gaps, and prior comments", () => {
    const dossier = renderDossier({
      pr: basePr,
      files: [file("packages/core/src/bus.ts")],
      evidence: {
        ok: false,
        findings: [
          { id: "backend-logs", label: "Backend logs", status: "blank" },
          { id: "after-screenshots", label: "After screenshots", status: "ok" },
        ],
      },
      checks: [
        {
          name: "typecheck",
          status: "completed",
          conclusion: "failure",
          html_url: "https://github.com/x/y/runs/3",
        },
        {
          name: "lint",
          status: "completed",
          conclusion: "success",
          html_url: "",
        },
      ],
      coverage: {
        changedSourceCount: 1,
        testFileCount: 0,
        uncovered: ["packages/core/src/bus.ts"],
      },
      signals: [
        {
          id: "swallowed-error",
          severity: "high",
          explain: "an error is caught and discarded",
          file: "packages/core/src/bus.ts",
          line: 12,
          text: "+  } catch (err) {}",
        },
      ],
      linkedIssues: [1234],
      priorComments: [
        {
          author: "reviewer",
          body: "this looks like a bandaid",
          path: undefined,
        },
      ],
    });
    expect(dossier).toContain("**Backend logs** (`backend-logs`): blank");
    expect(dossier).toContain("a passing review over red CI is not a review");
    expect(dossier).toContain("typecheck: failure");
    expect(dossier).toContain("no same-name test");
    expect(dossier).toContain("swallowed-error");
    expect(dossier).toContain("#1234");
    expect(dossier).toContain("this looks like a bandaid");
    expect(dossier).toContain("Do not repeat a point already made");
  });

  test("clean inputs render a clean dossier without inventing problems", () => {
    const dossier = renderDossier({
      pr: { ...basePr, body: "" },
      files: [],
      evidence: { ok: true, findings: [] },
      checks: [],
      coverage: { changedSourceCount: 0, testFileCount: 0, uncovered: [] },
      signals: [],
      linkedIssues: [],
      priorComments: [],
    });
    expect(dossier).toContain("Every required evidence row is satisfied");
    expect(dossier).toContain("No check runs reported");
    expect(dossier).toContain("No surface-fix patterns matched");
    expect(dossier).toContain("No prior review comments");
    expect(dossier).toContain("(empty pull request description)");
  });
});
