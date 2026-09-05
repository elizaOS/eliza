/**
 * Deterministic contract tests for three-attempt stability planning,
 * aggregation, strict tiers, structural failure classes, and focus lists.
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CliUsageError, parseArgs, runCli } from "./cli.ts";
import type { ScenarioStabilityAttemptReport } from "./stability.ts";
import {
  buildScenarioStabilityReport,
  createScenarioStabilityPlan,
  parseScenarioStabilityAttemptReport,
  SCENARIO_STABILITY_MAX_FAILED_ASSERTIONS,
  SCENARIO_STABILITY_MAX_REPORT_BYTES,
  SCENARIO_STABILITY_MAX_SCENARIO_ID_LENGTH,
  SCENARIO_STABILITY_MAX_SCENARIOS,
  writeScenarioStabilityPlan,
} from "./stability.ts";
import type { AggregateReport, ScenarioReport } from "./types.ts";

function scenario(
  id: string,
  status: ScenarioReport["status"],
): ScenarioReport {
  return {
    id,
    title: id,
    domain: "stability-test",
    tags: [],
    status,
    ...(status === "skipped" ? { skipReason: "fixture unavailable" } : {}),
    durationMs: 1,
    turns: [],
    finalChecks: [],
    actionsCalled: [],
    failedAssertions:
      status === "failed" ? [{ label: "outcome", detail: "wrong action" }] : [],
    providerName: "unit-provider",
  };
}

function aggregate(
  runId: string,
  scenarios: readonly ScenarioReport[],
): AggregateReport {
  const passed = scenarios.filter((item) => item.status === "passed").length;
  const failed = scenarios.filter((item) => item.status === "failed").length;
  const skipped = scenarios.filter((item) => item.status === "skipped").length;
  return {
    runId,
    startedAtIso: "2026-08-20T00:00:00.000Z",
    completedAtIso: "2026-08-20T00:00:01.000Z",
    providerName: "unit-provider",
    executionProfile: "simulated",
    scenarios: [...scenarios],
    evidenceSummary: {
      reportedScenarioCount: 0,
      unreportedScenarioCount: scenarios.length,
      qualificationCounts: { qualified: 0, unqualified: 0, ineligible: 0 },
      publishableScenarioCount: 0,
      observationCounts: {
        "durable-approval": 0,
        "durable-draft": 0,
        "provider-effect": 0,
        "provider-no-effect": 0,
        "scheduled-task": 0,
      },
    },
    totals: {
      passed,
      failed,
      skipped,
      costUsd: 0,
      finalChecksSkipped: 0,
    },
    totalCount: scenarios.length,
    passedCount: passed,
    failedCount: failed,
    skippedCount: skipped,
    totalCostUsd: 0,
  };
}

describe("scenario stability report plumbing", () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  function tempRoot(): string {
    const root = mkdtempSync(path.join(tmpdir(), "scenario-stability-"));
    tempRoots.push(root);
    return root;
  }

  it("creates exactly three unique attempt IDs and isolated output paths", () => {
    const root = tempRoot();
    const plan = createScenarioStabilityPlan({
      runId: "stability-run",
      outputRoot: root,
    });

    expect(plan.attemptCount).toBe(3);
    expect(plan.requiredTier).toBe("3/3");
    expect(plan.attempts.map((attempt) => attempt.attemptId)).toEqual([
      "stability-run-attempt-01",
      "stability-run-attempt-02",
      "stability-run-attempt-03",
    ]);
    expect(
      new Set(plan.attempts.map((attempt) => attempt.outputDir)).size,
    ).toBe(3);
    expect(plan.attempts[0].reportPath).toBe(
      path.join(root, "attempt-01", "matrix.json"),
    );
    expect(() =>
      createScenarioStabilityPlan({ runId: "../unsafe", outputRoot: root }),
    ).toThrow(/filename-safe/);
  });

  it("builds strict tiers, first-pass state, failure classes, and a focus list", () => {
    const plan = createScenarioStabilityPlan({
      runId: "aggregate-run",
      outputRoot: tempRoot(),
    });
    const reports = [
      aggregate(plan.attempts[0].attemptId, [
        scenario("alpha", "passed"),
        scenario("beta", "skipped"),
        scenario("gamma", "failed"),
        scenario("stable", "passed"),
      ]),
      aggregate(plan.attempts[1].attemptId, [
        scenario("alpha", "failed"),
        scenario("gamma", "skipped"),
        scenario("stable", "passed"),
      ]),
      aggregate(plan.attempts[2].attemptId, [
        scenario("alpha", "passed"),
        scenario("beta", "passed"),
        scenario("stable", "passed"),
      ]),
    ];

    const report = buildScenarioStabilityReport(plan, reports);

    expect(report.status).toBe("failed");
    expect(report.scenarios).toEqual([
      expect.objectContaining({
        scenarioId: "alpha",
        firstAttemptPassed: true,
        passedAttempts: 2,
        tier: "2/3",
        strictPassed: false,
      }),
      expect.objectContaining({
        scenarioId: "beta",
        firstAttemptPassed: false,
        passedAttempts: 1,
        tier: "1/3",
        strictPassed: false,
      }),
      expect.objectContaining({
        scenarioId: "gamma",
        firstAttemptPassed: false,
        passedAttempts: 0,
        tier: "0/3",
        strictPassed: false,
      }),
      expect.objectContaining({
        scenarioId: "stable",
        firstAttemptPassed: true,
        passedAttempts: 3,
        tier: "3/3",
        strictPassed: true,
      }),
    ]);
    expect(report.focusList).toEqual([
      {
        scenarioId: "alpha",
        tier: "2/3",
        failedAttemptIds: [plan.attempts[1].attemptId],
        failureClassifications: ["scenario-failure"],
      },
      {
        scenarioId: "beta",
        tier: "1/3",
        failedAttemptIds: [
          plan.attempts[0].attemptId,
          plan.attempts[1].attemptId,
        ],
        failureClassifications: ["harness-failure"],
      },
      {
        scenarioId: "gamma",
        tier: "0/3",
        failedAttemptIds: plan.attempts.map((attempt) => attempt.attemptId),
        failureClassifications: ["harness-failure", "scenario-failure"],
      },
    ]);
    expect(report.scenarios[1]?.attempts[1]).toMatchObject({
      status: "missing",
      failureClassification: "harness-failure",
    });
  });

  it("rejects incomplete, duplicate, unexpected, and vacuous attempt sets", () => {
    const plan = createScenarioStabilityPlan({
      runId: "invalid-run",
      outputRoot: tempRoot(),
    });
    const valid = plan.attempts.map((attempt) =>
      aggregate(attempt.attemptId, [scenario("alpha", "passed")]),
    );

    expect(() => buildScenarioStabilityReport(plan, valid.slice(0, 2))).toThrow(
      /exactly 3/,
    );
    expect(() =>
      buildScenarioStabilityReport(plan, [valid[0], valid[0], valid[2]]),
    ).toThrow(/duplicate/);
    expect(() =>
      buildScenarioStabilityReport(plan, [
        valid[0],
        aggregate("unexpected", [scenario("alpha", "passed")]),
        valid[2],
      ]),
    ).toThrow(/missing or has the wrong runId/);
    expect(() =>
      buildScenarioStabilityReport(
        plan,
        plan.attempts.map((attempt) => aggregate(attempt.attemptId, [])),
      ),
    ).toThrow(/empty attempt reports/);
    expect(() =>
      buildScenarioStabilityReport(plan, [
        aggregate(plan.attempts[0].attemptId, [
          scenario("alpha", "passed"),
          scenario("alpha", "passed"),
        ]),
        valid[1],
        valid[2],
      ]),
    ).toThrow(/duplicate scenario id/);
  });

  it("validates the exact attempt-report subset consumed by aggregation", () => {
    expect(
      parseScenarioStabilityAttemptReport({
        runId: "attempt-id",
        scenarios: [
          {
            id: "alpha",
            status: "failed",
            failedAssertions: [{ detail: "no" }],
          },
        ],
      }),
    ).toEqual({
      runId: "attempt-id",
      scenarios: [
        {
          id: "alpha",
          status: "failed",
          skipReason: undefined,
          error: undefined,
          failedAssertions: [{ detail: "no" }],
        },
      ],
    });
    expect(() =>
      parseScenarioStabilityAttemptReport({
        runId: "attempt-id",
        scenarios: [{ id: "alpha", status: "unknown", failedAssertions: [] }],
      }),
    ).toThrow(/invalid status/);
    expect(() =>
      parseScenarioStabilityAttemptReport({
        runId: "attempt-id",
        scenarios: [{ id: "alpha", status: "failed" }],
      }),
    ).toThrow(/failedAssertions array/);
  });

  it("rejects status contradictions instead of manufacturing strict passes", () => {
    expect(() =>
      parseScenarioStabilityAttemptReport({
        runId: "attempt-id",
        scenarios: [
          {
            id: "alpha",
            status: "passed",
            error: "fatal",
            failedAssertions: [{ detail: "failed assertion" }],
          },
        ],
      }),
    ).toThrow(/cannot report passed/);
    expect(() =>
      parseScenarioStabilityAttemptReport({
        runId: "attempt-id",
        scenarios: [
          {
            id: "alpha",
            status: "skipped",
            skipReason: "fixture unavailable",
            failedAssertions: [{ detail: "failed assertion" }],
          },
        ],
      }),
    ).toThrow(/inconsistent skipped status/);

    const plan = createScenarioStabilityPlan({
      runId: "programmatic",
      outputRoot: tempRoot(),
    });
    const contradictoryReports: ScenarioStabilityAttemptReport[] =
      plan.attempts.map((attempt) => ({
        runId: attempt.attemptId,
        scenarios: [
          {
            id: "alpha",
            status: "passed",
            error: "fatal",
            failedAssertions: [{ detail: "failed assertion" }],
          },
        ],
      }));
    expect(() =>
      buildScenarioStabilityReport(plan, contradictoryReports),
    ).toThrow(/cannot report passed/);
  });

  it("bounds scenario, assertion, and identifier allocation", () => {
    expect(() =>
      parseScenarioStabilityAttemptReport({
        runId: "attempt-id",
        scenarios: Array.from(
          { length: SCENARIO_STABILITY_MAX_SCENARIOS + 1 },
          () => ({ id: "alpha", status: "passed", failedAssertions: [] }),
        ),
      }),
    ).toThrow(/scenario limit/);
    expect(() =>
      parseScenarioStabilityAttemptReport({
        runId: "attempt-id",
        scenarios: [
          {
            id: "a".repeat(SCENARIO_STABILITY_MAX_SCENARIO_ID_LENGTH + 1),
            status: "passed",
            failedAssertions: [],
          },
        ],
      }),
    ).toThrow(/must contain an id/);
    expect(() =>
      parseScenarioStabilityAttemptReport({
        runId: "attempt-id",
        scenarios: [
          {
            id: "alpha",
            status: "failed",
            failedAssertions: Array.from(
              { length: SCENARIO_STABILITY_MAX_FAILED_ASSERTIONS + 1 },
              () => ({ detail: "no" }),
            ),
          },
        ],
      }),
    ).toThrow(/assertion limit/);
  });

  it("exposes plan and aggregate generation through the CLI without executing scenarios", async () => {
    const root = tempRoot();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const argv = ["stability", root, "--runId", "cli-run"] as const;

    await expect(runCli(argv)).resolves.toBe(0);
    const plan = createScenarioStabilityPlan({
      runId: "cli-run",
      outputRoot: root,
    });
    expect(JSON.parse(readFileSync(plan.planPath, "utf8"))).toEqual(plan);

    const statuses: ScenarioReport["status"][] = ["passed", "passed", "failed"];
    for (const [index, attempt] of plan.attempts.entries()) {
      writeScenarioStabilityPlan(plan);
      writeFileSync(
        attempt.reportPath,
        `${JSON.stringify(
          aggregate(attempt.attemptId, [
            scenario("alpha", statuses[index] ?? "failed"),
          ]),
        )}\n`,
      );
    }
    await expect(
      runCli([
        ...argv,
        ...plan.attempts.flatMap((attempt) => [
          "--attempt-report",
          attempt.reportPath,
        ]),
      ]),
    ).resolves.toBe(1);
    const report = JSON.parse(readFileSync(plan.reportPath, "utf8")) as {
      status: string;
      scenarios: Array<{ tier: string }>;
    };
    expect(report.status).toBe("failed");
    expect(report.scenarios[0]?.tier).toBe("2/3");
  });

  it("returns CLI success only for a strict three-of-three aggregate", async () => {
    const root = tempRoot();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const plan = createScenarioStabilityPlan({
      runId: "strict-cli",
      outputRoot: root,
    });
    writeScenarioStabilityPlan(plan);
    for (const attempt of plan.attempts) {
      writeFileSync(
        attempt.reportPath,
        `${JSON.stringify(
          aggregate(attempt.attemptId, [scenario("alpha", "passed")]),
        )}\n`,
      );
    }
    await expect(
      runCli([
        "stability",
        root,
        "--runId",
        plan.runId,
        ...plan.attempts.flatMap((attempt) => [
          "--attempt-report",
          attempt.reportPath,
        ]),
      ]),
    ).resolves.toBe(0);
    expect(JSON.parse(readFileSync(plan.reportPath, "utf8"))).toMatchObject({
      status: "passed",
      scenarios: [{ scenarioId: "alpha", tier: "3/3", strictPassed: true }],
      focusList: [],
    });
  });

  it("rejects partial CLI attempt sets before reading artifacts", () => {
    const root = tempRoot();
    expect(() =>
      parseArgs([
        "stability",
        root,
        "--runId",
        "partial",
        "--attempt-report",
        path.join(root, "one.json"),
      ]),
    ).toThrow(CliUsageError);
  });

  it("translates malformed CLI report JSON into a usage error", async () => {
    const root = tempRoot();
    const plan = createScenarioStabilityPlan({
      runId: "malformed-cli",
      outputRoot: root,
    });
    writeScenarioStabilityPlan(plan);
    for (const attempt of plan.attempts) {
      writeFileSync(attempt.reportPath, "not-json\n");
    }
    await expect(
      runCli([
        "stability",
        root,
        "--runId",
        plan.runId,
        ...plan.attempts.flatMap((attempt) => [
          "--attempt-report",
          attempt.reportPath,
        ]),
      ]),
    ).rejects.toMatchObject({ exitCode: 2 });
  });

  it("returns usage exit code 2 for an undeclared skipped attempt", async () => {
    const root = tempRoot();
    const plan = createScenarioStabilityPlan({
      runId: "undeclared-skip",
      outputRoot: root,
    });
    writeScenarioStabilityPlan(plan);
    for (const attempt of plan.attempts) {
      writeFileSync(
        attempt.reportPath,
        `${JSON.stringify({
          runId: attempt.attemptId,
          scenarios: [{ id: "alpha", status: "skipped", failedAssertions: [] }],
        })}\n`,
      );
    }

    await expect(
      runCli([
        "stability",
        root,
        "--runId",
        plan.runId,
        ...plan.attempts.flatMap((attempt) => [
          "--attempt-report",
          attempt.reportPath,
        ]),
      ]),
    ).rejects.toMatchObject({ exitCode: 2 });
  });

  it("translates invalid aggregate report sets into usage errors", async () => {
    const root = tempRoot();
    const plan = createScenarioStabilityPlan({
      runId: "invalid-aggregate",
      outputRoot: root,
    });
    writeScenarioStabilityPlan(plan);
    for (const attempt of plan.attempts) {
      writeFileSync(
        attempt.reportPath,
        `${JSON.stringify(aggregate(attempt.attemptId, []))}\n`,
      );
    }
    const aggregateArgs = plan.attempts.flatMap((attempt) => [
      "--attempt-report",
      attempt.reportPath,
    ]);

    await expect(
      runCli(["stability", root, "--runId", plan.runId, ...aggregateArgs]),
    ).rejects.toMatchObject({ exitCode: 2 });

    writeFileSync(
      plan.attempts[0].reportPath,
      `${JSON.stringify(
        aggregate(plan.attempts[0].attemptId, [scenario("alpha", "passed")]),
      )}\n`,
    );
    await expect(
      runCli([
        "stability",
        root,
        "--runId",
        plan.runId,
        ...Array.from({ length: 3 }, () => [
          "--attempt-report",
          plan.attempts[0].reportPath,
        ]).flat(),
      ]),
    ).rejects.toMatchObject({ exitCode: 2 });
  });

  it("requires and preserves the persisted plan authority", async () => {
    const root = tempRoot();
    const original = createScenarioStabilityPlan({
      runId: "original",
      outputRoot: root,
    });
    const replacement = createScenarioStabilityPlan({
      runId: "replacement",
      outputRoot: root,
    });
    writeScenarioStabilityPlan(original);

    expect(() => writeScenarioStabilityPlan(replacement)).toThrow(
      /does not match the requested run identity/,
    );
    expect(JSON.parse(readFileSync(original.planPath, "utf8"))).toMatchObject({
      runId: "original",
    });

    await expect(
      runCli([
        "stability",
        root,
        "--runId",
        "replacement",
        ...replacement.attempts.flatMap((attempt) => [
          "--attempt-report",
          attempt.reportPath,
        ]),
      ]),
    ).rejects.toMatchObject({ exitCode: 2 });
    expect(JSON.parse(readFileSync(original.planPath, "utf8"))).toMatchObject({
      runId: "original",
    });
  });

  it("rejects oversized and symlinked attempt artifacts before aggregation", async () => {
    const root = tempRoot();
    const plan = createScenarioStabilityPlan({
      runId: "bounded",
      outputRoot: root,
    });
    writeScenarioStabilityPlan(plan);
    writeFileSync(plan.attempts[0].reportPath, "");
    truncateSync(
      plan.attempts[0].reportPath,
      SCENARIO_STABILITY_MAX_REPORT_BYTES + 1,
    );
    for (const attempt of plan.attempts.slice(1)) {
      writeFileSync(
        attempt.reportPath,
        `${JSON.stringify(
          aggregate(attempt.attemptId, [scenario("alpha", "passed")]),
        )}\n`,
      );
    }
    await expect(
      runCli([
        "stability",
        root,
        "--runId",
        plan.runId,
        ...plan.attempts.flatMap((attempt) => [
          "--attempt-report",
          attempt.reportPath,
        ]),
      ]),
    ).rejects.toMatchObject({ exitCode: 2 });

    rmSync(plan.attempts[0].reportPath);
    const externalReport = path.join(root, "external.json");
    writeFileSync(
      externalReport,
      `${JSON.stringify(
        aggregate(plan.attempts[0].attemptId, [scenario("alpha", "passed")]),
      )}\n`,
    );
    symlinkSync(externalReport, plan.attempts[0].reportPath);
    await expect(
      runCli([
        "stability",
        root,
        "--runId",
        plan.runId,
        ...plan.attempts.flatMap((attempt) => [
          "--attempt-report",
          attempt.reportPath,
        ]),
      ]),
    ).rejects.toMatchObject({ exitCode: 2 });
  });

  it("refuses to overwrite a symlinked aggregate output", async () => {
    const root = tempRoot();
    const externalRoot = tempRoot();
    const sentinelPath = path.join(externalRoot, "sentinel.json");
    const sentinel = "outside aggregate sentinel\n";
    const plan = createScenarioStabilityPlan({
      runId: "symlinked-output",
      outputRoot: root,
    });
    writeScenarioStabilityPlan(plan);
    for (const attempt of plan.attempts) {
      writeFileSync(
        attempt.reportPath,
        `${JSON.stringify(
          aggregate(attempt.attemptId, [scenario("alpha", "passed")]),
        )}\n`,
      );
    }
    writeFileSync(sentinelPath, sentinel);
    symlinkSync(sentinelPath, plan.reportPath);

    await expect(
      runCli([
        "stability",
        root,
        "--runId",
        plan.runId,
        ...plan.attempts.flatMap((attempt) => [
          "--attempt-report",
          attempt.reportPath,
        ]),
      ]),
    ).rejects.toMatchObject({ exitCode: 2 });
    expect(readFileSync(sentinelPath, "utf8")).toBe(sentinel);
  });

  it("rejects ancestor-directory symlinks for reads and plan writes", async () => {
    const root = tempRoot();
    const externalRoot = tempRoot();
    const plan = createScenarioStabilityPlan({
      runId: "ancestor-symlink",
      outputRoot: root,
    });
    writeScenarioStabilityPlan(plan);
    for (const attempt of plan.attempts) {
      writeFileSync(
        attempt.reportPath,
        `${JSON.stringify(
          aggregate(attempt.attemptId, [scenario("alpha", "passed")]),
        )}\n`,
      );
    }
    const firstAttemptBytes = readFileSync(plan.attempts[0].reportPath);
    rmSync(plan.attempts[0].outputDir, { recursive: true });
    const externalAttempt = path.join(externalRoot, "attempt-01");
    mkdirSync(externalAttempt);
    const externalReport = path.join(externalAttempt, "matrix.json");
    writeFileSync(externalReport, firstAttemptBytes);
    symlinkSync(externalAttempt, plan.attempts[0].outputDir);

    await expect(
      runCli([
        "stability",
        root,
        "--runId",
        plan.runId,
        ...plan.attempts.flatMap((attempt) => [
          "--attempt-report",
          attempt.reportPath,
        ]),
      ]),
    ).rejects.toMatchObject({ exitCode: 2 });
    expect(readFileSync(externalReport)).toEqual(firstAttemptBytes);

    const symlinkRoot = path.join(root, "symlink-output");
    const externalOutput = path.join(externalRoot, "output");
    mkdirSync(externalOutput);
    symlinkSync(externalOutput, symlinkRoot);
    await expect(
      runCli(["stability", symlinkRoot, "--runId", "symlink-root"]),
    ).rejects.toMatchObject({ exitCode: 2 });
    expect(() =>
      readFileSync(path.join(externalOutput, "stability-plan.json")),
    ).toThrow();
  });

  it("translates invalid stability run IDs into usage exit code 2", async () => {
    await expect(
      runCli(["stability", tempRoot(), "--runId", "../unsafe"]),
    ).rejects.toMatchObject({ exitCode: 2 });
  });
});
