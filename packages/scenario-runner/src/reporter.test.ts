import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AggregateReport } from "./types.ts";
import { writeScenarioRunViewer } from "./reporter.ts";

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
});
