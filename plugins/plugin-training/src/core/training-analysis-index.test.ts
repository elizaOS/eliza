import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BENCHMARK_MATRIX_ARTIFACT_SCHEMA,
  BENCHMARK_MATRIX_ARTIFACT_VERSION,
} from "./benchmark-matrix-artifact.js";
import {
  EVAL_COMPARISON_ARTIFACT_SCHEMA,
  EVAL_COMPARISON_ARTIFACT_VERSION,
} from "./eval-comparison-artifact.js";
import { ELIZA1_BUNDLE_STAGE_SCHEMA } from "./eliza1-bundle-stager.js";
import {
  buildTrainingAnalysisIndex,
  TRAINING_ANALYSIS_INDEX_SCHEMA,
} from "./training-analysis-index.js";
import {
  TRAJECTORY_EXPORT_BUNDLE_SCHEMA,
  TRAJECTORY_EXPORT_BUNDLE_VERSION,
  type TrajectoryExportBundleManifest,
} from "./trajectory-export-bundle.js";
import type { TrainingRunRecord } from "./training-orchestrator.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "training-analysis-index-"));
  tempDirs.push(dir);
  return dir;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeJsonl(path: string, rows: unknown[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    "utf8",
  );
}

describe("training analysis index", () => {
  afterEach(async () => {
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("indexes trajectory bundles, training runs, evals, and model manifests", async () => {
    const root = await makeTempDir();
    const outputDir = join(root, "analysis");
    const bundleManifest: TrajectoryExportBundleManifest = {
      schema: TRAJECTORY_EXPORT_BUNDLE_SCHEMA,
      schemaVersion: TRAJECTORY_EXPORT_BUNDLE_VERSION,
      generatedAt: "2026-01-02T03:04:05.000Z",
      runId: "run-1",
      source: {
        kind: "training_collection_natural_trajectories",
        runId: "run-1",
        runIds: ["run-1"],
        inputTrajectoryCount: 2,
        sanitizedTrajectoryCount: 2,
        droppedTrajectoryCount: 0,
      },
      paths: {
        bundleDir: join(root, "bundles", "run-1"),
        manifestPath: join(root, "bundles", "run-1", "manifest.json"),
        viewerHtmlPath: join(root, "bundles", "run-1", "index.html"),
        rawJsonlPath: join(root, "bundles", "run-1", "raw", "trajectories.jsonl"),
        sanitizedJsonlPath: join(
          root,
          "bundles",
          "run-1",
          "sanitized",
          "trajectories.sanitized.jsonl",
        ),
        taskDatasetDir: join(root, "bundles", "run-1", "tasks"),
        taskDatasetSummaryPath: join(
          root,
          "bundles",
          "run-1",
          "tasks",
          "summary.json",
        ),
      },
      counts: {
        rawTrajectoryRows: 0,
        sanitizedTrajectoryRows: 2,
        taskRows: {
          should_respond: 0,
          context_routing: 0,
          action_planner: 1,
          response: 1,
          media_description: 0,
        },
        taskFiles: 2,
        taskExamples: 2,
        llmCalls: 2,
        skippedNonNativeRows: 0,
      },
      tasks: {
        action_planner: {
          path: join(root, "bundles", "run-1", "tasks", "action_planner.jsonl"),
          exampleCount: 1,
          sourceCallCount: 1,
          sourceTrajectoryCount: 1,
        },
        response: {
          path: join(root, "bundles", "run-1", "tasks", "response.jsonl"),
          exampleCount: 1,
          sourceCallCount: 1,
          sourceTrajectoryCount: 1,
        },
      },
      privacy: {
        applied: true,
        redactionCount: 0,
        anonymizationCount: 0,
        droppedCount: 0,
        dropped: [],
      },
      cloudUpload: {
        uploadedToHuggingFace: true,
        huggingFaceRepo: "elizaos/eliza-1-trajectories",
        huggingFacePath: "trajectories/run-1.jsonl",
      },
    };
    const runRecord: TrainingRunRecord = {
      runId: "run-1",
      status: "succeeded",
      task: "action_planner",
      backend: "native",
      source: "manual",
      datasetSize: 12,
      startedAt: "2026-01-02T03:00:00.000Z",
      finishedAt: "2026-01-02T03:05:00.000Z",
      artifactPath: join(root, "artifacts", "run-1.json"),
      pulledTrajectories: 20,
      filteredTrajectories: 18,
      redactionCount: 1,
      anonymizationCount: 2,
      dryRun: false,
    };

    await writeJson(
      join(root, "bundles", "run-1", "manifest.json"),
      bundleManifest,
    );
    await writeJsonl(bundleManifest.paths.sanitizedJsonlPath!, [
      {
        trajectoryId: "run-1-traj-1",
        agentId: "agent-1",
        durationMs: 1000,
        steps: [
          {
            stepId: "step-1",
            llmCalls: [
              {
                callId: "call-response-1",
                purpose: "response",
                model: "eliza-1-0.8b-test",
                systemPrompt: "Reply as Eliza.",
                userPrompt: "user asks for help",
                response: "agent gives a useful answer",
              },
              {
                callId: "call-action-1",
                purpose: "action_planner",
                modelType: "eliza-1-0.8b-test",
                systemPrompt: "Pick one action.",
                userPrompt: "choose the next action",
                response: "SEND_MESSAGE",
              },
            ],
          },
        ],
      },
      {
        schema: "eliza_benchmark_canonical_call_v1",
        agent: "eliza",
        run_id: "run-1-canonical",
        kind: "action",
        model: "gpt-oss-120b",
        prompt: "channel_type: dm\nincoming_message: \"good morning\"",
        response: "Action completed.",
        actions: ["REPLY"],
      },
    ]);
    await writeJson(join(root, "runs", "run-1.json"), runRecord);
    await writeJson(join(root, "checkpoints", "run-1", "eval-1.json"), {
      benchmark_id: "lifeops_bench",
      model: "eliza-1-0b-trained",
      score: 0.62,
      improvementPct: 24,
    });
    await writeJson(join(root, "evals", "comparison", "eval-comparison.json"), {
      schema: EVAL_COMPARISON_ARTIFACT_SCHEMA,
      version: EVAL_COMPARISON_ARTIFACT_VERSION,
      generatedAt: "2026-01-02T03:20:00.000Z",
      reportPath: join(
        root,
        "evals",
        "comparison",
        "local_model_comparison.json",
      ),
      source: { kind: "training_local_eval_comparison" },
      models: {
        base: "eliza-1-0b-base",
        trained: "eliza-1-0b-trained",
        backend: "cpu",
      },
      metrics: {
        baseScore: 0.5,
        trainedScore: 0.62,
        improvementAbsolute: 0.12,
        improvementPercent: 24,
        baseLatencyMs: 100,
        trainedLatencyMs: 110,
        latencyDeltaMs: 10,
        promptCount: 12,
        distinctResponseCount: 9,
      },
      summaries: {
        base: { avg_score: 0.5 },
        trained: { avg_score: 0.62 },
        comparison: {
          distinct_response_count: 9,
          per_prompt: [
            {
              prompt: "choose a tool for sending an update",
              expected: "SEND_MESSAGE",
              base_response: "REPLY",
              trained_response: "SEND_MESSAGE",
              base_score: 0,
              trained_score: 1,
              improvement: 1,
            },
          ],
        },
      },
      raw: {},
    });
    await writeJson(join(root, "action-benchmark-report.json"), {
      schema: "eliza_action_selection_benchmark_report",
      schemaVersion: 1,
      generatedAt: "2026-01-02T03:18:00.000Z",
      source: {
        kind: "app_core_action_selection_benchmark",
        trajectoryDir: join(root, "action-benchmark-report"),
        reportMarkdownPath: join(root, "action-benchmark-report.md"),
      },
      summary: {
        total: 1,
        passed: 1,
        failed: 0,
        accuracy: 1,
        plannerAccuracy: 1,
        executionAccuracy: 1,
        latency: { avg: 42, p50: 42, p95: 42 },
      },
      byTag: {
        message: { total: 1, passed: 1, accuracy: 1 },
      },
      failureModes: {
        passed: 1,
        validate_filtered: 0,
        llm_chose_reply: 0,
        llm_chose_other_action: 0,
        no_response: 0,
        error: 0,
      },
      failures: [],
      results: [
        {
          caseId: "message-route",
          prompt: "send David the update",
          expectedAction: "MESSAGE",
          actualAction: "MESSAGE",
          response: "Message queued for David.",
          pass: true,
          latencyMs: 42,
          tags: ["message"],
          trajectoryPath: join(
            root,
            "action-benchmark-report",
            "cases",
            "message-route.json",
          ),
        },
      ],
    });
    await writeJson(
      join(root, "benchmarks", "matrix", "benchmark-matrix.json"),
      {
        schema: BENCHMARK_MATRIX_ARTIFACT_SCHEMA,
        version: BENCHMARK_MATRIX_ARTIFACT_VERSION,
        generatedAt: "2026-01-02T03:25:00.000Z",
        source: { kind: "training_benchmark_matrix" },
        referenceModelId: "cerebras/gpt-oss-120b",
        tiers: ["0b"],
        benchmarks: ["eliza_harness_action_reason"],
        counts: {
          rows: 3,
          comparisons: 1,
          tiers: 1,
          benchmarks: 1,
        },
        rows: [
          {
            modelId: "eliza-1-0b-base",
            benchmark: "eliza_harness_action_reason",
            score: 0.4,
            variant: "base",
            tier: "0b",
            provider: "local-llama-cpp",
            metrics: { total: 1, passed: 0, failed: 1, useMocks: false },
            raw: {
              artifactPath: join(root, "action-benchmark-report-base.json"),
              useMocks: false,
            },
          },
          {
            modelId: "eliza-1-0b-trained",
            benchmark: "eliza_harness_action_reason",
            score: 0.5,
            variant: "trained",
            tier: "0b",
            provider: "local-llama-cpp",
            metrics: { total: 1, passed: 1, failed: 0, useMocks: false },
            raw: {
              artifactPath: join(root, "action-benchmark-report.json"),
              useMocks: false,
              caseSamples: [
                {
                  caseId: "message-route",
                  prompt: "send David the update",
                  expectedAction: "MESSAGE",
                  actualAction: "MESSAGE",
                  pass: true,
                  response: "Message queued for David.",
                  trajectoryPath: join(
                    root,
                    "action-benchmark-report",
                    "cases",
                    "message-route.json",
                  ),
                },
              ],
            },
          },
        ],
        comparisons: [
          {
            tier: "0b",
            benchmark: "eliza_harness_action_reason",
            baseScore: 0.4,
            trainedScore: 0.5,
            referenceScore: 0.8,
            improvementPercent: 25,
          },
        ],
      },
    );
    await writeJson(
      join(root, "checkpoints", "run-1", "training_manifest.json"),
      {
        model_name: "eliza-1-0b-trained",
        base_model: "eliza-1-0b-base",
        output_path: join(root, "checkpoints", "run-1", "final"),
        served_evaluation: {
          base_summary: { avg_score: 0.5 },
          adapter_summary: { avg_score: 0.62 },
        },
      },
    );
    await writeJson(join(root, "models", "2b-model-manifest.json"), {
      schema: "eliza1_model_registry_entry",
      model: "eliza-1-2b-trained",
      variant: "trained",
      tier: "2b",
      outputPath: "hf://elizaos/eliza-1-2b-trained",
      baseModel: "eliza-1-2b-base",
      repoId: "elizaos/eliza-1-2b-trained",
    });
    await writeJson(
      join(root, "staged-bundles", "eliza1-bundle-stage-manifest.json"),
      {
        schema: ELIZA1_BUNDLE_STAGE_SCHEMA,
        schemaVersion: 1,
        generatedAt: "2026-01-02T03:08:00.000Z",
        trainingRoot: join(root, "packages", "training"),
        outputDir: join(root, "staged-bundles"),
        manifestPath: join(
          root,
          "staged-bundles",
          "eliza1-bundle-stage-manifest.json",
        ),
        command: ["python3", "stage_hf_eliza1_bundle.py"],
        exitCode: 0,
        repoId: "elizaos/eliza-1",
        tier: "0_8b",
        bundleDir: "/tmp/eliza-1-bundles/eliza-1-0_8b.bundle",
        fileCount: 87,
        plannedBytes: 5_939_381_241,
        maxBytes: 8_589_934_592,
        apply: false,
        stagedCount: 0,
        plan: {
          repoId: "elizaos/eliza-1",
          tier: "0_8b",
          bundleDir: "/tmp/eliza-1-bundles/eliza-1-0_8b.bundle",
        },
      },
    );
    await writeJson(join(root, "scenario-native.manifest.json"), {
      schema: "eliza_scenario_native_export",
      schemaVersion: 1,
      generatedAt: "2026-01-02T03:10:00.000Z",
      runDir: join(root, "scenario-run"),
      trajectoriesDir: join(root, "scenario-run", "trajectories"),
      jsonlPath: join(root, "scenario-native.jsonl"),
      manifestPath: join(root, "scenario-native.manifest.json"),
      counts: {
        trajectoryFiles: 3,
        parsedTrajectories: 2,
        skippedFiles: 1,
        rows: 5,
      },
      runIds: ["scenario-run-1"],
      scenarioIds: ["lifeops.basic"],
      agentIds: ["agent-1"],
    });
    await writeJsonl(join(root, "scenario-native.jsonl"), [
      {
        format: "eliza_native_v1",
        schemaVersion: 1,
        boundary: "vercel_ai_sdk.generateText",
        trajectoryId: "scenario-traj-1",
        agentId: "agent-1",
        scenarioId: "lifeops.basic",
        purpose: "planner",
        model: "deterministic-proxy",
        provider: "scenario-runner",
        request: {
          messages: [{ role: "user", content: "check in" }],
        },
        response: {
          text: "scheduled",
          toolCalls: [
            {
              toolCallId: "call-1",
              toolName: "CREATE_SCHEDULED_TASK",
              input: { title: "check in" },
            },
          ],
        },
        metadata: {
          task_type: "action_planner",
          source_dataset: "scenario_trajectory_boundary",
          source_stage_kind: "planner",
          scenario_id: "lifeops.basic",
        },
      },
    ]);
    await writeJson(join(root, "scenario-run", "matrix.json"), {
      runId: "scenario-run-1",
      startedAtIso: "2026-01-02T03:08:00.000Z",
      completedAtIso: "2026-01-02T03:09:00.000Z",
      providerName: "deterministic-proxy",
      scenarios: [
        {
          id: "lifeops.basic",
          title: "LifeOps basic check-in",
          domain: "lifeops",
          tags: ["training", "scenario"],
          status: "passed",
          durationMs: 1234,
          turns: [
            {
              name: "turn-1",
              kind: "user",
              text: "check in",
              responseText: "scheduled",
              actionsCalled: [{ name: "CREATE_SCHEDULED_TASK" }],
              failedAssertions: [],
            },
          ],
          failedAssertions: [],
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
    });
    await writeJson(join(root, "feed-export.manifest.json"), {
      schema: "feed_training_trajectory_export",
      schemaVersion: 1,
      generatedAt: "2026-01-02T03:15:00.000Z",
      exportPath: join(root, "feed-export.jsonl"),
      manifestPath: join(root, "feed-export.manifest.json"),
      source: {
        kind: "feed_train_archetype_export",
        archetype: "trader",
      },
      counts: {
        trajectories: 4,
      },
      scenarioIds: ["multi-archetype-trader"],
      agentIds: ["feed-agent-1"],
    });
    await writeJsonl(join(root, "feed-export.jsonl"), [
      {
        trajectory_id: "feed-traj-1",
        agent_id: "feed-agent-1",
        archetype: "trader",
        score: 0.87,
        reasoning: "profitable and coherent",
        scenario_id: "multi-archetype-trader",
        final_pnl: 42,
        steps: [
          {
            action: "BUY",
            marketId: "market-1",
            input: "market odds moved",
            output: "opened long position",
          },
        ],
      },
    ]);
    await writeJson(
      join(root, "action-benchmark-report", "cases", "message-route.json"),
      {
        caseId: "message-route",
        scenarioId: "action-selection.message",
        startedAt: Date.UTC(2026, 0, 2, 3, 16, 0),
        endedAt: Date.UTC(2026, 0, 2, 3, 16, 2),
        durationMs: 2000,
        roomId: "00000000-0000-4000-8000-000000000001",
        userId: "00000000-0000-4000-8000-000000000002",
        transcript: [
          {
            role: "user",
            text: "send David the update",
            timestamp: Date.UTC(2026, 0, 2, 3, 16, 0),
          },
          {
            role: "assistant",
            text: "I sent it.",
            timestamp: Date.UTC(2026, 0, 2, 3, 16, 1),
            actions: ["SEND_MESSAGE"],
          },
        ],
        agentTrajectory: {
          llmCalls: [
            {
              callId: "llm-1",
              timestamp: Date.UTC(2026, 0, 2, 3, 16, 1),
              latencyMs: 42,
              modelType: "TEXT_LARGE",
              purpose: "action_planner",
              prompt: "choose an action",
              response: "SEND_MESSAGE",
            },
          ],
          providerSnapshots: [
            {
              timestamp: Date.UTC(2026, 0, 2, 3, 16, 1),
              includeList: null,
              providers: [],
            },
          ],
        },
        actions: [
          {
            phase: "completed",
            actionName: "SEND_MESSAGE",
            actionStatus: "success",
            timestamp: Date.UTC(2026, 0, 2, 3, 16, 1),
          },
        ],
        events: [
          {
            type: "MODEL_USED",
            timestamp: Date.UTC(2026, 0, 2, 3, 16, 1),
            data: { modelType: "TEXT_LARGE" },
          },
        ],
        memoriesWritten: [],
        metadata: {
          expectedAction: "SEND_MESSAGE",
          plannedAction: "SEND_MESSAGE",
          actualAction: "SEND_MESSAGE",
          pass: true,
          selectionPass: true,
          executionPass: true,
          tags: ["message", "benchmark"],
        },
      },
    );
    await writeJson(
      join(root, "action-benchmark-report", "cases", "empty-reply.json"),
      {
        caseId: "empty-reply",
        startedAt: Date.UTC(2026, 0, 2, 3, 16, 3),
        endedAt: Date.UTC(2026, 0, 2, 3, 16, 4),
        durationMs: 1000,
        transcript: [
          {
            role: "user",
            text: "hey",
            timestamp: Date.UTC(2026, 0, 2, 3, 16, 3),
          },
          {
            role: "assistant",
            text: "",
            timestamp: Date.UTC(2026, 0, 2, 3, 16, 4),
          },
        ],
        agentTrajectory: {
          llmCalls: [
            {
              callId: "llm-empty-1",
              timestamp: Date.UTC(2026, 0, 2, 3, 16, 4),
              latencyMs: 8,
              modelType: "TEXT_LARGE",
              purpose: "reply",
              prompt: "reply to greeting",
              response: "",
            },
          ],
          providerSnapshots: [],
        },
        actions: [],
        events: [{ type: "RUN_ENDED", timestamp: Date.UTC(2026, 0, 2, 3, 16, 4), data: {} }],
        memoriesWritten: [
          {
            timestamp: Date.UTC(2026, 0, 2, 3, 16, 4),
            tableName: "messages",
            contentActions: ["REPLY"],
            raw: { content: { actions: ["REPLY"], text: "" } },
          },
        ],
        metadata: {
          pass: true,
          selectionPass: true,
          executionPass: true,
          tags: ["chat", "negative"],
        },
      },
    );
    await writeJsonl(join(root, "hf", "eliza-1-trajectories.jsonl"), [
      {
        schema: "eliza.eliza1_trajectory_record.v1",
        source_dataset: "runtime_trajectory_boundary",
        trajectoryId: "hf-traj-1",
        task: "action_planner",
        input: "user asked for a plan",
        output: "agent selected the planning action",
      },
      {
        schema: "eliza.eliza1_trajectory_record.v1",
        source_dataset: "runtime_trajectory_boundary",
        trajectoryId: "hf-traj-2",
        task: "response",
        messages: [{ role: "user", content: "status?" }],
        output: "agent replied with current status",
      },
    ]);
    await writeJsonl(join(root, "hf", "sft", "0_8b", "train.jsonl"), [
      {
        schema: "eliza.eliza1_sft_record.v1",
        source_dataset: "huggingface_sft",
        trajectoryId: "hf-sft-traj-1",
        task: "response",
        input: "hello from hf sft",
        output: "hello from eliza",
      },
      {
        schema: "eliza.eliza1_sft_record.v1",
        source_dataset: "huggingface_sft",
        trajectoryId: "hf-sft-chat-traj-1",
        task: "response",
        messages: [
          { role: "system", content: "You are Eliza." },
          { role: "user", content: "summarize the feed run" },
          { role: "assistant", content: "the feed run completed cleanly" },
        ],
      },
    ]);
    await writeJson(join(root, "hf", "huggingface-dataset-manifest.json"), {
      schema: "eliza_huggingface_dataset_ingest",
      schemaVersion: 1,
      generatedAt: "2026-01-02T03:30:00.000Z",
      source: {
        kind: "huggingface_dataset",
        repoId: "elizaos/eliza-1-training",
        revision: "main",
      },
      outputDir: join(root, "hf"),
      manifestPath: join(root, "hf", "huggingface-dataset-manifest.json"),
      counts: {
        files: 2,
        downloadedFiles: 2,
        dryRunFiles: 0,
        jsonlRows: 12,
        bytes: 1024,
      },
      files: [
        {
          hfPath: "sft/0_8b/train.jsonl",
          url: "https://huggingface.co/datasets/elizaos/eliza-1-training/resolve/main/sft/0_8b/train.jsonl",
          localPath: join(root, "hf", "sft", "0_8b", "train.jsonl"),
          bytes: 1000,
          sha256: "abc",
          rows: 12,
          contentType: "application/x-ndjson",
          status: "downloaded",
        },
      ],
    });

    const index = await buildTrainingAnalysisIndex({
      roots: [root],
      outputDir,
      now: () => new Date("2026-01-02T04:00:00.000Z"),
    });

    expect(index.manifest.schema).toBe(TRAINING_ANALYSIS_INDEX_SCHEMA);
    expect(index.manifest.counts).toMatchObject({
      trajectoryBundles: 1,
      trajectoryDatasets: 10,
      scenarioRuns: 1,
      trainingRuns: 1,
      evals: 3,
      benchmarkMatrices: 1,
      models: 3,
      artifacts: 20,
    });
    expect(index.manifest.coverage).toMatchObject({
      dataSources: {
        huggingFace: 1,
        feed: 1,
        natural: 1,
        scenarios: 2,
        tests: 2,
        trainingJsonl: 5,
      },
      readableSamples: {
        huggingFace: 2,
        feed: 1,
        natural: 4,
        scenarios: 2,
        tests: 2,
        trainingJsonl: 8,
        total: 19,
      },
      evals: {
        artifacts: 3,
        comparisons: 1,
        scoredComparisons: 1,
      },
      benchmarks: {
        matrices: 1,
        comparisons: 1,
        scoredComparisons: 1,
        caseSamples: 1,
        tiers: ["0_8b"],
        allEliza1TiersCovered: false,
      },
      models: {
        artifacts: 3,
      },
    });
    expect(index.manifest.coverage.benchmarks.tierCoverage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tier: "0_8b",
          hasBase: true,
          hasTrained: true,
          hasReference: true,
          hasImprovement: true,
        }),
        expect.objectContaining({
          tier: "27b",
          hasBase: false,
          hasTrained: false,
          hasReference: false,
          hasImprovement: false,
        }),
      ]),
    );
    expect(
      index.manifest.artifacts.map((artifact) => artifact.kind).sort(),
    ).toEqual([
      "benchmark_matrix",
      "eval",
      "eval",
      "eval",
      "model",
      "model",
      "model",
      "scenario_run",
      "training_run",
      "trajectory_bundle",
      "trajectory_dataset",
      "trajectory_dataset",
      "trajectory_dataset",
      "trajectory_dataset",
      "trajectory_dataset",
      "trajectory_dataset",
      "trajectory_dataset",
      "trajectory_dataset",
      "trajectory_dataset",
      "trajectory_dataset",
    ]);

    const html = await readFile(index.indexHtmlPath, "utf8");
    expect(html).toContain("Eliza Training Analysis");
    expect(html).toContain("Source inventory");
    expect(html).toContain("Readable source samples");
    expect(html).toContain("sourceSampleRowsForArtifact");
    expect(html).toContain("renderSourceSamples");
    expect(html).toContain("No readable samples indexed for this source.");
    expect(html).toContain("End-to-end coverage");
    expect(html).toContain("All Eliza-1 tiers");
    expect(html).toContain("Hugging Face");
    expect(html).toContain("Natural trajectories");
    expect(html).toContain("Training JSONL");
    expect(html).toContain("Source files");
    expect(html).toContain("appendPathCell");
    expect(html).toContain("hrefForPath");
    expect(html).toContain("Payload");
    expect(html).toContain("Benchmark Comparisons");
    expect(html).toContain("Benchmark Case Samples");
    expect(html).toContain("Model Tracking");
    expect(html).toContain("Eval Metrics");
    expect(html).toContain("Action Benchmark Results");
    expect(html).toContain("Training JSONL Samples");
    expect(html).toContain("Hugging Face Dataset Files");
    expect(html).toContain("Hugging Face Dataset Samples");
    expect(html).toContain("Scenario Turn Previews");
    expect(html).toContain("Scenario Native Samples");
    expect(html).toContain("Trajectory Bundle Samples");
    expect(html).toContain("raw-jsonl");
    expect(html).toContain("sanitized-jsonl");
    expect(html).toContain("task-dataset-summary");
    expect(html).toContain("task-action_planner");
    expect(html).toContain("Test Trajectory Samples");
    expect(html).toContain("Test Trajectory Transcript");
    expect(html).toContain("Test Trajectory LLM Calls");
    expect(html).toContain("Test Trajectory Actions");
    expect(html).toContain("Trajectory Bundle LLM Calls");
    expect(html).toContain("run-1-traj-1");
    expect(html).toContain("Trajectories");
    expect(html).toContain("Scenarios");
    expect(html).toContain("lifeops_bench");
    expect(html).toContain("deterministic-proxy");
    expect(html).toContain("CREATE_SCHEDULED_TASK");
    expect(html).toContain("scenario-traj-1");
    expect(html).toContain("action_planner");
    expect(html).toContain("Pick one action.");
    expect(html).toContain("SEND_MESSAGE");
    expect(html).toContain("lifeops.basic");
    expect(html).toContain("feed_train_archetype_export");
    expect(html).toContain("Feed Generation");
    expect(html).toContain("Feed Trajectory Samples");
    expect(html).toContain("feed-export.jsonl");
    expect(html).toContain("target = \"_blank\"");
    expect(html).toContain("market odds moved");
    expect(html).toContain("opened long position");
    expect(html).toContain("app_core_test_trajectory");
    expect(html).toContain("message-route");
    expect(html).toContain("send David the update");
    expect(html).toContain("Message queued for David.");
    expect(html).toContain("SEND_MESSAGE");
    expect(html).toContain("Eval Prompt Samples");
    expect(html).toContain("choose a tool for sending an update");
    expect(html).toContain("REPLY");
    expect(html).toContain("runtime_trajectory_boundary");
    expect(html).toContain("hf-traj-1");
    expect(html).toContain("huggingface_dataset");
    expect(html).toContain("sft/0_8b/train.jsonl");
    expect(html).toContain("hf-sft/0_8b/train.jsonl");
    expect(html).toContain("hf-sft-traj-1");
    expect(html).toContain("hello from hf sft");
    expect(html).toContain("eliza-1-0b-trained");
    expect(html).toContain("eliza-1-0b-base");
    expect(html).toContain("eliza-1-2b-trained");
    expect(html).toContain("variant");
    expect(html).toContain("baseLatencyMs");
    expect(html).toContain("trainedLatencyMs");
    expect(html).toContain("local_model_comparison.json");
    expect(html).toContain("improvementPercent");
    expect(html).toContain("app_core_action_selection_benchmark");
    expect(html).toContain("eliza_harness_action_reason");
    expect(html).not.toContain("<script>alert");

    const manifestOnDisk = JSON.parse(
      await readFile(index.manifestPath, "utf8"),
    ) as typeof index.manifest;
    expect(manifestOnDisk.counts.artifacts).toBe(20);
    const bundleArtifact = manifestOnDisk.artifacts.find(
      (artifact) => artifact.kind === "trajectory_bundle",
    );
    expect(bundleArtifact?.summary).toMatchObject({
      rawJsonlPath: join(root, "bundles", "run-1", "raw", "trajectories.jsonl"),
      sanitizedJsonlPath: join(
        root,
        "bundles",
        "run-1",
        "sanitized",
        "trajectories.sanitized.jsonl",
      ),
      taskDatasetSummaryPath: join(
        root,
        "bundles",
        "run-1",
        "tasks",
        "summary.json",
      ),
      taskFiles: expect.arrayContaining([
        expect.objectContaining({
          task: "action_planner",
          path: join(root, "bundles", "run-1", "tasks", "action_planner.jsonl"),
          exampleCount: 1,
        }),
      ]),
      samplePreviews: expect.arrayContaining([
        expect.objectContaining({
          trajectoryId: "run-1-traj-1",
          agentId: "agent-1",
          purpose: "response",
          callId: "call-response-1",
          model: "eliza-1-0.8b-test",
          systemPrompt: "Reply as Eliza.",
          input: "user asks for help",
          output: "agent gives a useful answer",
          steps: 1,
          llmCalls: 2,
        }),
        expect.objectContaining({
          trajectoryId: "run-1-canonical",
          agentId: "eliza",
          purpose: "action",
          model: "gpt-oss-120b",
          input: 'channel_type: dm\nincoming_message: "good morning"',
          output: "Action completed.",
          steps: 0,
          llmCalls: 0,
        }),
      ]),
      llmCallPreviews: [
        expect.objectContaining({
          trajectoryId: "run-1-traj-1",
          callId: "call-response-1",
          purpose: "response",
          model: "eliza-1-0.8b-test",
          systemPrompt: "Reply as Eliza.",
          input: "user asks for help",
          output: "agent gives a useful answer",
        }),
        expect.objectContaining({
          trajectoryId: "run-1-traj-1",
          callId: "call-action-1",
          purpose: "action_planner",
          model: "eliza-1-0.8b-test",
          systemPrompt: "Pick one action.",
          input: "choose the next action",
          output: "SEND_MESSAGE",
        }),
      ],
    });
    expect(bundleArtifact?.summary.sourceLinks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "raw-jsonl",
          path: join(root, "bundles", "run-1", "raw", "trajectories.jsonl"),
        }),
        expect.objectContaining({
          label: "sanitized-jsonl",
          path: join(
            root,
            "bundles",
            "run-1",
            "sanitized",
            "trajectories.sanitized.jsonl",
          ),
        }),
        expect.objectContaining({
          label: "task-action_planner",
          path: join(root, "bundles", "run-1", "tasks", "action_planner.jsonl"),
        }),
      ]),
    );
    expect(manifestOnDisk.coverage.readableSamples.natural).toBe(4);
    const scenarioArtifact = manifestOnDisk.artifacts.find(
      (artifact) => artifact.kind === "scenario_run",
    );
    expect(scenarioArtifact?.summary).toMatchObject({
      runId: "scenario-run-1",
      providerName: "deterministic-proxy",
      totalCount: 1,
      passedCount: 1,
      failedCount: 0,
      statuses: { passed: 1 },
      scenarioIds: ["lifeops.basic"],
      turnPreviews: [
        expect.objectContaining({
          scenarioId: "lifeops.basic",
          turn: "turn-1",
          kind: "user",
          input: "check in",
          output: "scheduled",
          actions: ["CREATE_SCHEDULED_TASK"],
        }),
      ],
    });
    expect(scenarioArtifact?.summary.sourceLinks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "artifact",
          path: join(root, "scenario-run", "matrix.json"),
        }),
        expect.objectContaining({
          label: "viewer",
          path: join(root, "scenario-run", "viewer", "index.html"),
        }),
      ]),
    );
    const scenarioNativeArtifact = manifestOnDisk.artifacts.find(
      (artifact) =>
        artifact.kind === "trajectory_dataset" &&
        artifact.summary.schema === "eliza_scenario_native_export",
    );
    expect(scenarioNativeArtifact?.summary).toMatchObject({
      jsonlPath: join(root, "scenario-native.jsonl"),
      scenarioIds: ["lifeops.basic"],
      scenarioNativeSamplePreviews: [
        expect.objectContaining({
          trajectoryId: "scenario-traj-1",
          agentId: "agent-1",
          scenarioId: "lifeops.basic",
          purpose: "planner",
          taskType: "action_planner",
          model: "deterministic-proxy",
          input: [{ role: "user", content: "check in" }],
          output: "scheduled",
          toolCalls: 1,
        }),
      ],
    });
    expect(scenarioNativeArtifact?.summary.sourceLinks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "jsonl",
          path: join(root, "scenario-native.jsonl"),
        }),
      ]),
    );
    const scenarioNativeJsonlArtifact = manifestOnDisk.artifacts.find(
      (artifact) =>
        artifact.kind === "trajectory_dataset" &&
        artifact.path.endsWith("scenario-native.jsonl"),
    );
    expect(scenarioNativeJsonlArtifact?.summary).toMatchObject({
      schema: "eliza_training_jsonl_dataset",
      rows: 1,
      samplePreviews: [
        expect.objectContaining({
          task: "action_planner",
          sourceDataset: "scenario_trajectory_boundary",
          trajectoryId: "scenario-traj-1",
          scenarioId: "lifeops.basic",
          input: "check in",
          output: "scheduled",
        }),
      ],
    });
    const jsonlArtifact = manifestOnDisk.artifacts.find(
      (artifact) =>
        artifact.kind === "trajectory_dataset" &&
        artifact.path.endsWith("eliza-1-trajectories.jsonl"),
    );
    expect(jsonlArtifact?.summary).toMatchObject({
      rows: 2,
      parseErrors: 0,
      sampleRows: 2,
      sourceDatasets: ["runtime_trajectory_boundary"],
      samplePreviews: [
        expect.objectContaining({
          task: "action_planner",
          trajectoryId: "hf-traj-1",
          sourceDataset: "runtime_trajectory_boundary",
          input: "user asked for a plan",
          output: "agent selected the planning action",
        }),
        expect.objectContaining({
          task: "response",
          trajectoryId: "hf-traj-2",
          sourceDataset: "runtime_trajectory_boundary",
          input: "status?",
          output: "agent replied with current status",
        }),
      ],
    });
    const huggingFaceArtifact = manifestOnDisk.artifacts.find(
      (artifact) =>
        artifact.kind === "trajectory_dataset" &&
        artifact.summary.schema === "eliza_huggingface_dataset_ingest",
    );
    expect(huggingFaceArtifact?.summary).toMatchObject({
      hfFiles: [
        expect.objectContaining({
          hfPath: "sft/0_8b/train.jsonl",
          localPath: join(root, "hf", "sft", "0_8b", "train.jsonl"),
          rows: 12,
          status: "downloaded",
        }),
      ],
      hfSamplePreviews: [
        expect.objectContaining({
          hfPath: "sft/0_8b/train.jsonl",
          localPath: join(root, "hf", "sft", "0_8b", "train.jsonl"),
          task: "response",
          trajectoryId: "hf-sft-traj-1",
          sourceDataset: "huggingface_sft",
          input: "hello from hf sft",
          output: "hello from eliza",
        }),
        expect.objectContaining({
          trajectoryId: "hf-sft-chat-traj-1",
          input: "summarize the feed run",
          output: "the feed run completed cleanly",
        }),
      ],
    });
    const feedArtifact = manifestOnDisk.artifacts.find(
      (artifact) =>
        artifact.kind === "trajectory_dataset" &&
        artifact.summary.schema === "feed_training_trajectory_export",
    );
    expect(feedArtifact?.summary).toMatchObject({
      schema: "feed_training_trajectory_export",
      source: { kind: "feed_train_archetype_export", archetype: "trader" },
      exportPath: join(root, "feed-export.jsonl"),
      trajectories: 4,
      scenarioIds: ["multi-archetype-trader"],
      agentIds: ["feed-agent-1"],
      feedSamplePreviews: [
        expect.objectContaining({
          trajectoryId: "feed-traj-1",
          agentId: "feed-agent-1",
          archetype: "trader",
          scenarioId: "multi-archetype-trader",
          score: 0.87,
          finalPnl: 42,
          steps: 1,
          firstStep: "BUY",
          firstInput: "market odds moved",
          firstOutput: "opened long position",
        }),
      ],
    });
    expect(feedArtifact?.summary.sourceLinks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "export",
          path: join(root, "feed-export.jsonl"),
        }),
        expect.objectContaining({
          label: "manifest",
          path: join(root, "feed-export.manifest.json"),
        }),
      ]),
    );
    const testTrajectoryArtifact = manifestOnDisk.artifacts.find(
      (artifact) =>
        artifact.kind === "trajectory_dataset" &&
        artifact.path.endsWith("message-route.json"),
    );
    expect(testTrajectoryArtifact?.summary).toMatchObject({
      schema: "eliza_test_trajectory_record",
      source: { kind: "app_core_test_trajectory" },
      caseId: "message-route",
      scenarioId: "action-selection.message",
      transcriptTurns: 2,
      llmCalls: 1,
      actions: 1,
      pass: true,
      expectedAction: "SEND_MESSAGE",
      actualAction: "SEND_MESSAGE",
      testSamplePreviews: [
        expect.objectContaining({
          caseId: "message-route",
          scenarioId: "action-selection.message",
          pass: true,
          expectedAction: "SEND_MESSAGE",
          actualAction: "SEND_MESSAGE",
          input: "send David the update",
          output: "I sent it.",
          llmPurpose: "action_planner",
          llmInput: "choose an action",
          llmOutput: "SEND_MESSAGE",
          action: "SEND_MESSAGE",
          actionStatus: "success",
        }),
      ],
    });
    const emptyReplyArtifact = manifestOnDisk.artifacts.find(
      (artifact) =>
        artifact.kind === "trajectory_dataset" &&
        artifact.path.endsWith("empty-reply.json"),
    );
    expect(emptyReplyArtifact?.summary).toMatchObject({
      schema: "eliza_test_trajectory_record",
      source: { kind: "app_core_test_trajectory" },
      caseId: "empty-reply",
      testSamplePreviews: [
        expect.objectContaining({
          input: "hey",
          output: "REPLY",
          action: "REPLY",
          llmOutput: "",
        }),
      ],
    });
    const evalComparisonArtifact = manifestOnDisk.artifacts.find(
      (artifact) =>
        artifact.kind === "eval" &&
        artifact.path.endsWith("eval-comparison.json"),
    );
    expect(evalComparisonArtifact?.summary).toMatchObject({
      schema: EVAL_COMPARISON_ARTIFACT_SCHEMA,
      baseModel: "eliza-1-0b-base",
      trainedModel: "eliza-1-0b-trained",
      backend: "cpu",
      baseScore: 0.5,
      trainedScore: 0.62,
      improvementAbsolute: 0.12,
      improvementPercent: 24,
      baseLatencyMs: 100,
      trainedLatencyMs: 110,
      latencyDeltaMs: 10,
      promptCount: 12,
      distinctResponseCount: 9,
      reportPath: join(root, "evals", "comparison", "local_model_comparison.json"),
      evalSamplePreviews: [
        expect.objectContaining({
          prompt: "choose a tool for sending an update",
          expected: "SEND_MESSAGE",
          baseOutput: "REPLY",
          trainedOutput: "SEND_MESSAGE",
          baseScore: 0,
          trainedScore: 1,
          improvement: 1,
        }),
      ],
    });
    const actionBenchmarkArtifact = manifestOnDisk.artifacts.find(
      (artifact) =>
        artifact.kind === "eval" &&
        artifact.path.endsWith("action-benchmark-report.json"),
    );
    expect(actionBenchmarkArtifact?.summary).toMatchObject({
      schema: "eliza_action_selection_benchmark_report",
      total: 1,
      passed: 1,
      failed: 0,
      accuracy: 1,
      plannerAccuracy: 1,
      executionAccuracy: 1,
      results: 1,
      failures: 0,
    });
    expect(actionBenchmarkArtifact?.summary.sourceLinks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "trajectory-dir",
          path: join(root, "action-benchmark-report"),
        }),
        expect.objectContaining({
          label: "benchmark-trajectory-message-route",
          path: join(
            root,
            "action-benchmark-report",
            "cases",
            "message-route.json",
          ),
        }),
      ]),
    );
    const trainedModelArtifact = manifestOnDisk.artifacts.find(
      (artifact) =>
        artifact.kind === "model" &&
        artifact.path.endsWith("training_manifest.json"),
    );
    expect(trainedModelArtifact?.summary).toMatchObject({
      model: "eliza-1-0b-trained",
      baseModel: "eliza-1-0b-base",
      outputPath: join(root, "checkpoints", "run-1", "final"),
      baseEvalScore: 0.5,
      trainedEvalScore: 0.62,
      evalImprovementPercent: 24,
    });
    expect(manifestOnDisk.coverage.models.inventory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          model: "eliza-1-0b-trained",
          baseModel: "eliza-1-0b-base",
          outputPath: join(root, "checkpoints", "run-1", "final"),
          baseEvalScore: 0.5,
          trainedEvalScore: 0.62,
          evalImprovementPercent: 24,
        }),
      ]),
    );
    const registryModelArtifact = manifestOnDisk.artifacts.find(
      (artifact) =>
        artifact.kind === "model" &&
        artifact.path.endsWith("2b-model-manifest.json"),
    );
    expect(registryModelArtifact?.summary).toMatchObject({
      schema: "eliza1_model_registry_entry",
      model: "eliza-1-2b-trained",
      variant: "trained",
      tier: "2b",
      outputPath: "hf://elizaos/eliza-1-2b-trained",
      baseModel: "eliza-1-2b-base",
      repoId: "elizaos/eliza-1-2b-trained",
    });
    const bundleStageArtifact = manifestOnDisk.artifacts.find(
      (artifact) =>
        artifact.kind === "model" &&
        artifact.path.endsWith("eliza1-bundle-stage-manifest.json"),
    );
    expect(bundleStageArtifact?.summary).toMatchObject({
      schema: ELIZA1_BUNDLE_STAGE_SCHEMA,
      tier: "0_8b",
      repoId: "elizaos/eliza-1",
      fileCount: 87,
      plannedBytes: 5_939_381_241,
      bundleDir: "/tmp/eliza-1-bundles/eliza-1-0_8b.bundle",
    });
  });

  it("renders collection action benchmark pairs and benchmark rows", async () => {
    const root = await makeTempDir();
    const outputDir = join(root, "analysis");
    const collectionDir = join(root, "collections", "run-1");
    await writeJson(join(collectionDir, "collection-manifest.json"), {
      schema: "eliza_training_collection_run",
      schemaVersion: 1,
      generatedAt: "2026-01-02T03:04:05.000Z",
      outputDir: collectionDir,
      manifestPath: join(collectionDir, "collection-manifest.json"),
      readmePath: join(collectionDir, "README.md"),
      provenance: {
        generatedBy: "plugin-training",
        workspaceRoot: root,
        trainingStateRoot: join(root, "training-state"),
        analysisRoots: [collectionDir],
        outputLayout: {
          collection: collectionDir,
          analysis: join(collectionDir, "analysis"),
          steps: collectionDir,
        },
      },
      recipe: {
        include: {
          huggingFace: false,
          feed: false,
          naturalTrajectories: false,
          testTrajectories: false,
          scenarios: false,
          evalComparison: false,
          actionBenchmark: true,
          benchmarkVsCerebras: false,
          eliza1BundleStage: false,
          benchmarkMatrix: true,
        },
        sources: {
          huggingFace: {},
          feed: {},
          naturalTrajectories: {},
          testTrajectories: {},
          scenarios: {},
        },
        evals: {
          evalComparison: {},
          actionBenchmark: {
            benchmark: "eliza_harness_action_selection",
            token: "should-not-be-generated-by-runner",
          },
          actionBenchmarkPair: null,
          actionBenchmarkPairs: [{ tier: "0_8b" }, { tier: "2b" }],
          benchmarkVsCerebras: {},
          benchmarkMatrix: {},
        },
        training: {
          eliza1BundleStage: {},
        },
      },
      analysis: {
        outputDir: join(collectionDir, "analysis"),
        indexHtmlPath: join(collectionDir, "analysis", "index.html"),
        manifestPath: join(collectionDir, "analysis", "analysis-manifest.json"),
        artifactCount: 4,
      },
      readiness: {
        outputDir: join(collectionDir, "analysis"),
        reportPath: join(
          collectionDir,
          "analysis",
          "training-readiness-report.json",
        ),
        status: "partial",
        ready: 1,
        partial: 1,
        missing: 1,
      },
      evidence: {
        stepArtifacts: [
          {
            stepId: "action_benchmark",
            status: "succeeded",
            outputDir: join(collectionDir, "action_benchmark"),
            command: [
              "bun",
              "run",
              "test",
              "test/benchmarks/action-selection.real.test.ts",
            ],
            exitCode: 0,
            stdout: "benchmark ok",
            stderr: null,
            paths: [
              {
                label: "pairs[0].runs.trained.reportJsonPath",
                path: join(
                  collectionDir,
                  "action_benchmark",
                  "0_8b",
                  "trained",
                  "action-benchmark-report.json",
                ),
              },
              {
                label: "pairs[0].runs.trained.trajectoryDir",
                path: join(
                  collectionDir,
                  "action_benchmark",
                  "0_8b",
                  "trained",
                  "trajectories",
                ),
              },
            ],
          },
          {
            stepId: "benchmark_matrix",
            status: "succeeded",
            outputDir: join(collectionDir, "benchmark_matrix"),
            command: null,
            exitCode: null,
            paths: [
              {
                label: "artifactPath",
                path: join(
                  collectionDir,
                  "benchmark_matrix",
                  "benchmark-matrix.json",
                ),
              },
            ],
          },
        ],
        feed: {
          runs: [
            {
              title: "feed_train_archetype_export",
              path: join(collectionDir, "feed", "feed-export.manifest.json"),
              schema: "feed_training_trajectory_export",
              sourceKind: "feed_train_archetype_export",
              archetype: "trader",
              archetypes: null,
              trajectories: 4,
              totalTicks: 12,
              durationMs: 900,
              errors: 0,
              exportPath: join(collectionDir, "feed", "feed-export.jsonl"),
              outputDir: join(collectionDir, "feed"),
            },
          ],
          archetypeStats: [
            {
              title: "feed_train_archetype_export",
              path: join(collectionDir, "feed", "feed-export.manifest.json"),
              archetype: "trader",
              agents: 1,
              trajectories: 4,
              avgTicksPerAgent: 12,
            },
          ],
          trajectorySamples: [
            {
              title: "feed_train_archetype_export",
              path: join(collectionDir, "feed", "feed-export.manifest.json"),
              trajectoryId: "feed-traj-1",
              agentId: "feed-agent-1",
              archetype: "trader",
              scenarioId: "multi-archetype-trader",
              score: 0.87,
              finalPnl: 42,
              steps: 1,
              firstStep: "BUY",
              firstInput: "market odds moved",
              firstOutput: "opened long position",
              reasoning: "profitable and coherent",
            },
          ],
        },
        sourceSamples: {
          huggingFace: [
            {
              title: "hf",
              path: join(collectionDir, "hf", "huggingface-dataset-manifest.json"),
              schema: "eliza_huggingface_dataset_ingest",
              sourceKind: "huggingface_dataset",
              trajectoryId: "hf-sft-traj-1",
              scenarioId: null,
              task: "response",
              input: "hello from collection hf",
              output: "hello from collection eliza",
              model: null,
            },
          ],
          feed: [
            {
              title: "feed_train_archetype_export",
              path: join(collectionDir, "feed", "feed-export.manifest.json"),
              schema: "feed_training_trajectory_export",
              sourceKind: "feed_train_archetype_export",
              trajectoryId: "feed-traj-1",
              scenarioId: "multi-archetype-trader",
              task: null,
              input: "market odds moved",
              output: "opened long position",
              model: null,
            },
          ],
          natural: [
            {
              title: "natural",
              path: join(collectionDir, "natural", "manifest.json"),
              schema: "eliza_trajectory_export_bundle",
              sourceKind: "training_collection_natural_trajectories",
              trajectoryId: "natural-traj-1",
              scenarioId: null,
              task: "response",
              input: "natural user input",
              output: "natural assistant output",
              model: null,
            },
          ],
          scenarios: [],
          tests: [],
          trainingJsonl: [],
        },
        training: {
          trainingRuns: 0,
          models: 2,
          modelInventory: [
            {
              title: "eliza-1-0_8b-trained",
              path: join(
                collectionDir,
                "eliza1_model_registry",
                "0_8b-model-manifest.json",
              ),
              schema: "eliza1_model_registry_entry",
              model: "eliza-1-0_8b-trained",
              tier: "0_8b",
              variant: "trained",
              outputPath: "hf://elizaos/eliza-1-0_8b-trained",
              baseModel: "eliza-1-0_8b-base",
              baseEvalScore: 0.4,
              trainedEvalScore: 0.6,
              repoId: "elizaos/eliza-1-0_8b-trained",
              evalImprovementPercent: null,
            },
            {
              title: "eliza-1-2b-trained",
              path: join(
                collectionDir,
                "eliza1_model_registry",
                "2b-model-manifest.json",
              ),
              schema: "eliza1_model_registry_entry",
              model: "eliza-1-2b-trained",
              tier: "2b",
              variant: "trained",
              outputPath: "hf://elizaos/eliza-1-2b-trained",
              baseModel: "eliza-1-2b-base",
              baseEvalScore: 0.4,
              trainedEvalScore: 0.6,
              repoId: "elizaos/eliza-1-2b-trained",
              evalImprovementPercent: 50,
            },
          ],
        },
        benchmarks: {
          actionBenchmarkPairs: 2,
          actionBenchmarkMatrixSources: 4,
          benchmarkRows: 4,
          benchmarkComparisons: 2,
          tiers: ["0_8b", "2b"],
          comparisonInventory: [
            {
              tier: "0_8b",
              benchmark: "eliza_harness_action_selection",
              baseModelId: "eliza-1-0_8b-base",
              trainedModelId: "eliza-1-0_8b-trained",
              referenceModelId: null,
              baseScore: 0.4,
              trainedScore: 0.6,
              referenceScore: null,
              improvementPercent: 50,
              trainedVsReferencePercent: null,
              dryRun: false,
            },
            {
              tier: "2b",
              benchmark: "eliza_harness_action_selection",
              baseModelId: "eliza-1-2b-base",
              trainedModelId: "eliza-1-2b-trained",
              referenceModelId: null,
              baseScore: 0.42,
              trainedScore: 0.63,
              referenceScore: null,
              improvementPercent: 50,
              trainedVsReferencePercent: null,
              dryRun: false,
            },
          ],
          improvementComparisons: [
            {
              tier: "0_8b",
              benchmark: "eliza_harness_action_selection",
              baseScore: 0.4,
              trainedScore: 0.6,
              referenceScore: null,
              improvementPercent: 50,
            },
            {
              tier: "2b",
              benchmark: "eliza_harness_action_selection",
              baseScore: 0.42,
              trainedScore: 0.63,
              referenceScore: null,
              improvementPercent: 50,
            },
          ],
        },
        artifactLinks: [
          {
            category: "benchmark",
            kind: "benchmark_matrix",
            schema: "eliza_benchmark_matrix_artifact",
            title: "Eliza-1 benchmark matrix",
            path: join(
              collectionDir,
              "benchmark_matrix",
              "benchmark-matrix.json",
            ),
          },
          {
            category: "eval",
            kind: "eval",
            schema: "eliza_action_selection_benchmark_report",
            title: "0_8b trained action benchmark",
            path: join(
              collectionDir,
              "action_benchmark",
              "0_8b",
              "trained",
              "action-benchmark-report.json",
            ),
          },
        ],
        readinessGaps: [
          {
            id: "all_eliza1_tiers_benchmark",
            label: "All Eliza-1 tier benchmark coverage",
            status: "partial",
            note: "Benchmark coverage is missing some Eliza-1 tiers.",
            recommendedCapability: "terminal-training-run-collection",
            recommendedParams: { actionBenchmarkPairs: "all" },
          },
        ],
      },
      steps: [
        {
          id: "action_benchmark",
          status: "succeeded",
          outputDir: join(collectionDir, "action_benchmark"),
          error: null,
          result: {
            outputDir: join(collectionDir, "action_benchmark"),
            pairs: [
              {
                label: "0_8b",
                tier: "0_8b",
                runs: {
                  base: {
                    outputDir: join(
                      collectionDir,
                      "action_benchmark",
                      "0_8b",
                      "base",
                    ),
                    reportJsonPath: join(
                      collectionDir,
                      "action_benchmark",
                      "0_8b",
                      "base",
                      "action-benchmark-report.json",
                    ),
                    matrixSource: {
                      path: join(
                        collectionDir,
                        "action_benchmark",
                        "0_8b",
                        "base",
                        "action-benchmark-report.json",
                      ),
                      modelId: "eliza-1-0_8b-base",
                      variant: "base",
                      tier: "0_8b",
                    },
                  },
                  trained: {
                    outputDir: join(
                      collectionDir,
                      "action_benchmark",
                      "0_8b",
                      "trained",
                    ),
                    reportJsonPath: join(
                      collectionDir,
                      "action_benchmark",
                      "0_8b",
                      "trained",
                      "action-benchmark-report.json",
                    ),
                    matrixSource: {
                      path: join(
                        collectionDir,
                        "action_benchmark",
                        "0_8b",
                        "trained",
                        "action-benchmark-report.json",
                      ),
                      modelId: "eliza-1-0_8b-trained",
                      variant: "trained",
                      tier: "0_8b",
                    },
                  },
                },
                matrixSources: [],
              },
              {
                label: "2b",
                tier: "2b",
                runs: {
                  base: {
                    outputDir: join(
                      collectionDir,
                      "action_benchmark",
                      "2b",
                      "base",
                    ),
                    reportJsonPath: join(
                      collectionDir,
                      "action_benchmark",
                      "2b",
                      "base",
                      "action-benchmark-report.json",
                    ),
                    matrixSource: {
                      path: join(
                        collectionDir,
                        "action_benchmark",
                        "2b",
                        "base",
                        "action-benchmark-report.json",
                      ),
                      modelId: "eliza-1-2b-base",
                      variant: "base",
                      tier: "2b",
                    },
                  },
                  trained: {
                    outputDir: join(
                      collectionDir,
                      "action_benchmark",
                      "2b",
                      "trained",
                    ),
                    reportJsonPath: join(
                      collectionDir,
                      "action_benchmark",
                      "2b",
                      "trained",
                      "action-benchmark-report.json",
                    ),
                    matrixSource: {
                      path: join(
                        collectionDir,
                        "action_benchmark",
                        "2b",
                        "trained",
                        "action-benchmark-report.json",
                      ),
                      modelId: "eliza-1-2b-trained",
                      variant: "trained",
                      tier: "2b",
                    },
                  },
                },
                matrixSources: [],
              },
            ],
            matrixSources: [
              { path: "base-0_8b.json", modelId: "eliza-1-0_8b-base" },
              {
                path: "trained-0_8b.json",
                modelId: "eliza-1-0_8b-trained",
              },
              { path: "base-2b.json", modelId: "eliza-1-2b-base" },
              { path: "trained-2b.json", modelId: "eliza-1-2b-trained" },
            ],
          },
        },
      ],
    });
    await writeJson(
      join(collectionDir, "benchmark_matrix", "benchmark-matrix.json"),
      {
        schema: BENCHMARK_MATRIX_ARTIFACT_SCHEMA,
        version: BENCHMARK_MATRIX_ARTIFACT_VERSION,
        generatedAt: "2026-01-02T03:25:00.000Z",
        source: { kind: "training_collection_benchmark_matrix" },
        referenceModelId: "cerebras/gpt-oss-120b",
        tiers: ["0_8b", "2b"],
        benchmarks: ["eliza_harness_action_selection"],
        counts: {
          rows: 4,
          comparisons: 2,
          tiers: 2,
          benchmarks: 1,
        },
        rows: [
          {
            modelId: "eliza-1-0_8b-base",
            benchmark: "eliza_harness_action_selection",
            score: 0.4,
            variant: "base",
            tier: "0_8b",
            provider: "local-llama-cpp",
            datasetVersion: "eliza-native-v1",
          },
          {
            modelId: "eliza-1-0_8b-trained",
            benchmark: "eliza_harness_action_selection",
            score: 0.6,
            variant: "trained",
            tier: "0_8b",
            provider: "local-llama-cpp",
            datasetVersion: "eliza-native-v1",
          },
          {
            modelId: "eliza-1-2b-base",
            benchmark: "eliza_harness_action_selection",
            score: 0.42,
            variant: "base",
            tier: "2b",
            provider: "local-llama-cpp",
            datasetVersion: "eliza-native-v1",
          },
          {
            modelId: "eliza-1-2b-trained",
            benchmark: "eliza_harness_action_selection",
            score: 0.63,
            variant: "trained",
            tier: "2b",
            provider: "local-llama-cpp",
            datasetVersion: "eliza-native-v1",
          },
        ],
        comparisons: [
          {
            tier: "0_8b",
            benchmark: "eliza_harness_action_selection",
            baseScore: 0.4,
            trainedScore: 0.6,
            referenceScore: null,
            improvementPercent: 50,
          },
          {
            tier: "2b",
            benchmark: "eliza_harness_action_selection",
            baseScore: 0.42,
            trainedScore: 0.63,
            referenceScore: null,
            improvementPercent: 50,
          },
        ],
      },
    );

    const index = await buildTrainingAnalysisIndex({
      roots: [root],
      outputDir,
      now: () => new Date("2026-01-02T04:00:00.000Z"),
    });

    expect(index.manifest.counts.collectionRuns).toBe(1);
    expect(index.manifest.counts.benchmarkMatrices).toBe(1);
    const html = await readFile(index.indexHtmlPath, "utf8");
    expect(html).toContain("Collection Action Benchmark Pairs");
    expect(html).toContain("Collection Recipe");
    expect(html).toContain("Collection Evidence Artifacts");
    expect(html).toContain("Collection Step Artifacts");
    expect(html).toContain("appendPathCell(row, item.reportJsonPath)");
    expect(html).toContain("appendPathCell(row, item.reportPath || item.path)");
    expect(html).toContain("Stdout");
    expect(html).toContain("benchmark ok");
    expect(html).toContain("Collection Model Inventory");
    expect(html).toContain("Collection Source Samples");
    expect(html).toContain("Collection Feed Runs");
    expect(html).toContain("Collection Feed Archetype Stats");
    expect(html).toContain("Collection Feed Trajectory Samples");
    expect(html).toContain("Collection Benchmark Comparisons");
    expect(html).toContain("Collection Benchmark Improvements");
    expect(html).toContain("Collection Baseline Progression");
    expect(html).toContain("Collection Readiness Gaps");
    expect(html).toContain("Recommended Params");
    expect(html).toContain("all_eliza1_tiers_benchmark");
    expect(html).toContain("terminal-training-run-collection");
    expect(html).toContain('"actionBenchmarkPairs":"all"');
    expect(html).toContain("selectedSourceCategory");
    expect(html).toContain("run-filter");
    expect(html).toContain("tier-filter");
    expect(html).toContain("artifactRunIds(artifact)");
    expect(html).toContain("artifactTiers(artifact)");
    expect(html).toContain('selectedRunId !== "all"');
    expect(html).toContain('selectedTier !== "all"');
    expect(html).toContain("sourceCategories(artifact)");
    expect(html).toContain('"trainingJsonl", "Training JSONL"');
    expect(html).toContain("sample.title || artifact.title");
    expect(html).toContain(
      "!sourceCategories(artifact).includes(selectedSourceCategory)",
    );
    expect(html).toContain("All sources");
    expect(html).toContain("dataset.sourceCategory");
    expect(html).toContain("hello from collection hf");
    expect(html).toContain('"feed"');
    expect(html).toContain('"input":"market odds moved"');
    expect(html).toContain('"output":"opened long position"');
    expect(html).toContain("natural assistant output");
    expect(html).toContain("Benchmark Rows");
    expect(html).toContain("Benchmark Model Stats");
    expect(html).toContain("eliza-1-0_8b-base");
    expect(html).toContain("eliza-1-0_8b-trained");
    expect(html).toContain("eliza-1-2b-base");
    expect(html).toContain("eliza-1-2b-trained");
    expect(html).toContain("hf://elizaos/eliza-1-0_8b-trained");
    expect(html).toContain("hf://elizaos/eliza-1-2b-trained");
    expect(html).toContain("feed-traj-1");
    expect(html).toContain("feed_train_archetype_export");
    expect(html).toContain("eliza_harness_action_selection");
    expect(html).toContain("test/benchmarks/action-selection.real.test.ts");
    expect(html).toContain("pairs[0].runs.trained.reportJsonPath");
    expect(html).toContain("benchmark-matrix.json");
    expect(html).toContain('"improvementPercent":50');

    const manifestOnDisk = JSON.parse(
      await readFile(index.manifestPath, "utf8"),
    ) as typeof index.manifest;
    const collectionArtifact = manifestOnDisk.artifacts.find(
      (artifact) => artifact.kind === "collection_run",
    );
    expect(collectionArtifact?.summary).toMatchObject({
      readmePath: join(collectionDir, "README.md"),
      provenance: {
        generatedBy: "plugin-training",
        analysisRoots: [collectionDir],
      },
      actionBenchmarkPairs: 2,
      actionBenchmarkMatrixSources: 4,
      includedSteps: ["actionBenchmark", "benchmarkMatrix"],
      evalRecipeKeys: ["actionBenchmark", "actionBenchmarkPairs"],
    });
    expect(html).toContain("readme");
    expect(html).toContain("README.md");
    const benchmarkMatrixArtifact = manifestOnDisk.artifacts.find(
      (artifact) => artifact.kind === "benchmark_matrix",
    );
    expect(benchmarkMatrixArtifact?.summary).toMatchObject({
      models: 4,
      modelStats: expect.arrayContaining([
        expect.objectContaining({
          modelId: "eliza-1-0_8b-base",
          variant: "base",
          tier: "0_8b",
          benchmarkCount: 1,
          scoreCount: 1,
          averageScore: 0.4,
          bestScore: 0.4,
          worstScore: 0.4,
        }),
        expect.objectContaining({
          modelId: "eliza-1-2b-trained",
          variant: "trained",
          tier: "2b",
          benchmarkCount: 1,
          scoreCount: 1,
          averageScore: 0.63,
        }),
      ]),
    });
  });

  it("resolves relative feed export paths from the manifest directory", async () => {
    const root = await makeTempDir();
    const feedDir = join(root, "feed", "trader");
    const outputDir = join(root, "analysis");
    await writeJson(join(feedDir, "trajectories.manifest.json"), {
      schema: "feed_training_trajectory_export",
      schemaVersion: 1,
      generatedAt: "2026-01-02T03:15:00.000Z",
      exportPath: "trajectories.jsonl",
      outputDir: ".",
      manifestPath: "trajectories.manifest.json",
      source: {
        kind: "feed_train_archetype_export",
        archetype: "trader",
      },
      counts: { trajectories: 1 },
      scenarioIds: ["feed-scenario-1"],
      agentIds: ["feed-agent-1"],
    });
    await writeJsonl(join(feedDir, "trajectories.jsonl"), [
      {
        trajectory_id: "feed-relative-traj-1",
        agent_id: "feed-agent-1",
        archetype: "trader",
        scenario_id: "feed-scenario-1",
        score: 0.91,
        final_pnl: 12,
        steps: [
          {
            action: "BUY",
            input: "relative market input",
            output: "relative market decision",
          },
        ],
        reasoning: "relative feed export was loaded",
      },
    ]);

    const index = await buildTrainingAnalysisIndex({
      roots: [root],
      outputDir,
      now: () => new Date("2026-01-02T04:00:00.000Z"),
    });

    const feedArtifact = index.manifest.artifacts.find(
      (artifact) =>
        artifact.kind === "trajectory_dataset" &&
        artifact.summary.schema === "feed_training_trajectory_export",
    );
    expect(feedArtifact?.summary).toMatchObject({
      exportPath: join(feedDir, "trajectories.jsonl"),
      outputDir: feedDir,
      feedSamplePreviews: [
        expect.objectContaining({
          trajectoryId: "feed-relative-traj-1",
          agentId: "feed-agent-1",
          firstStep: "BUY",
          firstInput: "relative market input",
          firstOutput: "relative market decision",
          reasoning: "relative feed export was loaded",
        }),
      ],
    });
    const html = await readFile(index.indexHtmlPath, "utf8");
    expect(html).toContain("feed-relative-traj-1");
    expect(html).toContain("relative market input");
    expect(html).toContain("relative market decision");
    expect(html).toContain("relative feed export was loaded");
  });

  it("uses feed jsonlPath for readable previews when exportPath is absent", async () => {
    const root = await makeTempDir();
    const feedDir = join(root, "feed", "jsonl-only");
    const outputDir = join(root, "analysis");
    await writeJson(join(feedDir, "feed.manifest.json"), {
      schema: "feed_training_trajectory_export",
      schemaVersion: 1,
      generatedAt: "2026-01-02T03:20:00.000Z",
      jsonlPath: "feed-trajectories.jsonl",
      outputDir: ".",
      source: {
        kind: "feed_train_archetype_export",
        archetype: "trader",
      },
      counts: { trajectories: 1 },
    });
    await writeJsonl(join(feedDir, "feed-trajectories.jsonl"), [
      {
        trajectory_id: "feed-jsonl-traj-1",
        agent_id: "feed-agent-jsonl",
        archetype: "trader",
        steps: [
          {
            event: "market_tick",
            observation: "jsonl-only feed input",
            decision: "jsonl-only feed output",
          },
        ],
      },
    ]);

    const index = await buildTrainingAnalysisIndex({
      roots: [root],
      outputDir,
      now: () => new Date("2026-01-02T04:00:00.000Z"),
    });

    const feedArtifact = index.manifest.artifacts.find(
      (artifact) =>
        artifact.kind === "trajectory_dataset" &&
        artifact.summary.schema === "feed_training_trajectory_export",
    );
    expect(feedArtifact?.summary).toMatchObject({
      jsonlPath: join(feedDir, "feed-trajectories.jsonl"),
      feedSamplePreviews: [
        expect.objectContaining({
          trajectoryId: "feed-jsonl-traj-1",
          firstInput: "jsonl-only feed input",
          firstOutput: "jsonl-only feed output",
        }),
      ],
    });
    expect(index.manifest.coverage.readableSamples.feed).toBe(1);
    const html = await readFile(index.indexHtmlPath, "utf8");
    expect(html).toContain("feed-jsonl-traj-1");
    expect(html).toContain("jsonl-only feed input");
    expect(html).toContain("jsonl-only feed output");
  });

  it("uses feed export paths as written when manifests store cwd-relative paths", async () => {
    const root = await makeTempDir();
    const feedDir = join(root, "feed", "cwd-relative");
    const outputDir = join(root, "analysis");
    const cwdRelativeExport = relative(
      process.cwd(),
      join(feedDir, "feed-trajectories.jsonl"),
    );
    await writeJson(join(feedDir, "feed.manifest.json"), {
      schema: "feed_parallel_generation",
      schemaVersion: 1,
      generatedAt: "2026-01-02T03:25:00.000Z",
      exportPath: cwdRelativeExport,
      outputDir: ".",
      source: {
        kind: "feed_train_parallel_generation",
        archetypes: ["trader"],
      },
      counts: { trajectories: 1 },
    });
    await writeJsonl(join(feedDir, "feed-trajectories.jsonl"), [
      {
        trajectory_id: "feed-cwd-relative-traj-1",
        agent_id: "feed-agent-cwd",
        archetype: "trader",
        steps: [
          {
            action: "DRY_RUN",
            input: "cwd relative feed input",
            output: "cwd relative feed output",
          },
        ],
      },
    ]);

    const index = await buildTrainingAnalysisIndex({
      roots: [root],
      outputDir,
      now: () => new Date("2026-01-02T04:00:00.000Z"),
    });

    const feedArtifact = index.manifest.artifacts.find(
      (artifact) =>
        artifact.kind === "trajectory_dataset" &&
        artifact.summary.schema === "feed_parallel_generation",
    );
    expect(feedArtifact?.summary).toMatchObject({
      exportPath: join(feedDir, "feed-trajectories.jsonl"),
      feedSamplePreviews: [
        expect.objectContaining({
          trajectoryId: "feed-cwd-relative-traj-1",
          firstInput: "cwd relative feed input",
          firstOutput: "cwd relative feed output",
        }),
      ],
    });
    expect(index.manifest.coverage.readableSamples.feed).toBe(1);
    const html = await readFile(index.indexHtmlPath, "utf8");
    expect(html).toContain("feed-cwd-relative-traj-1");
    expect(html).toContain("cwd relative feed input");
    expect(html).toContain("cwd relative feed output");
  });

  it("uses Hugging Face local paths as written when manifests store cwd-relative paths", async () => {
    const root = await makeTempDir();
    const hfDir = join(root, "hf", "cwd-relative");
    const outputDir = join(root, "analysis");
    const cwdRelativeLocalPath = relative(
      process.cwd(),
      join(hfDir, "sft", "0_8b", "train.jsonl"),
    );
    await writeJsonl(join(hfDir, "sft", "0_8b", "train.jsonl"), [
      {
        schema: "eliza.eliza1_sft_record.v1",
        source_dataset: "huggingface_sft",
        trajectoryId: "hf-cwd-relative-traj-1",
        task: "response",
        input: "cwd relative hf input",
        output: "cwd relative hf output",
      },
    ]);
    await writeJson(join(hfDir, "huggingface-dataset-manifest.json"), {
      schema: "eliza_huggingface_dataset_ingest",
      schemaVersion: 1,
      generatedAt: "2026-01-02T03:35:00.000Z",
      source: {
        kind: "huggingface_dataset",
        repoId: "elizaos/eliza-1-training",
        revision: "main",
      },
      outputDir: ".",
      counts: {
        files: 1,
        downloadedFiles: 1,
        dryRunFiles: 0,
        jsonlRows: 1,
        bytes: 128,
      },
      files: [
        {
          hfPath: "sft/0_8b/train.jsonl",
          localPath: cwdRelativeLocalPath,
          rows: 1,
          bytes: 128,
          status: "downloaded",
        },
      ],
    });

    const index = await buildTrainingAnalysisIndex({
      roots: [root],
      outputDir,
      now: () => new Date("2026-01-02T04:00:00.000Z"),
    });

    const huggingFaceArtifact = index.manifest.artifacts.find(
      (artifact) =>
        artifact.kind === "trajectory_dataset" &&
        artifact.summary.schema === "eliza_huggingface_dataset_ingest",
    );
    expect(huggingFaceArtifact?.summary).toMatchObject({
      hfFiles: [
        expect.objectContaining({
          hfPath: "sft/0_8b/train.jsonl",
          localPath: join(hfDir, "sft", "0_8b", "train.jsonl"),
          rows: 1,
          status: "downloaded",
        }),
      ],
      hfSamplePreviews: [
        expect.objectContaining({
          hfPath: "sft/0_8b/train.jsonl",
          localPath: join(hfDir, "sft", "0_8b", "train.jsonl"),
          trajectoryId: "hf-cwd-relative-traj-1",
          input: "cwd relative hf input",
          output: "cwd relative hf output",
        }),
      ],
    });
    expect(index.manifest.coverage.readableSamples.huggingFace).toBe(1);
    const html = await readFile(index.indexHtmlPath, "utf8");
    expect(html).toContain("hf-cwd-relative-traj-1");
    expect(html).toContain("cwd relative hf input");
    expect(html).toContain("cwd relative hf output");
  });

  it("uses natural trajectory bundle paths as written when manifests store cwd-relative paths", async () => {
    const root = await makeTempDir();
    const bundleDir = join(root, "natural", "cwd-relative");
    const outputDir = join(root, "analysis");
    const cwdRelativeSanitizedPath = relative(
      process.cwd(),
      join(bundleDir, "sanitized", "trajectories.sanitized.jsonl"),
    );
    const cwdRelativeTaskPath = relative(
      process.cwd(),
      join(bundleDir, "tasks", "response.jsonl"),
    );
    await writeJsonl(join(bundleDir, "sanitized", "trajectories.sanitized.jsonl"), [
      {
        trajectoryId: "natural-cwd-relative-traj-1",
        agentId: "agent-natural",
        steps: [
          {
            stepId: "step-1",
            llmCalls: [
              {
                callId: "call-1",
                purpose: "response",
                model: "eliza-1-0_8b-trained",
                userPrompt: "cwd relative natural input",
                response: "cwd relative natural output",
              },
            ],
          },
        ],
      },
    ]);
    await writeJsonl(join(bundleDir, "tasks", "response.jsonl"), [
      {
        task: "response",
        example: { trajectoryId: "natural-cwd-relative-traj-1" },
      },
    ]);
    await writeJson(join(bundleDir, "manifest.json"), {
      schema: TRAJECTORY_EXPORT_BUNDLE_SCHEMA,
      schemaVersion: TRAJECTORY_EXPORT_BUNDLE_VERSION,
      generatedAt: "2026-01-02T03:40:00.000Z",
      runId: "natural-run-1",
      source: {
        kind: "training_collection_natural_trajectories",
        runId: "natural-run-1",
        runIds: ["natural-run-1"],
        inputTrajectoryCount: 1,
        sanitizedTrajectoryCount: 1,
        droppedTrajectoryCount: 0,
      },
      paths: {
        bundleDir,
        manifestPath: join(bundleDir, "manifest.json"),
        sanitizedJsonlPath: cwdRelativeSanitizedPath,
        taskDatasetDir: "tasks",
      },
      counts: {
        rawTrajectoryRows: 0,
        sanitizedTrajectoryRows: 1,
        taskRows: {
          should_respond: 0,
          context_routing: 0,
          action_planner: 0,
          response: 1,
          media_description: 0,
        },
        taskFiles: 1,
        taskExamples: 1,
        llmCalls: 1,
        skippedNonNativeRows: 0,
      },
      tasks: {
        response: {
          path: cwdRelativeTaskPath,
          exampleCount: 1,
          sourceCallCount: 1,
          sourceTrajectoryCount: 1,
        },
      },
      privacy: {
        applied: true,
        redactionCount: 0,
        anonymizationCount: 0,
        droppedCount: 0,
        dropped: [],
      },
      cloudUpload: { uploadedToHuggingFace: false },
    });

    const index = await buildTrainingAnalysisIndex({
      roots: [root],
      outputDir,
      now: () => new Date("2026-01-02T04:00:00.000Z"),
    });

    const bundleArtifact = index.manifest.artifacts.find(
      (artifact) => artifact.kind === "trajectory_bundle",
    );
    expect(bundleArtifact?.summary).toMatchObject({
      sanitizedJsonlPath: join(
        bundleDir,
        "sanitized",
        "trajectories.sanitized.jsonl",
      ),
      taskFiles: [
        expect.objectContaining({
          task: "response",
          path: join(bundleDir, "tasks", "response.jsonl"),
        }),
      ],
      llmCallPreviews: [
        expect.objectContaining({
          trajectoryId: "natural-cwd-relative-traj-1",
          input: "cwd relative natural input",
          output: "cwd relative natural output",
        }),
      ],
    });
    expect(index.manifest.coverage.readableSamples.natural).toBe(2);
    const html = await readFile(index.indexHtmlPath, "utf8");
    expect(html).toContain("natural-cwd-relative-traj-1");
    expect(html).toContain("cwd relative natural input");
    expect(html).toContain("cwd relative natural output");
  });

  it("resolves scenario run native paths and links when stored cwd-relative", async () => {
    const root = await makeTempDir();
    const runDir = join(root, "scenario-run-cwd");
    const outputDir = join(root, "analysis");
    const cwdRelativeNativeJsonlPath = relative(
      process.cwd(),
      join(runDir, "native", "scenario-native.jsonl"),
    );
    const cwdRelativeNativeManifestPath = relative(
      process.cwd(),
      join(runDir, "native", "scenario-native.manifest.json"),
    );
    await writeJsonl(join(runDir, "native", "scenario-native.jsonl"), [
      {
        trajectoryId: "scenario-cwd-traj-1",
        request: { prompt: "scenario cwd input" },
        response: { text: "scenario cwd output" },
      },
    ]);
    await writeJson(join(runDir, "native", "scenario-native.manifest.json"), {
      schema: "eliza_scenario_native_export",
      counts: { rows: 1 },
    });
    await writeJson(join(runDir, "matrix.json"), {
      schema: "eliza_scenario_run_viewer_v1",
      runId: "scenario-cwd-run-1",
      runDir: relative(process.cwd(), runDir),
      nativeJsonlPath: cwdRelativeNativeJsonlPath,
      nativeManifestPath: cwdRelativeNativeManifestPath,
      completedAtIso: "2026-01-02T03:45:00.000Z",
      providerName: "deterministic-proxy",
      scenarios: [
        {
          id: "scenario.cwd",
          title: "Scenario cwd",
          status: "passed",
          durationMs: 12,
          turns: [
            {
              name: "turn-1",
              kind: "user",
              text: "scenario cwd input",
              responseText: "scenario cwd output",
              actionsCalled: [],
              failedAssertions: [],
            },
          ],
        },
      ],
      totalCount: 1,
      passedCount: 1,
      failedCount: 0,
      skippedCount: 0,
    });

    const index = await buildTrainingAnalysisIndex({
      roots: [root],
      outputDir,
      now: () => new Date("2026-01-02T04:00:00.000Z"),
    });

    const scenarioArtifact = index.manifest.artifacts.find(
      (artifact) => artifact.kind === "scenario_run",
    );
    expect(scenarioArtifact?.summary).toMatchObject({
      runDir,
      viewerHtmlPath: join(runDir, "viewer", "index.html"),
      nativeJsonlPath: join(runDir, "native", "scenario-native.jsonl"),
      nativeManifestPath: join(runDir, "native", "scenario-native.manifest.json"),
      turnPreviews: [
        expect.objectContaining({
          scenarioId: "scenario.cwd",
          input: "scenario cwd input",
          output: "scenario cwd output",
        }),
      ],
    });
    expect(scenarioArtifact?.summary.sourceLinks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "native-jsonl",
          path: join(runDir, "native", "scenario-native.jsonl"),
        }),
        expect.objectContaining({
          label: "native-manifest",
          path: join(runDir, "native", "scenario-native.manifest.json"),
        }),
      ]),
    );
    const html = await readFile(index.indexHtmlPath, "utf8");
    expect(html).toContain("scenario cwd input");
    expect(html).toContain("scenario cwd output");
    expect(html).toContain("native-jsonl");
    expect(html).toContain("native-manifest");
  });
});
