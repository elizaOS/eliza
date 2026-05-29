import { createServer } from "node:http";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Trajectory } from "@elizaos/agent";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildTrainingCollectionPreflight,
  buildTrainingCollectionPreflightWithProbes,
  listTrainingCollections,
  runTrainingCollection,
  TRAINING_COLLECTION_RUN_SCHEMA,
  writeTrainingCollectionIndex,
} from "./training-collection-runner.js";

const outputDirs: string[] = [];

function stubLocalBenchmarkModels(modelIds: string[]): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ data: modelIds.map((id) => ({ id })) }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function naturalTrajectory(): Trajectory {
  return {
    trajectoryId: "natural-traj-1",
    agentId: "agent-1",
    startTime: 1_700_000_000_000,
    endTime: 1_700_000_001_000,
    durationMs: 1_000,
    steps: [
      {
        stepId: "step-1",
        timestamp: 1_700_000_000_100,
        llmCalls: [
          {
            callId: "call-1",
            purpose: "response",
            model: "eliza-1-0.8b-natural",
            systemPrompt: "Reply as Eliza.",
            userPrompt: "What should I do next?",
            response: "Review the latest task and pick the smallest action.",
          },
          {
            callId: "call-2",
            purpose: "action_planner",
            model: "eliza-1-0.8b-natural",
            systemPrompt: "Choose one action.",
            userPrompt: "Which tool should run?",
            response: "RUN_COLLECTION_PREFLIGHT",
          },
        ],
      },
    ],
    metrics: { finalStatus: "completed" },
    metadata: { source: "natural-test" },
  };
}

function appCoreTestTrajectory() {
  return {
    caseId: "app-core-test-case",
    scenarioId: "app-core-test-scenario",
    startedAt: 1_700_000_002_000,
    endedAt: 1_700_000_003_000,
    durationMs: 1_000,
    roomId: "00000000-0000-0000-0000-000000000001",
    userId: "00000000-0000-0000-0000-000000000002",
    transcript: [
      { role: "user", text: "Open settings", timestamp: 1_700_000_002_100 },
      {
        role: "assistant",
        text: "Opening settings.",
        timestamp: 1_700_000_002_500,
      },
    ],
    agentTrajectory: {
      llmCalls: [
        {
          callId: "llm-1",
          timestamp: 1_700_000_002_200,
          latencyMs: 25,
          modelType: "text-large",
          prompt: "Pick an action.",
          response: "OPEN_SETTINGS",
          purpose: "action_planner",
        },
      ],
      providerSnapshots: [],
    },
    actions: [
      {
        phase: "completed",
        actionName: "OPEN_SETTINGS",
        timestamp: 1_700_000_002_600,
      },
    ],
    events: [{ type: "RUN_ENDED", timestamp: 1_700_000_003_000, data: {} }],
    memoriesWritten: [],
    metadata: { pass: true },
  };
}

