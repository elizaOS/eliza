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
  writeReportBundle,
  writeScenarioRunViewer,
} from "./reporter.ts";
import type { AggregateReport } from "./types.ts";

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

function aggregateReport(): AggregateReport {
  return {
    runId: "run-1",
    startedAtIso: "2026-05-23T00:00:00.000Z",
    completedAtIso: "2026-05-23T00:01:00.000Z",
    providerName: "deterministic-llm-proxy",
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
        providerName: "deterministic-llm-proxy",
      },
    ],
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
              detail: "dependency missing: no approval queue service registered",
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
