/** Tests report aggregation and output (reporter.ts): `buildAggregate` roll-ups plus the JSON report and run-viewer files written to a temp dir. */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildAggregate,
  printStdoutSummary,
  sumTrajectoryCostUsd,
  validateAggregateEvidenceReport,
  validateScenarioEvidenceReport,
  writeFileAtomic,
  writeReportBundle,
  writeScenarioRunViewer,
} from "./reporter.ts";
import type { AggregateReport, ScenarioReport } from "./types.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function firstItem<T>(items: T[]): T {
  const item = items[0];
  if (item === undefined) {
    throw new Error("expected a non-empty adversarial test fixture");
  }
  return item;
}

function aggregateReport(): AggregateReport {
  return {
    runId: "run-1",
    startedAtIso: "2026-05-23T00:00:00.000Z",
    completedAtIso: "2026-05-23T00:01:00.000Z",
    providerName: "deterministic-model-provider",
    executionProfile: null,
    scenarios: [
      {
        id: "todos.create-basic",
        title: "Create a todo",
        domain: "lifeops",
        tags: ["tasks"],
        status: "passed",
        durationMs: 1000,
        turns: [
          {
            name: "turn-1",
            kind: "message",
            text: "add buy milk",
            responseText: "Done.",
            actionsCalled: [{ name: "CREATE_TASK" } as never],
            durationMs: 100,
            failedAssertions: [],
          },
        ],
        finalChecks: [],
        actionsCalled: [{ name: "CREATE_TASK" } as never],
        failedAssertions: [],
        providerName: "deterministic-model-provider",
      },
    ],
    classificationSummary: {
      laneCounts: {
        "pr-deterministic": 0,
        "live-only": 0,
        unreported: 1,
      },
      executionProfileCounts: {
        simulated: 0,
        "provider-qualified": 0,
        unreported: 1,
      },
      evidenceScopeCounts: {
        "runner-fixture": 0,
        "domain-contract": 0,
        "model-behavior": 0,
        "connector-contract": 0,
        "provider-certification": 0,
        unreported: 1,
      },
      defaultedEvidenceScopeCount: 0,
      selfGradedJudgeCount: 0,
    },
    evidenceSummary: {
      reportedScenarioCount: 0,
      unreportedScenarioCount: 1,
      qualificationCounts: {
        qualified: 0,
        unqualified: 0,
        ineligible: 0,
      },
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
      passed: 1,
      failed: 0,
      skipped: 0,
      costUsd: 0,
      finalChecksSkipped: 0,
    },
    totalCount: 1,
    passedCount: 1,
    failedCount: 0,
    skippedCount: 0,
    totalCostUsd: 0,
  };
}

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);
const HASH_E = "e".repeat(64);
const HASH_F = "f".repeat(64);

function providerQualifiedScenarioReport(): ScenarioReport {
  return {
    ...aggregateReport().scenarios[0],
    id: "provider.qualified",
    status: "passed",
    executionProfile: "provider-qualified",
    evidence: {
      schemaVersion: 1,
      executionProfile: "provider-qualified",
      qualification: {
        status: "qualified",
        publishable: true,
        reasons: [],
      },
      observerProvenance: [
        {
          observerId: "provider-calendar-observer",
          kind: "provider-api",
          implementation: "calendar-readback-adapter",
          version: "1.0.0",
          environment: "sandbox",
          configurationSha256: HASH_A,
        },
      ],
      trajectoryHashes: [
        {
          trajectoryId: "trajectory-provider-qualified",
          relativePath: "trajectories/provider-qualified.json",
          sha256: HASH_B,
          recorder: {
            implementation: "scenario-trajectory-recorder",
            version: "1.0.0",
            environment: "sandbox",
          },
        },
      ],
      observations: [
        {
          observationId: "provider-no-effect-1",
          kind: "provider-no-effect",
          observedAtIso: "2026-05-23T00:00:30.000Z",
          observerId: "provider-calendar-observer",
          source: {
            kind: "provider-api",
            system: "calendar",
            environment: "sandbox",
            recordIdSha256: HASH_C,
            accountRefSha256: HASH_D,
          },
          payloadSha256: HASH_E,
          trajectoryRefs: [
            {
              trajectoryId: "trajectory-provider-qualified",
              stageId: "stage-provider-readback",
              sha256: HASH_B,
            },
          ],
          provider: "calendar",
          accountRefSha256: HASH_D,
          effectKinds: ["event-create"],
          scopeSha256: HASH_F,
          beforeSnapshotSha256: HASH_A,
          afterSnapshotSha256: HASH_A,
          observationStartedAtIso: "2026-05-23T00:00:00.000Z",
          observationEndedAtIso: "2026-05-23T00:01:00.000Z",
        },
      ],
    },
  };
}