async function writeFakeActionBenchmarkBun(path: string): Promise<void> {
  await writeFile(
    path,
    [
      "#!/bin/sh",
      "node <<'NODE'",
      "const fs = require('node:fs');",
      "const model = process.env.ELIZA_LIVE_TEST_LARGE_MODEL || '';",
      "const isBase = model.includes('base');",
      "const accuracy = isBase ? 0.4 : 0.6;",
      "const reportPath = process.env.ELIZA_ACTION_BENCHMARK_REPORT_JSON_PATH;",
      "const markdownPath = process.env.ELIZA_ACTION_BENCHMARK_REPORT_PATH;",
      "const report = {",
      "  schema: 'eliza_action_selection_benchmark_report',",
      "  schemaVersion: 1,",
      "  generatedAt: '2026-01-02T03:04:05.000Z',",
      "  source: { kind: 'app_core_action_selection_benchmark' },",
      "  summary: {",
      "    total: 1,",
      "    passed: accuracy === 0.6 ? 1 : 0,",
      "    failed: accuracy === 0.6 ? 0 : 1,",
      "    accuracy,",
      "    plannerAccuracy: accuracy,",
      "    executionAccuracy: accuracy",
      "  },",
      "  failureModes: {},",
      "  failures: [],",
      "  results: []",
      "};",
      "fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\\n`);",
      "fs.writeFileSync(markdownPath, `# Action Benchmark\\n\\naccuracy: ${accuracy}\\n`);",
      "NODE",
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(path, 0o755);
}

async function withModelsEndpoint<T>(
  fn: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const server = createServer((req, res) => {
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("test server did not bind to a TCP port");
  }
  try {
    return await fn(`http://127.0.0.1:${address.port}/v1`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("training collection runner", () => {
  afterEach(async () => {
    await Promise.all(
      outputDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("records live benchmark and eval preflight requirements", () => {
    const preflight = buildTrainingCollectionPreflight({
      workspaceRoot: "/repo",
      trainingRoot: "/repo/packages/training",
      options: {
        includeActionBenchmark: true,
        includeEvalComparison: true,
        includeBenchmarkVsCerebras: true,
        actionBenchmark: {
          dryRun: false,
          provider: "local-llama-cpp",
          baseUrl: "http://localhost:11434/v1",
        },
        evalComparison: {
          dryRun: false,
          model: "eliza-1-0_8b-base",
          trainedModelPath: "eliza-1-0_8b-trained",
          backend: "cpu",
        },
        benchmarkVsCerebras: {
          dryRun: false,
        },
      },
    });

    expect(preflight.liveRequired).toBe(true);
    expect(preflight.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "app_core_action_benchmark",
          status: "missing",
        }),
        expect.objectContaining({
          id: "action_benchmark_provider",
          status: "warning",
          detail: expect.stringContaining("http://localhost:11434/v1"),
        }),
        expect.objectContaining({
          id: "feed_database_url",
          status: "skipped",
          detail: "live feed generation not requested",
        }),
        expect.objectContaining({
          id: "cerebras_api_key",
          status: process.env.CEREBRAS_API_KEY ? "ok" : "missing",
        }),
        expect.objectContaining({
          id: "eval_model_inputs",
          status: "ok",
        }),
      ]),
    );
  });

  it("records live feed database preflight requirements", () => {
    const originalDatabaseUrl = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      const preflight = buildTrainingCollectionPreflight({
        workspaceRoot: "/repo",
        trainingRoot: "/repo/packages/training",
        options: {
          includeFeed: true,
          includeActionBenchmark: false,
          includeEvalComparison: false,
          includeBenchmarkVsCerebras: false,
          feed: {
            dryRun: false,
          },
        },
      });

      expect(preflight.liveRequired).toBe(true);
      expect(preflight.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "feed_database_url",
            status: "missing",
            detail: expect.stringContaining("DATABASE_URL is required"),
          }),
        ]),
      );
    } finally {
      if (originalDatabaseUrl === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = originalDatabaseUrl;
      }
    }
  });

  it("probes local action benchmark endpoints when requested", async () => {
    await withModelsEndpoint(async (baseUrl) => {
      const preflight = await buildTrainingCollectionPreflightWithProbes({
        workspaceRoot: "/repo",
        trainingRoot: "/repo/packages/training",
        options: {
          preflightProbe: true,
          includeActionBenchmark: true,
          actionBenchmark: {
            dryRun: false,
            provider: "local-llama-cpp",
            baseUrl,
          },
        },
      });

      expect(preflight.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "action_benchmark_endpoint",
            status: "ok",
            detail: expect.stringContaining(`${baseUrl}/models`),
          }),
        ]),
      );
    });
  });

  it("collects selected sources into one run and rebuilds the analysis index", async () => {
    const collectionRoot = join(
      tmpdir(),
      `training-collection-root-${Date.now()}`,
    );
    const outputDir = join(collectionRoot, "run-1");
    const sourceDir = join(
      tmpdir(),
      `training-collection-source-${Date.now()}`,
    );
    outputDirs.push(collectionRoot);
    outputDirs.push(sourceDir);
    await mkdir(sourceDir, { recursive: true });
    const fakeTrainingRoot = join(sourceDir, "training-root");
    await mkdir(join(fakeTrainingRoot, "scripts", "manifest"), {
      recursive: true,
    });
    await writeFile(
      join(fakeTrainingRoot, "scripts", "benchmark_vs_cerebras.py"),
      [
        "import argparse, json",
        "from pathlib import Path",
        "parser = argparse.ArgumentParser()",
        "parser.add_argument('--tiers')",
        "parser.add_argument('--benchmark')",
        "parser.add_argument('--variants')",
        "parser.add_argument('--cerebras-model')",
        "parser.add_argument('--max-samples')",
        "parser.add_argument('--output-dir')",
        "parser.add_argument('--matrix-output-dir')",
        "parser.add_argument('--dry-run', action='store_true')",
        "args = parser.parse_args()",
        "Path(args.output_dir).mkdir(parents=True, exist_ok=True)",
        "matrix_dir = Path(args.matrix_output_dir)",
        "matrix_dir.mkdir(parents=True, exist_ok=True)",
        "artifact = {",
        "  'schema': 'eliza_benchmark_matrix_artifact',",
        "  'version': 1,",
        "  'generatedAt': '2026-01-02T03:04:05.000Z',",
        "  'source': {'kind': 'benchmark_vs_cerebras'},",
        "  'referenceModelId': 'cerebras/gpt-oss-120b',",
        "  'tiers': ['0_8b'],",
        "  'benchmarks': ['hermes'],",
        "  'counts': {'rows': 3, 'comparisons': 1, 'tiers': 1, 'benchmarks': 1},",
        "  'rows': [",
        "    {",
        "      'modelId': 'eliza-1-0_8b-base',",
        "      'variant': 'base',",
        "      'tier': '0_8b',",
        "      'benchmark': 'hermes',",
        "      'score': 0.4",
        "    },",
        "    {",
        "      'modelId': 'eliza-1-0_8b-trained',",
        "      'variant': 'trained',",
        "      'tier': '0_8b',",
        "      'benchmark': 'hermes',",
        "      'score': 0.5",
        "    },",
        "    {",
        "      'modelId': 'cerebras/gpt-oss-120b',",
        "      'variant': 'reference',",
        "      'provider': 'cerebras',",
        "      'benchmark': 'hermes',",
        "      'score': 0.8",
        "    }",
        "  ],",
        "  'comparisons': [{",
        "    'tier': '0_8b',",
        "    'benchmark': 'hermes',",
        "    'baseScore': 0.4,",
        "    'trainedScore': 0.5,",
        "    'referenceScore': 0.8,",
        "    'improvementPercent': 25,",
        "    'referenceModelId': 'cerebras/gpt-oss-120b'",
        "  }]",
        "}",
        "(matrix_dir / 'benchmark-matrix.json').write_text(json.dumps(artifact, indent=2))",
        "print(json.dumps({'ok': True, 'dryRun': args.dry_run}))",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(
        fakeTrainingRoot,
        "scripts",
        "manifest",
        "stage_hf_eliza1_bundle.py",
      ),
      [
        "import json",
        "print(json.dumps({",
        '  "repoId": "elizaos/eliza-1",',
        '  "tier": "0_8b",',
        '  "bundleDir": "/tmp/eliza-1-bundles/eliza-1-0_8b.bundle",',
        '  "fileCount": 87,',
        '  "plannedBytes": 5939381241,',
        '  "maxBytes": 8589934592,',
        '  "apply": False,',
        '  "staged": []',
        "}))",
        "",
      ].join("\n"),
      "utf8",
    );
    const scoredActionArtifactPath = join(
      sourceDir,
      "action-benchmark-report.json",
    );
    await writeFile(
      scoredActionArtifactPath,
      `${JSON.stringify(
        {
          schema: "eliza_action_selection_benchmark_report",
          generatedAt: "2026-01-02T03:04:05.000Z",
          summary: {
            total: 2,
            passed: 1,
            failed: 1,
            accuracy: 0.5,
            plannerAccuracy: 0.5,
            executionAccuracy: 0.5,
          },
          results: [
            {
              caseId: "message-route",
              prompt: "send David the update",
              expectedAction: "MESSAGE",
              actualAction: "MESSAGE",
              pass: true,
              response: "Message queued for David.",
              latencyMs: 42,
              trajectoryPath: join(
                sourceDir,
                "action-benchmark",
                "cases",
                "message-route.json",
              ),
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const testTrajectoryRoot = join(sourceDir, "test-trajectories");
    await mkdir(join(testTrajectoryRoot, "cases"), { recursive: true });
    await writeFile(
      join(testTrajectoryRoot, "cases", "app-core-test-case.json"),
      `${JSON.stringify(appCoreTestTrajectory(), null, 2)}\n`,
      "utf8",
    );

    const result = await runTrainingCollection({
      outputDir,
      includeHuggingFace: true,
      includeFeed: false,
      includeNaturalTrajectories: true,
      includeTestTrajectories: true,
      includeScenarios: true,
      includeEvalComparison: true,
      includeActionBenchmark: true,
      includeBenchmarkVsCerebras: true,
      includeEliza1BundleStage: true,
      includeBenchmarkMatrix: true,
      huggingFace: {
        dryRun: true,
        repoId: "elizaos/eliza-1-training",
        files: ["sft/0_8b/train.jsonl"],
      },
      naturalTrajectories: {
        trajectories: [naturalTrajectory()],
        tasks: ["response"],
      },
      testTrajectories: {
        roots: [testTrajectoryRoot],
      },
      actionBenchmark: {
        dryRun: true,
        filter: "message",
        runsPerCase: 1,
      },
      scenarios: {
        dryRun: true,
        scenario: "deterministic-pr-smoke",
      },
      evalComparison: {
        dryRun: true,
        model: "eliza-1-0b-base",
        trainedModelPath: "/models/eliza-1-0b-trained",
        backend: "cpu",
      },
      benchmarkVsCerebras: {
        trainingRoot: fakeTrainingRoot,
        dryRun: true,
        tiers: "qwen3.5-0.8b",
        benchmark: "hermes",
        variants: "both",
        maxSamples: 1,
      },
      benchmarkMatrix: {
        artifacts: [
          {
            path: scoredActionArtifactPath,
            modelId: "eliza-1-0b-base",
            variant: "base",
            tier: "0b",
          },
        ],
      },
      eliza1BundleStage: {
        trainingRoot: fakeTrainingRoot,
        localDir: "/tmp/eliza-1-bundles",
      },
      now: () => new Date("2026-01-02T03:04:05.000Z"),
    });

    expect(result.manifest.schema).toBe(TRAINING_COLLECTION_RUN_SCHEMA);
    expect(result.outputDir).toBe(outputDir);
    expect(result.manifest.evidence.preflight).toMatchObject({
      liveRequired: false,
    });
    expect(result.manifest.evidence.preflight.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "app_core_action_benchmark",
          status: "ok",
        }),
        expect.objectContaining({
          id: "cerebras_api_key",
          status: "skipped",
        }),
      ]),
    );
    expect(result.manifest.recipe).toMatchObject({
      include: {
        huggingFace: true,
        feed: false,
        naturalTrajectories: true,
        testTrajectories: true,
        scenarios: true,
        evalComparison: true,
        actionBenchmark: true,
        benchmarkVsCerebras: true,
        eliza1BundleStage: true,
        benchmarkMatrix: true,
      },
      sources: {
        huggingFace: {
          repoId: "elizaos/eliza-1-training",
          files: ["sft/0_8b/train.jsonl"],
        },
        naturalTrajectories: {
          trajectoryCount: 1,
          tasks: ["response"],
        },
        testTrajectories: {
          roots: [testTrajectoryRoot],
        },
        scenarios: {
          scenario: "deterministic-pr-smoke",
        },
      },
      evals: {
        actionBenchmark: {
          filter: "message",
          runsPerCase: 1,
        },
        actionBenchmarkPair: {
          tier: "0_8b",
          base: { variant: "base" },
          trained: { variant: "trained" },
        },
        benchmarkVsCerebras: {
          tiers: "qwen3.5-0.8b",
          benchmark: "hermes",
          variants: "both",
        },
      },
      training: {
        eliza1BundleStage: {
          localDir: "/tmp/eliza-1-bundles",
        },
      },
    });
    expect(result.manifest.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "huggingface",
          status: "succeeded",
          outputDir: join(outputDir, "huggingface"),
        }),
        expect.objectContaining({
          id: "feed",
          status: "skipped",
        }),
        expect.objectContaining({
          id: "natural_trajectories",
          status: "succeeded",
          outputDir: join(outputDir, "natural_trajectories"),
        }),
        expect.objectContaining({
          id: "test_trajectories",
          status: "succeeded",
          outputDir: join(outputDir, "test_trajectories"),
        }),
        expect.objectContaining({
          id: "scenarios",
          status: "succeeded",
          outputDir: join(outputDir, "scenarios"),
        }),
        expect.objectContaining({
          id: "eval_comparison",
          status: "succeeded",
          outputDir: join(outputDir, "eval_comparison"),
        }),
        expect.objectContaining({
          id: "action_benchmark",
          status: "succeeded",
          outputDir: join(outputDir, "action_benchmark"),
        }),
        expect.objectContaining({
          id: "benchmark_vs_cerebras",
          status: "succeeded",
          outputDir: join(outputDir, "benchmark_vs_cerebras"),
        }),
        expect.objectContaining({
          id: "eliza1_model_registry",
          status: "succeeded",
          outputDir: join(outputDir, "eliza1_model_registry"),
        }),
        expect.objectContaining({
          id: "eliza1_bundle_stage",
          status: "succeeded",
          outputDir: join(outputDir, "eliza1_bundle_stage"),
        }),
      ]),
    );
    const modelRegistryStep = result.manifest.steps.find(
      (step) => step.id === "eliza1_model_registry",
    );
    const modelRegistryManifests = (
      modelRegistryStep?.result as { manifests?: unknown[] } | null
    )?.manifests;
    expect(modelRegistryManifests).toHaveLength(10);
    expect(modelRegistryStep?.result).toMatchObject({
      manifests: expect.arrayContaining([
        expect.objectContaining({
          tier: "0_8b",
          variant: "base",
          modelId: "eliza-1-0_8b-base",
          outputPath: "hf://elizaos/eliza-1-0_8b-base",
          baseModel: null,
        }),
        expect.objectContaining({
          tier: "0_8b",
          variant: "trained",
          modelId: "eliza-1-0_8b-trained",
          outputPath: "hf://elizaos/eliza-1-0_8b-trained",
          baseModel: "eliza-1-0_8b-base",
        }),
      ]),
    });
    expect(result.manifest.analysis.indexHtmlPath).toBe(
      join(outputDir, "analysis", "index.html"),
    );
    expect(result.analysis.manifest.counts.collectionRuns).toBe(1);
    expect(result.analysis.manifest.counts.evals).toBe(4);
    expect(result.analysis.manifest.counts.benchmarkMatrices).toBe(2);
    expect(result.analysis.manifest.counts.models).toBe(11);
    expect(result.analysis.manifest.counts.trajectoryBundles).toBe(1);
    expect(result.analysis.manifest.counts.trajectoryDatasets).toBe(5);
    expect(result.manifest.readiness).toMatchObject({
      outputDir: join(outputDir, "analysis"),
      reportPath: join(outputDir, "analysis", "training-readiness-report.json"),
      status: "partial",
    });
    expect(result.manifest.readiness.ready).toBeGreaterThan(0);
    expect(result.manifest.evidence).toMatchObject({
      viewerHtmlPath: join(outputDir, "analysis", "index.html"),
      analysisManifestPath: join(
        outputDir,
        "analysis",
        "analysis-manifest.json",
      ),
      readinessReportPath: join(
        outputDir,
        "analysis",
        "training-readiness-report.json",
      ),
      stepCounts: { skipped: 1, succeeded: 10, failed: 0 },
      dataSources: {
        huggingFaceDatasets: 1,
        feedDatasets: 0,
        naturalTrajectoryBundles: 1,
        scenarioRuns: 1,
        scenarioNativeDatasets: 1,
        testTrajectories: 1,
        trainingJsonlDatasets: 2,
      },
      sourceSamples: {
        natural: expect.arrayContaining([
          expect.objectContaining({
            trajectoryId: "natural-traj-1",
            task: "response",
            model: "eliza-1-0.8b-natural",
            input: "What should I do next?",
            output: "Review the latest task and pick the smallest action.",
          }),
          expect.objectContaining({
            trajectoryId: "natural-traj-1",
            task: "action_planner",
            callId: "call-2",
            input: "Which tool should run?",
            output: "RUN_COLLECTION_PREFLIGHT",
          }),
        ]),
        tests: expect.arrayContaining([
          expect.objectContaining({
            trajectoryId: null,
            scenarioId: "app-core-test-scenario",
            input: "Open settings",
            output: "Opening settings.",
          }),
        ]),
        trainingJsonl: expect.arrayContaining([
          expect.objectContaining({
            trajectoryId: "natural-traj-1",
          }),
        ]),
      },
      training: {
        trainingRuns: 0,
        models: 11,
        modelInventory: expect.arrayContaining([
          expect.objectContaining({
            model: "eliza-1-0_8b-base",
            tier: "0_8b",
            variant: "base",
            outputPath: "hf://elizaos/eliza-1-0_8b-base",
            baseModel: null,
          }),
          expect.objectContaining({
            model: "eliza-1-0_8b-trained",
            tier: "0_8b",
            variant: "trained",
            baseModel: "eliza-1-0_8b-base",
            outputPath: "hf://elizaos/eliza-1-0_8b-trained",
          }),
          expect.objectContaining({
            model: "eliza-1-27b-base",
            tier: "27b",
            variant: "base",
          }),
          expect.objectContaining({
            model: "eliza-1-27b-trained",
            tier: "27b",
            variant: "trained",
          }),
        ]),
      },
      evals: {
        evalArtifacts: 4,
        actionBenchmarks: 2,
        evalComparisons: 1,
        benchmarkMatrices: 2,
        comparisonInventory: expect.arrayContaining([
          expect.objectContaining({
            baseModel: "eliza-1-0b-base",
            trainedModel: "/models/eliza-1-0b-trained",
            backend: "cpu",
            reportPath: join(
              outputDir,
              "eval_comparison",
              "local_model_comparison.json",
            ),
          }),
        ]),
      },
      coverage: {
        dataSources: expect.objectContaining({
          huggingFace: 1,
          feed: 0,
          natural: 1,
          scenarios: 2,
          tests: 1,
        }),
        readableSamples: expect.objectContaining({
          total: expect.any(Number),
        }),
        evals: expect.objectContaining({
          comparisons: 1,
          scoredComparisons: 0,
        }),
        benchmarks: expect.objectContaining({
          matrices: 2,
          scoredComparisons: expect.any(Number),
          allEliza1TiersCovered: false,
        }),
        models: {
          artifacts: 11,
          stagedBundles: 1,
          inventoryCount: 10,
        },
      },
      benchmarkReadiness: {
        smallestTier: "ready",
        cerebrasReference: "ready",
        baseTrainedImprovement: "ready",
        allEliza1TierImprovements: "partial",
      },
      benchmarks: {
        comparisonInventory: expect.arrayContaining([
          expect.objectContaining({
            tier: "0_8b",
            benchmark: "hermes",
            baseScore: 0.4,
            trainedScore: 0.5,
            referenceScore: 0.8,
            improvementPercent: 25,
            dryRun: false,
          }),
        ]),
        caseSamples: expect.arrayContaining([
          expect.objectContaining({
            tier: "0_8b",
            variant: "base",
            modelId: "eliza-1-0b-base",
            benchmark: "eliza_harness_action_selection",
            caseId: "message-route",
            prompt: "send David the update",
            expectedAction: "MESSAGE",
            actualAction: "MESSAGE",
            pass: true,
            response: "Message queued for David.",
          }),
        ]),
      },
    });
    expect(result.manifest.evidence.readinessGaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "feed_generation",
          status: "missing",
          recommendedCapability: "terminal-training-feed-generate",
        }),
        expect.objectContaining({
          id: "all_eliza1_tier_improvements",
          status: "partial",
          recommendedCapability: "terminal-training-run-collection",
        }),
      ]),
    );
    expect(result.manifest.evidence.artifactLinks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "huggingface",
          kind: "trajectory_dataset",
          schema: "eliza_huggingface_dataset_ingest",
        }),
        expect.objectContaining({
          category: "natural",
          kind: "trajectory_bundle",
        }),
        expect.objectContaining({
          category: "test",
          kind: "trajectory_dataset",
          schema: "eliza_test_trajectory_record",
        }),
        expect.objectContaining({
          category: "benchmark",
          kind: "benchmark_matrix",
          schema: "eliza_benchmark_matrix_artifact",
        }),
      ]),
    );
    expect(result.analysis.manifest.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "eval",
          summary: expect.objectContaining({
            schema: "eliza_training_readiness_report",
            status: "partial",
          }),
        }),
      ]),
    );
    expect(result.analysis.manifest.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "collection_run",
          summary: expect.objectContaining({
            statuses: { skipped: 1, succeeded: 10 },
            stepIds: [
              "huggingface",
              "feed",
              "natural_trajectories",
              "test_trajectories",
              "scenarios",
              "eval_comparison",
              "action_benchmark",
              "benchmark_vs_cerebras",
              "eliza1_model_registry",
              "eliza1_bundle_stage",
              "benchmark_matrix",
            ],
          }),
        }),
      ]),
    );
    const matrixStep = result.manifest.steps.find(
      (step) => step.id === "benchmark_matrix",
    );
    expect(matrixStep?.result).toMatchObject({
      artifact: {
        rows: expect.arrayContaining([
          expect.objectContaining({
            modelId: "eliza-1-0_8b-trained",
            benchmark: "hermes",
            variant: "trained",
            score: 0.5,
          }),
          expect.objectContaining({
            modelId: "cerebras/gpt-oss-120b",
            benchmark: "hermes",
            variant: "reference",
            score: 0.8,
          }),
        ]),
        comparisons: expect.arrayContaining([
          expect.objectContaining({
            tier: "0_8b",
            benchmark: "hermes",
            improvementPercent: 25,
          }),
        ]),
      },
    });

    const manifestOnDisk = JSON.parse(
      await readFile(result.manifestPath, "utf8"),
    ) as typeof result.manifest;
    expect(result.readmePath).toBe(join(outputDir, "README.md"));
    expect(manifestOnDisk.readmePath).toBe(result.readmePath);
    expect(manifestOnDisk.provenance).toMatchObject({
      generatedBy: "plugin-training",
      analysisRoots: [outputDir],
      outputLayout: {
        collection: outputDir,
        analysis: join(outputDir, "analysis"),
        steps: outputDir,
      },
    });
    expect(manifestOnDisk.provenance.trainingStateRoot).toContain("training");
    expect(manifestOnDisk.evidence.stepArtifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stepId: "action_benchmark",
          status: "succeeded",
          command: expect.arrayContaining([
            "vitest",
            "../test/vitest/real.config.ts",
          ]),
          stdout: expect.stringContaining("DRY RUN"),
          stderr: null,
          paths: expect.arrayContaining([
            expect.objectContaining({
              label: expect.stringContaining("reportJsonPath"),
              path: expect.stringContaining("action-benchmark-report.json"),
            }),
          ]),
        }),
        expect.objectContaining({
          stepId: "benchmark_matrix",
          paths: expect.arrayContaining([
            expect.objectContaining({
              path: expect.stringContaining("benchmark-matrix.json"),
            }),
          ]),
        }),
      ]),
    );
    expect(manifestOnDisk.analysis.artifactCount).toBe(
      result.analysis.manifest.counts.artifacts,
    );
    const listedCollections = await listTrainingCollections({
      root: outputDir,
      limit: 5,
    });
    expect(listedCollections).toMatchObject({
      root: outputDir,
      indexJsonPath: join(outputDir, "collection-index.json"),
      indexHtmlPath: join(outputDir, "collection-index.html"),
      collections: [
        {
          generatedAt: "2026-01-02T03:04:05.000Z",
          outputDir,
          manifestPath: join(outputDir, "collection-manifest.json"),
          readmePath: join(outputDir, "README.md"),
          analysisIndexHtmlPath: join(outputDir, "analysis", "index.html"),
          readinessStatus: "partial",
          readiness: {
            ready: result.manifest.readiness.ready,
            partial: result.manifest.readiness.partial,
            missing: result.manifest.readiness.missing,
          },
          readinessGaps: expect.arrayContaining([
            expect.objectContaining({
              id: "feed_generation",
              recommendedCapability: "terminal-training-feed-generate",
            }),
          ]),
          artifactCount: result.analysis.manifest.counts.artifacts,
          dataSources: {
            naturalTrajectoryBundles: 1,
            testTrajectories: 1,
          },
          sourceSamples: {
            natural: expect.arrayContaining([
              expect.objectContaining({
                trajectoryId: "natural-traj-1",
                input: "What should I do next?",
                output: "Review the latest task and pick the smallest action.",
              }),
            ]),
            tests: expect.arrayContaining([
              expect.objectContaining({
                scenarioId: "app-core-test-scenario",
                input: "Open settings",
                output: "Opening settings.",
              }),
            ]),
          },
          evidenceArtifacts: expect.arrayContaining([
            expect.objectContaining({
              category: "eval",
              path: expect.stringContaining("eval"),
            }),
            expect.objectContaining({
              category: "benchmark",
              path: expect.stringContaining("benchmark"),
            }),
            expect.objectContaining({
              category: "model",
              path: expect.stringContaining("model"),
            }),
          ]),
          training: {
            trainingRuns: 0,
            models: expect.any(Number),
            modelInventory: expect.arrayContaining([
              expect.objectContaining({
                tier: "0_8b",
                variant: "base",
              }),
            ]),
          },
          benchmarks: {
            benchmarkComparisons: expect.any(Number),
            caseSamples: expect.any(Number),
          },
          evals: {
            evalArtifacts: 4,
            evalComparisons: 1,
            actionBenchmarks: 2,
            benchmarkMatrices: 2,
            comparisonInventory: expect.arrayContaining([
              expect.objectContaining({
                baseModel: "eliza-1-0b-base",
                trainedModel: "/models/eliza-1-0b-trained",
              }),
            ]),
          },
          coverage: {
            readableSamples: expect.objectContaining({
              total: expect.any(Number),
            }),
            evals: expect.objectContaining({
              scoredComparisons: 0,
            }),
            benchmarks: expect.objectContaining({
              matrices: 2,
              allEliza1TiersCovered: false,
            }),
          },
        },
      ],
    });
    expect(listedCollections.collections[0]?.sourceArtifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "natural",
          path: expect.stringContaining("natural"),
        }),
        expect.objectContaining({
          category: "test",
          path: expect.stringContaining("test_trajectories"),
        }),
      ]),
    );
    expect(result.collectionIndex).toMatchObject({
      root: collectionRoot,
      indexJsonPath: join(collectionRoot, "collection-index.json"),
      indexHtmlPath: join(collectionRoot, "collection-index.html"),
      collections: [
        expect.objectContaining({
          outputDir,
          readmePath: join(outputDir, "README.md"),
          analysisIndexHtmlPath: join(outputDir, "analysis", "index.html"),
        }),
      ],
    });
    const collectionIndexJson = JSON.parse(
      await readFile(result.collectionIndex.indexJsonPath, "utf8"),
    ) as typeof result.collectionIndex;
    expect(collectionIndexJson.schema).toBe("eliza_training_collection_index");
    const collectionIndexHtml = await readFile(
      result.collectionIndex.indexHtmlPath,
      "utf8",
    );
    expect(collectionIndexHtml).toContain("Eliza Training Collections");
    expect(collectionIndexHtml).toContain("native:1");
    expect(collectionIndexHtml).toContain("natural:");
    expect(collectionIndexHtml).toContain("test:");
    expect(collectionIndexHtml).toContain("input:What should I do next?");
    expect(collectionIndexHtml).toContain("output:Opening settings.");
    expect(collectionIndexHtml).toContain("eval:");
    expect(collectionIndexHtml).toContain("benchmark:");
    expect(collectionIndexHtml).toContain("model:");
    expect(collectionIndexHtml).toContain(
      "feed_generation:missing-&gt;terminal-training-feed-generate",
    );
    expect(collectionIndexHtml).toContain("params={&quot;dryRun&quot;:false}");
    expect(collectionIndexHtml).toContain("viewer");
    expect(collectionIndexHtml).toContain("README.md");
    expect(collectionIndexHtml).toContain(
      "established:0_8b next:2b remaining:2b,4b,9b,27b",
    );
    const readme = await readFile(result.readmePath, "utf8");
    expect(readme).toContain("# Eliza Training Collection");
    expect(readme).toContain("collection-manifest.json");
    expect(readme).toContain("analysis/index.html");
    expect(readme).toContain("training-readiness-report.json");
    expect(readme).toContain("## Provenance");
    expect(readme).toContain("Generated by: plugin-training");
    expect(readme).toContain(`Analysis roots: ${outputDir}`);
    expect(readme).toContain("## Step Artifacts");
    expect(readme).toContain("Stdout");
    expect(readme).toContain("DRY RUN");
    expect(readme).toContain("action-benchmark-report.json");
    expect(readme).toContain("benchmark-matrix.json");
    expect(readme).toContain("## Benchmark Case Samples");
    expect(readme).toContain("## Eval Comparisons");
    expect(readme).toContain("/models/eliza-1-0b-trained");
    expect(readme).toContain("local_model_comparison.json");
    expect(readme).toContain(
      "[local_model_comparison.json](file://",
    );
    expect(readme).toContain("message-route");
    expect(readme).toContain("[message-route.json](file://");
    expect(readme).toContain(
      "[eliza-1-0b-trained](file:///models/eliza-1-0b-trained)",
    );
    expect(readme).toContain("## Readiness Gaps");
    expect(readme).toContain("Recommended Params");
    expect(readme).toContain("{\"dryRun\":false}");
    expect(readme).toContain("## Coverage");
    expect(readme).toContain("## Baseline Progression");
    expect(readme).toContain("Benchmark comparisons: scored=");
    expect(readme).toContain("feed_generation");
    expect(readme).toContain("## Source Samples");
    expect(readme).toContain("## Source Sample Preview");
    expect(readme).toContain("What should I do next?");
    expect(readme).toContain(
      "Review the latest task and pick the smallest action.",
    );
    expect(readme).toContain("Open settings");
    expect(readme).toContain("## Model Inventory");
    const html = await readFile(result.analysis.indexHtmlPath, "utf8");
    expect(html).toContain("Collections");
    expect(html).toContain("Collection Steps");
    expect(html).toContain("eliza_training_collection_run");
    expect(html).toContain("huggingface");
    expect(html).toContain("natural_trajectories");
    expect(html).toContain("scenarios");
    expect(html).toContain("eval_comparison");
    expect(html).toContain("action_benchmark");
    expect(html).toContain("benchmark_vs_cerebras");
    expect(html).toContain("benchmark_matrix");
    expect(html).toContain("eliza1_bundle_stage");
    expect(html).toContain("eliza-1-0_8b.bundle");
    expect(html).toContain("Collection Eval Comparisons");
    expect(html).toContain("/models/eliza-1-0b-trained");
    expect(html).toContain("local_model_comparison.json");
    expect(html).toContain("eliza_training_readiness_report");
    expect(html).toContain("eliza_harness_action_selection");
    expect(result.collectionIndex.collections[0]?.evals).toMatchObject({
      evalArtifacts: 4,
      evalComparisons: 1,
      actionBenchmarks: 2,
      benchmarkMatrices: 2,
    });
    expect(collectionIndexHtml).toContain("Evals");
    expect(collectionIndexHtml).toContain("Coverage");
    expect(collectionIndexHtml).toContain("all-tiers:no");
    expect(collectionIndexHtml).toContain(
      "evals:4 comparisons:1 action:2 matrices:2",
    );
  });

  it("runs paired base and trained action benchmarks into the benchmark matrix", async () => {
    const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const outputDir = join(tmpdir(), `training-collection-pair-${stamp}`);
    const toolDir = join(tmpdir(), `training-collection-tools-${stamp}`);
    outputDirs.push(outputDir);
    outputDirs.push(toolDir);
    await mkdir(toolDir, { recursive: true });
    const fakeBun = join(toolDir, "fake-bun");
    await writeFakeActionBenchmarkBun(fakeBun);

    const restoreLocalModels = stubLocalBenchmarkModels([
      "eliza-1-0_8b-base",
      "eliza-1-0_8b-trained",
    ]);
    let result: Awaited<ReturnType<typeof runTrainingCollection>>;
    try {
      result = await runTrainingCollection({
        outputDir,
        includeHuggingFace: false,
        includeFeed: false,
        includeNaturalTrajectories: false,
        includeTestTrajectories: false,
        includeScenarios: false,
        includeEvalComparison: false,
        includeActionBenchmark: true,
        includeBenchmarkVsCerebras: false,
        includeEliza1BundleStage: false,
        includeBenchmarkMatrix: true,
        actionBenchmark: {
          workspaceRoot: join(process.cwd(), "../.."),
          bun: fakeBun,
          useMocks: false,
          forceTrajectoryCapture: false,
          provider: "local-llama-cpp",
          benchmark: "eliza_harness_action_selection",
          tier: "0_8b",
          datasetVersion: "eliza-native-v1",
          runsPerCase: 1,
        },
        actionBenchmarkPair: {
          base: {
            modelId: "eliza-1-0_8b-base",
            runtimeModel: "eliza-1-0_8b-base",
            variant: "base",
          },
          trained: {
            modelId: "eliza-1-0_8b-trained",
            runtimeModel: "eliza-1-0_8b-trained",
            variant: "trained",
          },
        },
        now: () => new Date("2026-01-02T03:04:05.000Z"),
      });
    } finally {
      restoreLocalModels();
    }

    const actionStep = result.manifest.steps.find(
      (step) => step.id === "action_benchmark",
    );
    if (actionStep?.status === "failed") {
      throw new Error(actionStep.error ?? "action benchmark step failed");
    }
    expect(actionStep).toMatchObject({
      status: "succeeded",
      outputDir: join(outputDir, "action_benchmark"),
      result: {
        outputDir: join(outputDir, "action_benchmark"),
        runs: {
          base: {
            reportJsonPath: join(
              outputDir,
              "action_benchmark",
              "base",
              "action-benchmark-report.json",
            ),
            matrixSource: {
              modelId: "eliza-1-0_8b-base",
              variant: "base",
            },
          },
          trained: {
            reportJsonPath: join(
              outputDir,
              "action_benchmark",
              "trained",
              "action-benchmark-report.json",
            ),
            matrixSource: {
              modelId: "eliza-1-0_8b-trained",
              variant: "trained",
            },
          },
        },
        matrixSources: [
          expect.objectContaining({
            modelId: "eliza-1-0_8b-base",
            variant: "base",
          }),
          expect.objectContaining({
            modelId: "eliza-1-0_8b-trained",
            variant: "trained",
          }),
        ],
      },
    });

    const matrixStep = result.manifest.steps.find(
      (step) => step.id === "benchmark_matrix",
    );
    expect(matrixStep).toMatchObject({
      status: "succeeded",
      result: {
        artifact: {
          rows: [
            expect.objectContaining({
              modelId: "eliza-1-0_8b-base",
              benchmark: "eliza_harness_action_selection",
              variant: "base",
              tier: "0_8b",
              score: 0.4,
            }),
            expect.objectContaining({
              modelId: "eliza-1-0_8b-trained",
              benchmark: "eliza_harness_action_selection",
              variant: "trained",
              tier: "0_8b",
              score: 0.6,
            }),
          ],
          comparisons: [
            expect.objectContaining({
              tier: "0_8b",
              benchmark: "eliza_harness_action_selection",
              baseScore: 0.4,
              trainedScore: 0.6,
              improvementPercent: 50,
            }),
          ],
        },
      },
    });
    expect(result.manifest.evidence.evals).toMatchObject({
      actionBenchmarks: 2,
      benchmarkMatrices: 1,
    });
    expect(result.manifest.evidence.benchmarks).toMatchObject({
      actionBenchmarkPairs: 1,
      actionBenchmarkMatrixSources: 2,
      benchmarkRows: 2,
      benchmarkComparisons: 1,
      tiers: ["0_8b"],
      improvementComparisons: [
        expect.objectContaining({
          tier: "0_8b",
          benchmark: "eliza_harness_action_selection",
          baseScore: 0.4,
          trainedScore: 0.6,
          improvementPercent: 50,
        }),
      ],
    });
    expect(result.manifest.evidence.benchmarkReadiness).toMatchObject({
      smallestTier: "ready",
      baseTrainedImprovement: "ready",
      allEliza1TierImprovements: "partial",
    });
    expect(result.manifest.evidence.readinessGaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "all_eliza1_tiers_benchmark",
          status: "partial",
          recommendedCapability: "terminal-training-run-collection",
        }),
        expect.objectContaining({
          id: "all_eliza1_tier_improvements",
          status: "partial",
          recommendedCapability: "terminal-training-run-collection",
        }),
      ]),
    );
  });

  it("derives baseline progress when listing older collection manifests", async () => {
    const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const root = join(tmpdir(), `training-collection-legacy-${stamp}`);
    const runDir = join(root, "run-1");
    const manifestPath = join(runDir, "collection-manifest.json");
    outputDirs.push(root);
    await writeJson(manifestPath, {
      schema: TRAINING_COLLECTION_RUN_SCHEMA,
      schemaVersion: 1,
      generatedAt: "2026-01-02T03:04:05.000Z",
      outputDir: runDir,
      manifestPath,
      readmePath: join(runDir, "README.md"),
      provenance: {
        generatedBy: "plugin-training",
        workspaceRoot: null,
        trainingStateRoot: root,
        analysisRoots: [runDir],
        outputLayout: { collection: runDir, analysis: runDir, steps: runDir },
      },
      recipe: {},
      analysis: {
        outputDir: join(runDir, "analysis"),
        indexHtmlPath: join(runDir, "analysis", "index.html"),
        manifestPath: join(runDir, "analysis", "analysis-manifest.json"),
        artifactCount: 2,
      },
      readiness: {
        outputDir: join(runDir, "analysis"),
        reportPath: join(runDir, "analysis", "training-readiness-report.json"),
        status: "partial",
        ready: 1,
        partial: 1,
        missing: 1,
      },
      evidence: {
        artifactCounts: {
          trajectoryBundles: 0,
          trajectoryDatasets: 0,
          scenarioRuns: 0,
          collectionRuns: 1,
          trainingRuns: 0,
          evals: 0,
          benchmarkMatrices: 1,
          models: 0,
          artifacts: 2,
        },
        stepCounts: { skipped: 0, succeeded: 2, failed: 0 },
        dataSources: {
          huggingFaceDatasets: 0,
          feedDatasets: 0,
          naturalTrajectoryBundles: 0,
          scenarioRuns: 0,
          scenarioNativeDatasets: 0,
          testTrajectories: 0,
          trainingJsonlDatasets: 0,
        },
        artifactLinks: [
          {
            category: "feed",
            kind: "trajectory_dataset",
            title: "feed-export",
            path: join(runDir, "feed", "manifest.json"),
            schema: "feed_training_trajectory_export",
          },
          {
            category: "benchmark",
            kind: "benchmark_matrix",
            title: "benchmark-matrix",
            path: join(runDir, "matrix", "benchmark-matrix.json"),
            schema: "eliza_benchmark_matrix_artifact",
          },
          {
            category: "eval",
            kind: "eval",
            title: "eval-comparison",
            path: join(runDir, "eval", "eval-comparison.json"),
            schema: "eliza_local_eval_comparison_artifact",
          },
          {
            category: "model",
            kind: "model",
            title: "eliza-1-0_8b-trained",
            path: join(runDir, "models", "0_8b-trained.json"),
            schema: "eliza1_model_registry_entry",
          },
        ],
        training: {
          trainingRuns: 1,
          models: 1,
          modelInventory: [
            {
              title: "eliza-1-0_8b-trained",
              path: join(runDir, "models", "0_8b-trained.json"),
              schema: "eliza1_model_registry_entry",
              model: "eliza-1-0_8b-trained",
              tier: "0_8b",
              variant: "trained",
              outputPath: "hf://elizaos/eliza-1-0_8b-trained",
              baseModel: "eliza-1-0_8b-base",
              repoId: "elizaos/eliza-1-0_8b-trained",
              baseEvalScore: 0.4,
              trainedEvalScore: 0.5,
              evalImprovementPercent: 25,
            },
          ],
        },
        readinessGaps: [
          {
            id: "all_eliza1_tiers_benchmark",
            label: "All Eliza-1 tier benchmark coverage",
            status: "missing",
            note: "Run benchmark matrix coverage for every Eliza-1 tier.",
            recommendedCapability: "terminal-training-run-collection",
            recommendedParams: { actionBenchmarkPairs: "all" },
          },
        ],
        benchmarks: {
          actionBenchmarkPairs: 2,
          actionBenchmarkMatrixSources: 4,
          benchmarkRows: 4,
          benchmarkComparisons: 2,
          tiers: ["0_8b", "2b"],
          comparisonInventory: [],
          improvementComparisons: [
            {
              tier: "0_8b",
              benchmark: "eliza_harness_action_selection",
              baseScore: 0.4,
              trainedScore: 0.5,
              improvementPercent: 25,
              referenceScore: 0.8,
              modelBacked: true,
            },
            {
              tier: "2b",
              benchmark: "eliza_harness_action_selection",
              baseScore: 0.42,
              trainedScore: 0.63,
              improvementPercent: 50,
              referenceScore: 0.8,
              modelBacked: true,
            },
          ],
          caseSamples: [],
        },
        evals: {
          evalArtifacts: 0,
          evalComparisons: 0,
          actionBenchmarks: 0,
          benchmarkMatrices: 1,
          comparisonInventory: [],
        },
      },
      steps: [],
    });

    const listed = await listTrainingCollections({ root });
    expect(listed.collections[0]?.benchmarks.baselineProgress).toEqual({
      tierOrder: ["0_8b", "2b", "4b", "9b", "27b"],
      establishedTiers: ["0_8b", "2b"],
      remainingTiers: ["4b", "9b", "27b"],
      nextTier: "4b",
      smallestTierEstablished: true,
      allTiersEstablished: false,
    });
    expect(listed.collections[0]?.sourceArtifacts).toEqual([
      {
        category: "feed",
        title: "feed-export",
        path: join(runDir, "feed", "manifest.json"),
        schema: "feed_training_trajectory_export",
      },
    ]);
    expect(listed.collections[0]?.evidenceArtifacts).toEqual([
      {
        category: "benchmark",
        title: "benchmark-matrix",
        path: join(runDir, "matrix", "benchmark-matrix.json"),
        schema: "eliza_benchmark_matrix_artifact",
      },
      {
        category: "eval",
        title: "eval-comparison",
        path: join(runDir, "eval", "eval-comparison.json"),
        schema: "eliza_local_eval_comparison_artifact",
      },
      {
        category: "model",
        title: "eliza-1-0_8b-trained",
        path: join(runDir, "models", "0_8b-trained.json"),
        schema: "eliza1_model_registry_entry",
      },
    ]);
    expect(listed.collections[0]?.training).toEqual({
      trainingRuns: 1,
      models: 1,
      modelInventory: [
        {
          title: "eliza-1-0_8b-trained",
          path: join(runDir, "models", "0_8b-trained.json"),
          schema: "eliza1_model_registry_entry",
          model: "eliza-1-0_8b-trained",
          tier: "0_8b",
          variant: "trained",
          outputPath: "hf://elizaos/eliza-1-0_8b-trained",
          baseModel: "eliza-1-0_8b-base",
          repoId: "elizaos/eliza-1-0_8b-trained",
          baseEvalScore: 0.4,
          trainedEvalScore: 0.5,
          evalImprovementPercent: 25,
        },
      ],
    });
    expect(listed.collections[0]?.readinessGaps).toEqual([
      {
        id: "all_eliza1_tiers_benchmark",
        label: "All Eliza-1 tier benchmark coverage",
        status: "missing",
        note: "Run benchmark matrix coverage for every Eliza-1 tier.",
        recommendedCapability: "terminal-training-run-collection",
        recommendedParams: { actionBenchmarkPairs: "all" },
      },
    ]);
    expect(listed.collections[0]?.benchmarks.comparisonInventory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tier: "0_8b",
          benchmark: "eliza_harness_action_selection",
          baseScore: 0.4,
          trainedScore: 0.5,
          referenceScore: 0.8,
          improvementPercent: 25,
          trainedVsReferencePercent: -37.5,
          modelBacked: true,
        }),
      ]),
    );

    const index = await writeTrainingCollectionIndex({ root });
    const html = await readFile(index.indexHtmlPath, "utf8");
    expect(html).toContain("established:0_8b,2b");
    expect(html).toContain("next:4b");
    expect(html).toContain("vs-reference:-37.5%");
    expect(html).toContain("model-backed");
    expect(html).toContain("feed:feed-export");
    expect(html).toContain("benchmark:benchmark-matrix");
    expect(html).toContain("eval:eval-comparison");
    expect(html).toContain("model:eliza-1-0_8b-trained");
    expect(html).toContain("improvement:25%");
    expect(html).toContain(
      "all_eliza1_tiers_benchmark:missing-&gt;terminal-training-run-collection",
    );
  });

  it("runs multi-tier action benchmark pairs into one benchmark matrix", async () => {
    const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const outputDir = join(
      tmpdir(),
      `training-collection-pair-matrix-${stamp}`,
    );
    const toolDir = join(tmpdir(), `training-collection-tools-${stamp}`);
    outputDirs.push(outputDir);
    outputDirs.push(toolDir);
    await mkdir(toolDir, { recursive: true });
    const fakeBun = join(toolDir, "fake-bun");
    await writeFakeActionBenchmarkBun(fakeBun);

    const restoreLocalModels = stubLocalBenchmarkModels([
      "eliza-1-0_8b-base",
      "eliza-1-0_8b-trained",
      "eliza-1-2b-base",
      "eliza-1-2b-trained",
    ]);
    let result: Awaited<ReturnType<typeof runTrainingCollection>>;
    try {
      result = await runTrainingCollection({
        outputDir,
        includeHuggingFace: false,
        includeFeed: false,
        includeNaturalTrajectories: false,
        includeTestTrajectories: false,
        includeScenarios: false,
        includeEvalComparison: false,
        includeActionBenchmark: true,
        includeBenchmarkVsCerebras: false,
        includeEliza1BundleStage: false,
        includeBenchmarkMatrix: true,
        actionBenchmark: {
          workspaceRoot: join(process.cwd(), "../.."),
          bun: fakeBun,
          useMocks: false,
          forceTrajectoryCapture: false,
          provider: "local-llama-cpp",
          benchmark: "eliza_harness_action_selection",
          datasetVersion: "eliza-native-v1",
          runsPerCase: 1,
        },
        actionBenchmarkPairs: [{ tier: "0_8b" }, { tier: "2b" }],
        now: () => new Date("2026-01-02T03:04:05.000Z"),
      });
    } finally {
      restoreLocalModels();
    }

    const actionStep = result.manifest.steps.find(
      (step) => step.id === "action_benchmark",
    );
    if (actionStep?.status === "failed") {
      throw new Error(actionStep.error ?? "action benchmark step failed");
    }
    expect(actionStep?.result).toMatchObject({
      pairs: [
        {
          label: "0_8b",
          tier: "0_8b",
          runs: {
            base: {
              reportJsonPath: join(
                outputDir,
                "action_benchmark",
                "0_8b",
                "base",
                "action-benchmark-report.json",
              ),
              matrixSource: {
                modelId: "eliza-1-0_8b-base",
                variant: "base",
                tier: "0_8b",
              },
            },
            trained: {
              matrixSource: {
                modelId: "eliza-1-0_8b-trained",
                variant: "trained",
                tier: "0_8b",
              },
            },
          },
        },
        {
          label: "2b",
          tier: "2b",
          runs: {
            base: {
              matrixSource: {
                modelId: "eliza-1-2b-base",
                variant: "base",
                tier: "2b",
              },
            },
            trained: {
              matrixSource: {
                modelId: "eliza-1-2b-trained",
                variant: "trained",
                tier: "2b",
              },
            },
          },
        },
      ],
      matrixSources: expect.arrayContaining([
        expect.objectContaining({ modelId: "eliza-1-0_8b-base" }),
        expect.objectContaining({ modelId: "eliza-1-0_8b-trained" }),
        expect.objectContaining({ modelId: "eliza-1-2b-base" }),
        expect.objectContaining({ modelId: "eliza-1-2b-trained" }),
      ]),
    });

    const matrixStep = result.manifest.steps.find(
      (step) => step.id === "benchmark_matrix",
    );
    expect(matrixStep).toMatchObject({
      status: "succeeded",
      result: {
        artifact: {
          counts: {
            rows: 4,
            comparisons: 2,
            tiers: 2,
            benchmarks: 1,
          },
          comparisons: expect.arrayContaining([
            expect.objectContaining({
              tier: "0_8b",
              improvementPercent: 50,
            }),
            expect.objectContaining({
              tier: "2b",
              improvementPercent: 50,
            }),
          ]),
        },
      },
    });
    expect(result.manifest.evidence.evals).toMatchObject({
      actionBenchmarks: 4,
      benchmarkMatrices: 1,
    });
    expect(result.manifest.evidence.benchmarks).toMatchObject({
      actionBenchmarkPairs: 2,
      actionBenchmarkMatrixSources: 4,
      benchmarkRows: 4,
      benchmarkComparisons: 2,
      tiers: ["0_8b", "2b"],
      improvementComparisons: expect.arrayContaining([
        expect.objectContaining({
          tier: "0_8b",
          improvementPercent: 50,
        }),
        expect.objectContaining({
          tier: "2b",
          improvementPercent: 50,
        }),
      ]),
      baselineProgress: {
        tierOrder: ["0_8b", "2b", "4b", "9b", "27b"],
        establishedTiers: ["0_8b", "2b"],
        remainingTiers: ["4b", "9b", "27b"],
        nextTier: "4b",
        smallestTierEstablished: true,
        allTiersEstablished: false,
      },
    });
    const readme = await readFile(result.readmePath, "utf8");
    expect(readme).toContain("## Baseline Progression");
    expect(readme).toContain("Tier order: 0_8b -> 2b -> 4b -> 9b -> 27b");
    expect(readme).toContain("Established tiers: 0_8b, 2b");
    expect(readme).toContain("Next tier: 4b");
  });

  it("defaults action benchmark matrix runs to the smallest base-trained pair", async () => {
    const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const outputDir = join(tmpdir(), `training-collection-dry-matrix-${stamp}`);
    outputDirs.push(outputDir);

    const result = await runTrainingCollection({
      outputDir,
      includeHuggingFace: false,
      includeFeed: false,
      includeNaturalTrajectories: false,
      includeTestTrajectories: false,
      includeScenarios: false,
      includeEvalComparison: false,
      includeActionBenchmark: true,
      includeBenchmarkVsCerebras: false,
      includeEliza1BundleStage: false,
      includeBenchmarkMatrix: true,
      actionBenchmark: {
        dryRun: true,
        useMocks: true,
        forceTrajectoryCapture: false,
        provider: "local-llama-cpp",
        benchmark: "eliza_harness_action_selection",
        datasetVersion: "eliza-native-v1",
      },
      now: () => new Date("2026-01-02T03:04:05.000Z"),
    });

    expect(result.manifest.recipe.evals.actionBenchmarkPair).toMatchObject({
      tier: "0_8b",
      base: { variant: "base" },
      trained: { variant: "trained" },
    });
    expect(result.manifest.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "action_benchmark",
          status: "succeeded",
          result: expect.objectContaining({
            pairs: [
              expect.objectContaining({
                tier: "0_8b",
                runs: {
                  base: expect.objectContaining({
                    matrixSource: expect.objectContaining({
                      modelId: "eliza-1-0_8b-base",
                      variant: "base",
                      tier: "0_8b",
                    }),
                  }),
                  trained: expect.objectContaining({
                    matrixSource: expect.objectContaining({
                      modelId: "eliza-1-0_8b-trained",
                      variant: "trained",
                      tier: "0_8b",
                    }),
                  }),
                },
              }),
            ],
          }),
        }),
        expect.objectContaining({
          id: "benchmark_matrix",
          status: "succeeded",
          result: expect.objectContaining({
            artifact: expect.objectContaining({
              counts: expect.objectContaining({ rows: 2, comparisons: 1 }),
              comparisons: [
                expect.objectContaining({
                  tier: "0_8b",
                  dryRun: true,
                  improvementPercent: null,
                }),
              ],
            }),
          }),
        }),
      ]),
    );
    expect(result.manifest.evidence.benchmarks).toMatchObject({
      actionBenchmarkPairs: 1,
      actionBenchmarkMatrixSources: 2,
      benchmarkRows: 2,
      benchmarkComparisons: 1,
      tiers: ["0_8b"],
      improvementComparisons: [],
      baselineProgress: {
        tierOrder: ["0_8b", "2b", "4b", "9b", "27b"],
        establishedTiers: [],
        remainingTiers: ["0_8b", "2b", "4b", "9b", "27b"],
        nextTier: "0_8b",
        smallestTierEstablished: false,
        allTiersEstablished: false,
      },
    });
    expect(result.manifest.evidence.benchmarkReadiness).toMatchObject({
      smallestTier: "partial",
      baseTrainedImprovement: "partial",
    });
  });

  it("keeps non-natural trajectory bundles out of natural source evidence", async () => {
    const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const outputDir = join(tmpdir(), `training-collection-source-${stamp}`);
    outputDirs.push(outputDir);
    const bundleDir = join(outputDir, "external-bundle");
    const sanitizedJsonlPath = join(
      bundleDir,
      "sanitized",
      "trajectories.sanitized.jsonl",
    );
    await mkdir(dirname(sanitizedJsonlPath), { recursive: true });
    await writeFile(
      sanitizedJsonlPath,
      `${JSON.stringify(naturalTrajectory())}\n`,
      "utf8",
    );
    await writeJson(join(bundleDir, "manifest.json"), {
      schema: "eliza_trajectory_export_bundle",
      schemaVersion: 1,
      generatedAt: "2026-01-02T03:04:05.000Z",
      runId: "external-run",
      source: {
        kind: "external_eval_trajectory_bundle",
        inputTrajectoryCount: 1,
        sanitizedTrajectoryCount: 1,
        droppedTrajectoryCount: 0,
      },
      paths: {
        bundleDir,
        manifestPath: join(bundleDir, "manifest.json"),
        sanitizedJsonlPath,
      },
      counts: {
        rawTrajectoryRows: 0,
        sanitizedTrajectoryRows: 1,
        taskRows: {
          should_respond: 0,
          context_routing: 0,
          action_planner: 0,
          response: 0,
          media_description: 0,
        },
        taskFiles: 0,
        taskExamples: 0,
        llmCalls: 1,
        skippedNonNativeRows: 0,
      },
      tasks: {},
      privacy: {
        applied: false,
        redactionCount: null,
        anonymizationCount: null,
        droppedCount: 0,
        dropped: [],
      },
      cloudUpload: { uploadedToHuggingFace: false },
    });

    const result = await runTrainingCollection({
      outputDir,
      includeHuggingFace: false,
      includeFeed: false,
      includeNaturalTrajectories: false,
      includeTestTrajectories: false,
      includeScenarios: false,
      includeEvalComparison: false,
      includeActionBenchmark: false,
      includeBenchmarkVsCerebras: false,
      includeEliza1ModelRegistry: false,
      includeEliza1BundleStage: false,
      includeBenchmarkMatrix: false,
      now: () => new Date("2026-01-02T03:04:05.000Z"),
    });

    expect(result.analysis.manifest.counts.trajectoryBundles).toBe(1);
    expect(result.manifest.evidence.dataSources.naturalTrajectoryBundles).toBe(
      0,
    );
    expect(result.manifest.evidence.sourceSamples.natural).toEqual([]);
    expect(result.manifest.evidence.artifactLinks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "other",
          kind: "trajectory_bundle",
        }),
      ]),
    );
    const html = await readFile(result.analysis.indexHtmlPath, "utf8");
    expect(html).toContain("external_eval_trajectory_bundle");
    expect(html).toContain(
      'artifact.kind === "trajectory_bundle" && sourceKind === "training_collection_natural_trajectories"',
    );
    expect(html).toContain(
      'summary.schema === "eliza_test_trajectory_record" && sourceKind === "app_core_test_trajectory"',
    );
  });
});
