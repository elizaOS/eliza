/**
 * Activation coverage for the LifeOps prompt-benchmark harness (#8795 item 5).
 *
 * `lifeops-prompt-benchmark-runner.ts` + `lifeops-prompt-benchmark-cases.ts`
 * shipped a full token/cost-accounting benchmark apparatus that NO test drove —
 * dead infrastructure. This test exercises every pure scoring/report/export
 * function deterministically against a synthetic case (no live provider),
 * writes a real review bundle, drives the case loader when the scenario
 * corpus is present, and runs the full live benchmark behind an explicit opt-in
 * (`RUN_LIFEOPS_PROMPT_BENCHMARK=1`) for the post-merge / live lane.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writePromptBenchmarkArtifacts } from "./helpers/lifeops-prompt-benchmark-artifacts.js";
import {
  buildLifeOpsPromptBenchmarkCases,
  type PromptBenchmarkCase,
} from "./helpers/lifeops-prompt-benchmark-cases.js";
import {
  buildAxOptimizationRows,
  buildPromptBenchmarkReport,
  collectNativeTrajectoryActionFailures,
  formatPromptBenchmarkReportMarkdown,
  HOST_PROMPT_BENCHMARK_CAPABILITIES,
  MOBILE_PROMPT_BENCHMARK_CAPABILITIES,
  type PromptBenchmarkResult,
  promptBenchmarkActionIsAvailable,
  promptBenchmarkCapabilityUnavailableForCase,
  promptBenchmarkCasePasses,
  promptBenchmarkValidationErrors,
  resolvePromptBenchmarkTerminalOutcome,
  runLifeOpsPromptBenchmark,
  serializeAxOptimizationRows,
} from "./helpers/lifeops-prompt-benchmark-runner.js";

const RUN_LIVE = process.env.RUN_LIFEOPS_PROMPT_BENCHMARK === "1";

const SYNTHETIC_CASE: PromptBenchmarkCase = {
  caseId: "synthetic.calendar.create",
  suiteId: "lifeops-executive-assistant",
  baseScenarioId: "synthetic-base",
  scenarioTitle: "Synthetic calendar create",
  domain: "calendar",
  basePrompt: "schedule lunch with Dana tomorrow at noon",
  prompt: "schedule lunch with Dana tomorrow at noon",
  benchmarkContext: "",
  optimizationTask: "calendar_extract",
  variantId: "direct",
  variantLabel: "Direct",
  axes: [],
  riskClass: "positive",
  benchmarkWeight: 1,
  expectedAction: "CALENDAR",
  acceptableActions: [],
  forbiddenActions: ["BLOCK"],
  expectedOperation: null,
  tags: ["synthetic"],
};

function makeResult(
  testCase: PromptBenchmarkCase,
  actualPrimaryAction: string | null,
): PromptBenchmarkResult {
  const base: PromptBenchmarkResult = {
    case: testCase,
    terminalOutcome: { status: "completed" },
    actualPrimaryAction,
    actualActions: actualPrimaryAction ? [actualPrimaryAction] : [],
    actionFailures: [],
    runtimeErrors: [],
    pass: false,
    latencyMs: 12,
    responseText: "ok",
    llmCallCount: 1,
    trajectoryId: "traj-synthetic",
  };
  return { ...base, pass: promptBenchmarkCasePasses(base) };
}

describe("LifeOps prompt-benchmark harness — activation", () => {
  it("scores a matching action as a pass and a wrong action as a fail", () => {
    expect(makeResult(SYNTHETIC_CASE, "CALENDAR").pass).toBe(true);
    expect(
      makeResult(SYNTHETIC_CASE, "__DEFINITELY_NOT_AN_ACTION__").pass,
    ).toBe(false);
  });

  it("honors forbidden actions", () => {
    // The model produced the forbidden action -> fail regardless of anything else.
    expect(makeResult(SYNTHETIC_CASE, "BLOCK").pass).toBe(false);
  });

  it("aggregates a report, Ax rows, and markdown from results", () => {
    const results = [
      makeResult(SYNTHETIC_CASE, "CALENDAR"), // pass
      makeResult(SYNTHETIC_CASE, "__DEFINITELY_NOT_AN_ACTION__"), // fail
    ];
    const report = buildPromptBenchmarkReport({
      capabilityProfile: "host",
      providerName: "synthetic",
      results,
    });

    expect(report.total).toBe(2);
    expect(report.passed).toBe(1);
    expect(report.failed).toBe(1);
    expect(report.accuracy).toBeCloseTo(0.5, 5);
    expect(report.trajectoryCaptureRate).toBeCloseTo(1, 5);

    const rows = buildAxOptimizationRows(report);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.id).toBe(SYNTHETIC_CASE.caseId);
    expect(rows[0]?.expected.action).toBe("CALENDAR");

    const jsonl = serializeAxOptimizationRows(rows);
    const lines = jsonl.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(() => JSON.parse(lines[0] ?? "")).not.toThrow();

    const markdown = formatPromptBenchmarkReportMarkdown(report);
    expect(markdown).toContain("# LifeOps Prompt Benchmark");
    expect(markdown).toContain("50.0%");
  });

  it("writes a digest manifest covering rows and native trajectories", async () => {
    const artifactDir = await mkdtemp(
      path.join(os.tmpdir(), "lifeops-prompt-artifacts-"),
    );
    try {
      const nativeRelativePath = path.join(
        "native-trajectories",
        "synthetic-agent",
        "traj-synthetic.json",
      );
      await mkdir(path.dirname(path.join(artifactDir, nativeRelativePath)), {
        recursive: true,
      });
      await writeFile(
        path.join(artifactDir, nativeRelativePath),
        '{"status":"finished"}\n',
        "utf8",
      );
      const result = {
        ...makeResult(SYNTHETIC_CASE, "CALENDAR"),
        nativeTrajectoryId: "traj-synthetic",
        nativeTrajectoryStatus: "finished" as const,
        nativeTrajectoryRelativePath: path.join(
          "synthetic-agent",
          "traj-synthetic.json",
        ),
      };
      const report = buildPromptBenchmarkReport({
        capabilityProfile: "host",
        providerName: "synthetic",
        results: [result],
      });

      const manifest = await writePromptBenchmarkArtifacts({
        artifactDir,
        report,
      });
      expect(manifest.files.map((file) => file.path)).toEqual(
        expect.arrayContaining([
          "cases.jsonl",
          "report.json",
          "report.md",
          nativeRelativePath,
        ]),
      );
      expect(
        manifest.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256)),
      ).toBe(true);
      const persistedManifest = JSON.parse(
        await readFile(path.join(artifactDir, "manifest.json"), "utf8"),
      ) as { selectedCases: number };
      expect(persistedManifest.selectedCases).toBe(1);
    } finally {
      await rm(artifactDir, { recursive: true, force: true });
    }
  });

  it("fails validation when a runtime reports an error during a case", () => {
    const runtimeErrors = [
      {
        scope: "presence_signal_bridge",
        code: "KNOWLEDGE_GRAPH_UNAVAILABLE",
        message: "KnowledgeGraphService is not registered",
        at: Date.now(),
      },
    ];
    const terminalOutcome = resolvePromptBenchmarkTerminalOutcome({
      actionFailures: [],
      runtimeErrors,
      requireNativeTrajectory: false,
    });
    const result: PromptBenchmarkResult = {
      ...makeResult(SYNTHETIC_CASE, "CALENDAR"),
      terminalOutcome,
      runtimeErrors,
      pass: false,
    };
    const report = buildPromptBenchmarkReport({
      capabilityProfile: "host",
      providerName: "synthetic",
      results: [result],
    });

    expect(report.terminalFailed).toBe(1);
    expect(
      promptBenchmarkValidationErrors({ minimumAccuracy: 0, report }),
    ).toContain(
      "synthetic.calendar.create: runtime_error: presence_signal_bridge:KNOWLEDGE_GRAPH_UNAVAILABLE: KnowledgeGraphService is not registered",
    );
  });

  it("fails validation when repeated tool failure terminates an action", () => {
    const actionFailures = [
      {
        actionName: "BLOCK_STATUS",
        actionStatus: "failed",
        error:
          "Repeated tool failure limit exceeded: App blocking is mobile-only.",
      },
    ];
    const terminalOutcome = resolvePromptBenchmarkTerminalOutcome({
      actionFailures,
      runtimeErrors: [],
      requireNativeTrajectory: false,
    });
    const result: PromptBenchmarkResult = {
      ...makeResult(SYNTHETIC_CASE, "BLOCK_STATUS"),
      terminalOutcome,
      actionFailures,
      pass: false,
    };
    const report = buildPromptBenchmarkReport({
      capabilityProfile: "host",
      providerName: "synthetic",
      results: [result],
    });

    expect(report.terminalFailed).toBe(1);
    expect(
      promptBenchmarkValidationErrors({ minimumAccuracy: 0, report })[0],
    ).toContain("action_failed: BLOCK_STATUS: Repeated tool failure limit");
  });

  it("fails a native tool service error even when confirmation is requested", () => {
    const actionFailures = collectNativeTrajectoryActionFailures({
      stages: [
        {
          stageId: "stage-tool-personal-assistant",
          kind: "tool",
          startedAt: 1,
          endedAt: 2,
          latencyMs: 1,
          tool: {
            name: "PERSONAL_ASSISTANT",
            args: { action: "scheduling" },
            result: {
              success: false,
              data: {
                error: "SERVICE_ERROR",
                requiresConfirmation: true,
              },
            },
            success: false,
            durationMs: 1,
          },
        },
      ],
    });
    const terminalOutcome = resolvePromptBenchmarkTerminalOutcome({
      actionFailures,
      runtimeErrors: [],
      requireNativeTrajectory: false,
    });

    expect(actionFailures).toEqual([
      {
        actionName: "PERSONAL_ASSISTANT",
        actionStatus: "failed",
        error: "SERVICE_ERROR",
      },
    ]);
    expect(terminalOutcome).toMatchObject({
      status: "failed",
      failureKind: "action_failed",
    });
  });

  it("keeps designed native clarification as a completed interaction", () => {
    const actionFailures = collectNativeTrajectoryActionFailures({
      stages: [
        {
          stageId: "stage-tool-owner-routines-create",
          kind: "tool",
          startedAt: 1,
          endedAt: 2,
          latencyMs: 1,
          tool: {
            name: "OWNER_ROUTINES_CREATE",
            args: { title: "Brush teeth" },
            result: {
              success: false,
              text: "Confirm and I'll save it.",
              data: {
                error: "MISSING_DEFINITION_FIELD",
                requiresConfirmation: true,
              },
            },
            success: false,
            durationMs: 1,
          },
        },
      ],
    });

    expect(actionFailures).toEqual([]);
    expect(
      resolvePromptBenchmarkTerminalOutcome({
        actionFailures,
        runtimeErrors: [],
        requireNativeTrajectory: false,
      }),
    ).toEqual({ status: "completed" });
  });

  it("fails validation when a trajectory remains active", () => {
    const terminalOutcome = resolvePromptBenchmarkTerminalOutcome({
      actionFailures: [],
      runtimeErrors: [],
      trajectoryStatus: "active",
      nativeTrajectory: { status: "finished" },
      requireNativeTrajectory: true,
    });
    const result: PromptBenchmarkResult = {
      ...makeResult(SYNTHETIC_CASE, "CALENDAR"),
      terminalOutcome,
      trajectoryStatus: "active",
      nativeTrajectoryStatus: "finished",
      pass: false,
    };
    const report = buildPromptBenchmarkReport({
      capabilityProfile: "host",
      providerName: "synthetic",
      results: [result],
    });

    expect(report.terminalFailed).toBe(1);
    expect(
      promptBenchmarkValidationErrors({ minimumAccuracy: 0, report })[0],
    ).toContain("incomplete: Trajectory did not reach a terminal status");
  });

  it("keeps explicit capability unavailability distinct from failure", () => {
    const unavailable: PromptBenchmarkResult = {
      ...makeResult(SYNTHETIC_CASE, null),
      terminalOutcome: {
        status: "capability_unavailable",
        capability: "OWNER_SCREENTIME",
        reason: "Native screen-time signals require a mobile device.",
      },
      pass: false,
    };
    const report = buildPromptBenchmarkReport({
      capabilityProfile: "host",
      providerName: "synthetic",
      results: [unavailable],
    });

    expect(report.unavailable).toBe(1);
    expect(report.terminalFailed).toBe(0);
    expect(
      promptBenchmarkValidationErrors({ minimumAccuracy: 0, report }),
    ).toEqual([]);
  });

  it("structurally filters mobile-only actions from the host profile", () => {
    expect(
      promptBenchmarkActionIsAvailable(
        "BLOCK_STATUS",
        HOST_PROMPT_BENCHMARK_CAPABILITIES,
      ),
    ).toBe(false);
    expect(
      promptBenchmarkActionIsAvailable(
        "BLOCK_STATUS",
        MOBILE_PROMPT_BENCHMARK_CAPABILITIES,
      ),
    ).toBe(true);
    expect(
      HOST_PROMPT_BENCHMARK_CAPABILITIES.unavailableExpectedActions
        .OWNER_SCREENTIME,
    ).toContain("hosted Linux benchmark runtime");
    expect(
      promptBenchmarkCapabilityUnavailableForCase({
        capabilityProfile: HOST_PROMPT_BENCHMARK_CAPABILITIES,
        testCase: SYNTHETIC_CASE,
      }),
    ).toMatchObject({
      status: "capability_unavailable",
      capability: "CALENDAR",
    });
    expect(
      promptBenchmarkCapabilityUnavailableForCase({
        capabilityProfile: MOBILE_PROMPT_BENCHMARK_CAPABILITIES,
        testCase: SYNTHETIC_CASE,
      }),
    ).toBeNull();

    const meetingPrepCase: PromptBenchmarkCase = {
      ...SYNTHETIC_CASE,
      caseId: "lifeops-capability.meeting_prep__direct",
      expectedAction: "BRIEF",
    };
    expect(
      promptBenchmarkCapabilityUnavailableForCase({
        capabilityProfile: HOST_PROMPT_BENCHMARK_CAPABILITIES,
        testCase: meetingPrepCase,
      }),
    ).toMatchObject({
      status: "capability_unavailable",
      capability: "MEETING_DOSSIER",
    });
  });

  it("loads the case catalog when the scenario corpus is present", async () => {
    // The catalog dynamically imports the `test/scenarios/**` corpus, which is
    // not vendored into every checkout. Exercise the loader when present; skip
    // (not fail) when the corpus is absent so the pure-function coverage above
    // still guards the harness in a minimal checkout.
    let cases: PromptBenchmarkCase[] | null = null;
    try {
      cases = await buildLifeOpsPromptBenchmarkCases();
    } catch (err) {
      console.warn(
        `[lifeops-benchmark] scenario corpus unavailable; skipping loader assertion: ${String(err)}`,
      );
      return;
    }
    expect(cases.length).toBeGreaterThan(0);
    for (const testCase of cases) {
      expect(testCase.caseId).toBeTruthy();
      expect(testCase.prompt).toBeTruthy();
      expect(typeof testCase.benchmarkWeight).toBe("number");
    }
  });

  it.skipIf(!RUN_LIVE)(
    "runs the full live benchmark over the case catalog",
    async () => {
      const cases = await buildLifeOpsPromptBenchmarkCases();
      const report = await runLifeOpsPromptBenchmark({
        cases: cases.slice(0, 5),
        isolate: "shared",
      });
      expect(report.total).toBeGreaterThan(0);
      expect(report.passed).toBeGreaterThan(0);
    },
    600_000,
  );
});
