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
      flakyPassed: 0,
      costUsd: 0,
      finalChecksSkipped: 0,
    },
    totalCount: 1,
    passedCount: 1,
    failedCount: 0,
    skippedCount: 0,
    flakyPassedCount: 0,
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
        flakyPassed: 0,
        costUsd: 0,
        finalChecksSkipped: 0,
      },
    });
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