describe("writeScenarioRunViewer", () => {
  it("writes a self-contained viewer with reports, trajectories, and native rows", () => {
    const runDir = path.join(
      tmpdir(),
      `scenario-viewer-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const trajectoryDir = path.join(runDir, "trajectories", "agent-1");
    mkdirSync(trajectoryDir, { recursive: true });
    writeFileSync(
      path.join(trajectoryDir, "traj-1.json"),
      JSON.stringify({
        trajectoryId: "traj-1",
        agentId: "agent-1",
        scenarioId: "todos.create-basic",
        stages: [],
      }),
      "utf-8",
    );
    const nativeJsonl = path.join(runDir, "native.jsonl");
    writeFileSync(
      nativeJsonl,
      `${JSON.stringify({
        format: "eliza_native_v1",
        scenarioId: "todos.create-basic",
        request: { messages: [{ role: "user", content: "add buy milk" }] },
        response: { text: "Done." },
      })}\n`,
      "utf-8",
    );

    const aggregate = aggregateReport();
    aggregate.artifactPaths = {
      runDir,
      matrixJson: path.join(runDir, "matrix.json"),
      viewerIndex: path.join(runDir, "viewer", "index.html"),
      viewerData: path.join(runDir, "viewer", "data.js"),
      nativeJsonl,
      nativeManifest: path.join(runDir, "native.manifest.json"),
    };

    const paths = writeScenarioRunViewer(aggregate, runDir, {
      nativeJsonlPath: nativeJsonl,
    });
    const html = readFileSync(paths.viewerIndex, "utf-8");
    const data = readFileSync(paths.viewerData, "utf-8");
    const payload = JSON.parse(
      data.replace(/^window\.SCENARIO_RUN_DATA = /, "").replace(/;\n?$/, ""),
    );

    expect(html).toContain("Eliza Scenario Run Viewer");
    expect(data).toContain("window.SCENARIO_RUN_DATA");
    expect(data).toContain("todos.create-basic");
    expect(data).toContain("summaries");
    expect(data).toContain("eliza_native_v1");
    expect(data).toContain("traj-1.json");
    expect(payload.report.artifactPaths).toEqual(aggregate.artifactPaths);
  });

  it("renders an <audio controls> cell for turns carrying audioArtifacts (#8934)", () => {
    const runDir = mkdtempSync(path.join(tmpdir(), "scenario-viewer-audio-"));
    tempDirs.push(runDir);

    const aggregate = aggregateReport();
    aggregate.scenarios[0] = {
      ...aggregate.scenarios[0],
      id: "voice.workbench-room",
      domain: "voice",
      turns: [
        {
          ...aggregate.scenarios[0].turns[0],
          name: "multi-speaker voice scenario",
          kind: "voice",
          audioArtifacts: [
            {
              turnIndex: 0,
              kind: "generated",
              path: "audio/voice-room-demo/corpus.wav",
              sampleRate: 16000,
              durationMs: 4200,
            },
            {
              turnIndex: 0,
              kind: "consumed",
              path: "audio/voice-room-demo/turn-0.wav",
              sampleRate: 16000,
              durationMs: 1500,
              speakerLabel: "alice",
            },
          ],
        },
      ],
    };

    const paths = writeScenarioRunViewer(aggregate, runDir);
    const html = readFileSync(paths.viewerIndex, "utf-8");
    const data = readFileSync(paths.viewerData, "utf-8");

    // The viewer builds an <audio controls> element per artifact at render time.
    expect(html).toContain("audioArtifactsCell");
    expect(html).toContain("<audio controls");
    // The embedded run data carries the run-dir-relative artifact paths so the
    // viewer (served from the run dir) can resolve and play them.
    expect(data).toContain("audio/voice-room-demo/corpus.wav");
    expect(data).toContain("audio/voice-room-demo/turn-0.wav");
    expect(data).toContain('"kind":"generated"');
    expect(data).toContain('"kind":"consumed"');
  });
});

describe("scenario report aggregation", () => {
  it("builds aggregate counts from scenario statuses without trusting caller totals", () => {
    const report = buildAggregate(
      [
        {
          ...aggregateReport().scenarios[0],
          id: "passed.one",
          status: "passed",
        },
        {
          ...aggregateReport().scenarios[0],
          id: "failed.one",
          status: "failed",
        },
        {
          ...aggregateReport().scenarios[0],
          id: "skipped.one",
          status: "skipped",
          skipReason: "not configured",
        },
      ],
      null,
      "2026-05-23T00:00:00.000Z",
      "2026-05-23T00:01:00.000Z",
      "run-aggregate",
    );

    expect(report).toMatchObject({
      runId: "run-aggregate",
      providerName: null,
      totalCount: 3,
      passedCount: 1,
      failedCount: 1,
      skippedCount: 1,
      totals: {
        passed: 1,
        failed: 1,
        skipped: 1,
        costUsd: 0,
        finalChecksSkipped: 0,
      },
    });
    // A run with no trajectories (no runDir) reports honest $0 spend and no
    // longer carries the fabricated flaky-pass count.
    expect(report.totalCostUsd).toBe(0);
    expect(
      (report as unknown as Record<string, unknown>).flakyPassedCount,
    ).toBeUndefined();
    expect(
      (report.totals as unknown as Record<string, unknown>).flakyPassed,
    ).toBeUndefined();
    expect(report.executionProfile).toBeNull();
    expect(report.evidenceSummary).toMatchObject({
      reportedScenarioCount: 0,
      unreportedScenarioCount: 3,
      publishableScenarioCount: 0,
    });
    expect(report.classificationSummary).toEqual({
      laneCounts: {
        "pr-deterministic": 0,
        "live-only": 0,
        unreported: 3,
      },
      executionProfileCounts: {
        simulated: 0,
        "provider-qualified": 0,
        unreported: 3,
      },
      evidenceScopeCounts: {
        "runner-fixture": 0,
        "domain-contract": 0,
        "model-behavior": 0,
        "connector-contract": 0,
        "provider-certification": 0,
        unreported: 3,
      },
      defaultedEvidenceScopeCount: 0,
      selfGradedJudgeCount: 0,
    });
  });

  it("counts explicit classifications and conservative legacy defaults", () => {
    const report = buildAggregate(
      [
        {
          ...aggregateReport().scenarios[0],
          lane: "pr-deterministic",
          executionProfile: "simulated",
          evidenceScope: "runner-fixture",
          evidenceScopeDefaulted: true,
        },
        {
          ...aggregateReport().scenarios[0],
          id: "connector.contract",
          lane: "live-only",
          executionProfile: "simulated",
          evidenceScope: "connector-contract",
          judgeSelfGraded: true,
        },
      ],
      null,
      "2026-05-23T00:00:00.000Z",
      "2026-05-23T00:01:00.000Z",
      "run-classifications",
    );

    expect(report.classificationSummary).toMatchObject({
      laneCounts: { "pr-deterministic": 1, "live-only": 1, unreported: 0 },
      executionProfileCounts: {
        simulated: 2,
        "provider-qualified": 0,
        unreported: 0,
      },
      evidenceScopeCounts: {
        "runner-fixture": 1,
        "connector-contract": 1,
        "provider-certification": 0,
        unreported: 0,
      },
      defaultedEvidenceScopeCount: 1,
      selfGradedJudgeCount: 1,
    });
  });

  it("rejects report-level certification relabeling without qualified execution", () => {
    expect(() =>
      buildAggregate(
        [
          {
            ...aggregateReport().scenarios[0],
            executionProfile: "simulated",
            evidenceScope: "provider-certification",
          },
        ],
        null,
        "2026-05-23T00:00:00.000Z",
        "2026-05-23T00:01:00.000Z",
        "run-false-certification",
      ),
    ).toThrow(/incompatible with executionProfile "simulated"/);
  });

  it("preserves trusted evidence and derives profile and observation summaries", () => {
    const scenarioReport = providerQualifiedScenarioReport();
    const report = buildAggregate(
      [scenarioReport],
      "live-provider",
      "2026-05-23T00:00:00.000Z",
      "2026-05-23T00:01:00.000Z",
      "run-provider-qualified",
    );

    expect(report.executionProfile).toBe("provider-qualified");
    expect(report.scenarios[0]?.evidence).toEqual(scenarioReport.evidence);
    expect(report.evidenceSummary).toEqual({
      reportedScenarioCount: 1,
      unreportedScenarioCount: 0,
      qualificationCounts: {
        qualified: 1,
        unqualified: 0,
        ineligible: 0,
      },
      publishableScenarioCount: 1,
      observationCounts: {
        "durable-approval": 0,
        "durable-draft": 0,
        "provider-effect": 0,
        "provider-no-effect": 1,
        "scheduled-task": 0,
      },
    });
  });

  it("does not infer qualification from provider-sounding action-result prose", () => {
    const scenarioReport: ScenarioReport = {
      ...aggregateReport().scenarios[0],
      executionProfile: "provider-qualified",
      actionsCalled: [
        {
          actionName: "SEND_MESSAGE",
          result: {
            success: true,
            text: "Provider receipt confirmed and delivered.",
          },
        },
      ],
    };
    const report = buildAggregate(
      [scenarioReport],
      "live-provider",
      "2026-05-23T00:00:00.000Z",
      "2026-05-23T00:01:00.000Z",
      "run-action-prose",
    );

    expect(report.executionProfile).toBe("provider-qualified");
    expect(report.evidenceSummary).toMatchObject({
      reportedScenarioCount: 0,
      unreportedScenarioCount: 1,
      publishableScenarioCount: 0,
      qualificationCounts: {
        qualified: 0,
        unqualified: 0,
        ineligible: 0,
      },
    });
  });

  it("reports mixed only from explicit scenario profiles and leaves legacy reports unreported", () => {
    const report = buildAggregate(
      [
        {
          ...aggregateReport().scenarios[0],
          id: "legacy",
        },
        {
          ...aggregateReport().scenarios[0],
          id: "simulated",
          executionProfile: "simulated",
          evidence: {
            schemaVersion: 1,
            executionProfile: "simulated",
            qualification: {
              status: "ineligible",
              publishable: false,
              reasons: ["simulated runs are never provider evidence"],
            },
          },
        },
        providerQualifiedScenarioReport(),
      ],
      "mixed-provider",
      "2026-05-23T00:00:00.000Z",
      "2026-05-23T00:01:00.000Z",
      "run-mixed",
    );

    expect(report.executionProfile).toBe("mixed");
    expect(report.evidenceSummary).toMatchObject({
      reportedScenarioCount: 2,
      unreportedScenarioCount: 1,
      publishableScenarioCount: 1,
      qualificationCounts: {
        qualified: 1,
        unqualified: 0,
        ineligible: 1,
      },
    });
  });

  it("rejects simulated attempts to claim publishable provider evidence", () => {
    const invalid = {
      ...aggregateReport().scenarios[0],
      executionProfile: "simulated",
      evidence: {
        schemaVersion: 1,
        executionProfile: "simulated",
        qualification: {
          status: "qualified",
          publishable: true,
          reasons: [],
        },
        observations: [
          {
            kind: "provider-effect",
            text: "the action said it worked",
          },
        ],
      },
    } as unknown as ScenarioReport;

    expect(() => validateScenarioEvidenceReport(invalid)).toThrow(
      /simulated evidence must be ineligible and publishable=false/,
    );
  });

  it("rejects action-result observers and non-canonical trajectory hashes", () => {
    const actionResultObserver = structuredClone(
      providerQualifiedScenarioReport(),
    ) as unknown as {
      evidence: {
        observerProvenance: Array<{ kind: string }>;
      };
    };
    firstItem(actionResultObserver.evidence.observerProvenance).kind =
      "action-result";
    expect(() =>
      validateScenarioEvidenceReport(
        actionResultObserver as unknown as ScenarioReport,
      ),
    ).toThrow(/unsupported trusted observer kind "action-result"/);

    const uppercaseHash = structuredClone(
      providerQualifiedScenarioReport(),
    ) as unknown as {
      evidence: {
        trajectoryHashes: Array<{ sha256: string }>;
      };
    };
    firstItem(uppercaseHash.evidence.trajectoryHashes).sha256 = "A".repeat(64);
    expect(() =>
      validateScenarioEvidenceReport(
        uppercaseHash as unknown as ScenarioReport,
      ),
    ).toThrow(/exactly 64 lowercase hexadecimal characters/);
  });

  it("rejects unbounded, reversed, or changing no-effect snapshots", () => {
    const reversedInterval = structuredClone(
      providerQualifiedScenarioReport(),
    ) as unknown as {
      evidence: {
        observations: Array<{
          observationStartedAtIso: string;
          observationEndedAtIso: string;
          afterSnapshotSha256: string;
        }>;
      };
    };
    firstItem(reversedInterval.evidence.observations).observationStartedAtIso =
      "2026-05-23T00:02:00.000Z";
    expect(() =>
      validateScenarioEvidenceReport(
        reversedInterval as unknown as ScenarioReport,
      ),
    ).toThrow(/must not precede observationStartedAtIso/);

    const changedSnapshot = structuredClone(
      providerQualifiedScenarioReport(),
    ) as unknown as {
      evidence: {
        observations: Array<{ afterSnapshotSha256: string }>;
      };
    };
    firstItem(changedSnapshot.evidence.observations).afterSnapshotSha256 =
      HASH_B;
    expect(() =>
      validateScenarioEvidenceReport(
        changedSnapshot as unknown as ScenarioReport,
      ),
    ).toThrow(/must equal beforeSnapshotSha256/);
  });

  it("rejects dangling observer and trajectory provenance references", () => {
    const danglingObserver = structuredClone(
      providerQualifiedScenarioReport(),
    ) as unknown as {
      evidence: {
        observations: Array<{ observerId: string }>;
      };
    };
    firstItem(danglingObserver.evidence.observations).observerId =
      "not-reported";
    expect(() =>
      validateScenarioEvidenceReport(
        danglingObserver as unknown as ScenarioReport,
      ),
    ).toThrow(/references unreported observer "not-reported"/);

    const mismatchedTrajectory = structuredClone(
      providerQualifiedScenarioReport(),
    ) as unknown as {
      evidence: {
        observations: Array<{
          trajectoryRefs: Array<{ sha256: string }>;
        }>;
      };
    };
    firstItem(
      firstItem(mismatchedTrajectory.evidence.observations).trajectoryRefs,
    ).sha256 = HASH_C;
    expect(() =>
      validateScenarioEvidenceReport(
        mismatchedTrajectory as unknown as ScenarioReport,
      ),
    ).toThrow(/does not match evidence\.trajectoryHashes/);
  });

  it("counts skipped finalChecks loudly in totals and the stdout summary", () => {
    const base = aggregateReport().scenarios[0];
    const report = buildAggregate(
      [
        {
          ...base,
          id: "live.with-skip",
          status: "passed",
          finalChecks: [
            {
              label: "approval exists",
              type: "approvalRequestExists",
              status: "skipped",
              detail:
                "dependency missing: no approval queue service registered",
            },
            {
              label: "push sent",
              type: "pushSent",
              status: "passed",
              detail: "1 push(es)",
            },
          ],
        },
      ],
      null,
      "2026-05-23T00:00:00.000Z",
      "2026-05-23T00:01:00.000Z",
      "run-skips",
    );

    expect(report.totals.finalChecksSkipped).toBe(1);

    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    printStdoutSummary(report);
    const output = write.mock.calls.map((call) => String(call[0])).join("");
    expect(output).toContain("1 finalCheck(s) skipped (dependency missing)");
    expect(output).toContain(
      "live.with-skip :: approval exists: dependency missing: no approval queue service registered",
    );
  });

  it("writes matrix and per-scenario reports with sanitized stable filenames", () => {
    const outDir = makeTempDir("scenario-bundle-");
    const report = aggregateReport();
    report.scenarios = [
      { ...report.scenarios[0], id: "todos/create basic" },
      { ...report.scenarios[0], id: "email|send:urgent" },
    ];
    report.totalCount = report.scenarios.length;
    report.evidenceSummary.unreportedScenarioCount = report.scenarios.length;
    report.classificationSummary.laneCounts.unreported =
      report.scenarios.length;
    report.classificationSummary.executionProfileCounts.unreported =
      report.scenarios.length;
    report.classificationSummary.evidenceScopeCounts.unreported =
      report.scenarios.length;

    writeReportBundle(report, outDir);

    expect(
      JSON.parse(readFileSync(path.join(outDir, "matrix.json"), "utf8")),
    ).toEqual(report);
    expect(readdirSync(outDir).sort()).toEqual([
      "001-todos_create_basic.json",
      "002-email_send_urgent.json",
      "matrix.json",
    ]);
    expect(existsSync(path.join(outDir, "001-todos_create_basic.json"))).toBe(
      true,
    );
  });

  it("replaces existing evidence files atomically without leaving temp files", () => {
    const outDir = makeTempDir("scenario-atomic-");
    const target = path.join(outDir, "matrix.json");
    writeFileSync(target, "previous", "utf-8");

    writeFileAtomic(target, "replacement");

    expect(readFileSync(target, "utf8")).toBe("replacement");
    expect(readdirSync(outDir).filter((name) => name.endsWith(".tmp"))).toEqual(
      [],
    );
  });

  it("rejects forged aggregate profiles and publishability summaries before serialization", () => {
    const forgedProfile = aggregateReport();
    forgedProfile.executionProfile = "provider-qualified";
    expect(() => validateAggregateEvidenceReport(forgedProfile)).toThrow(
      /aggregate executionProfile .* does not match scenario reports/,
    );

    const forgedSummary = aggregateReport();
    forgedSummary.evidenceSummary.publishableScenarioCount = 1;
    const outDir = makeTempDir("scenario-forged-summary-");
    const target = path.join(outDir, "matrix.json");
    expect(() => writeReportBundle(forgedSummary, outDir)).toThrow(
      /aggregate evidenceSummary does not match/,
    );
    expect(existsSync(target)).toBe(false);
  });

  it("prints pipe-safe single-line failure summaries", () => {
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const report = aggregateReport();
    report.scenarios[0] = {
      ...report.scenarios[0],
      status: "failed",
      failedAssertions: [
        {
          type: "responseIncludesAny",
          passed: false,
          detail: "bad | value\nsecond line",
        } as never,
      ],
    };

    printStdoutSummary(report);

    const output = write.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(output).toContain("| todos.create-basic | failed | 1000ms |");
    expect(output).toContain("bad \\| value second line");
    expect(output).not.toContain("bad | value\nsecond line");
  });
});

function writeTrajectory(
  runDir: string,
  relPath: string,
  payload: unknown,
): void {
  const full = path.join(runDir, "trajectories", relPath);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, JSON.stringify(payload), "utf-8");
}

describe("trajectory cost aggregation", () => {
  it("returns 0 when there is no run dir or no trajectories", () => {
    expect(sumTrajectoryCostUsd(undefined)).toBe(0);
    const emptyDir = makeTempDir("scenario-cost-empty-");
    expect(sumTrajectoryCostUsd(emptyDir)).toBe(0);
  });

  it("sums real per-trajectory metrics.totalCostUsd across the run", () => {
    const runDir = makeTempDir("scenario-cost-");
    writeTrajectory(runDir, "agent-1/traj-1.json", {
      trajectoryId: "traj-1",
      metrics: { totalCostUsd: 0.0125 },
      stages: [{ model: { costUsd: 999 } }], // ignored: rolled metric wins
    });
    writeTrajectory(runDir, "agent-2/traj-2.json", {
      trajectoryId: "traj-2",
      metrics: { totalCostUsd: 0.005 },
      stages: [],
    });

    expect(sumTrajectoryCostUsd(runDir)).toBeCloseTo(0.0175, 10);
  });

  it("falls back to stage-level model.costUsd when no rolled metric exists", () => {
    const runDir = makeTempDir("scenario-cost-fallback-");
    writeTrajectory(runDir, "traj-3.json", {
      trajectoryId: "traj-3",
      stages: [
        { model: { costUsd: 0.002 } },
        { model: { costUsd: 0.003 } },
        { kind: "tool" }, // no model stage contributes 0
      ],
    });

    expect(sumTrajectoryCostUsd(runDir)).toBeCloseTo(0.005, 10);
  });

  it("ignores corrupt/NaN/negative costs instead of poisoning the total", () => {
    const runDir = makeTempDir("scenario-cost-corrupt-");
    writeTrajectory(runDir, "good.json", {
      metrics: { totalCostUsd: 0.01 },
    });
    // Unparseable JSON file — must not throw or NaN the total.
    const corruptPath = path.join(runDir, "trajectories", "corrupt.json");
    writeFileSync(corruptPath, "{ not json", "utf-8");
    // Non-numeric / negative rolled metric falls back and stays finite.
    writeTrajectory(runDir, "weird.json", {
      metrics: { totalCostUsd: "NaN" },
      stages: [{ model: { costUsd: -5 } }, { model: { costUsd: 0.004 } }],
    });

    const total = sumTrajectoryCostUsd(runDir);
    expect(Number.isFinite(total)).toBe(true);
    expect(total).toBeCloseTo(0.014, 10);
  });

  it("threads the summed cost into buildAggregate.totalCostUsd (> 0 on a costed run)", () => {
    const runDir = makeTempDir("scenario-cost-aggregate-");
    writeTrajectory(runDir, "traj.json", {
      metrics: { totalCostUsd: 0.0421 },
    });

    const report = buildAggregate(
      [{ ...aggregateReport().scenarios[0] }],
      "anthropic-claude",
      "2026-05-23T00:00:00.000Z",
      "2026-05-23T00:01:00.000Z",
      "run-cost",
      runDir,
    );

    expect(report.totalCostUsd).toBeCloseTo(0.0421, 10);
    expect(report.totals.costUsd).toBeCloseTo(0.0421, 10);
  });
});
