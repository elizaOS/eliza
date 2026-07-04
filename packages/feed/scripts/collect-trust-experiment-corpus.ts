#!/usr/bin/env bun

/**
 * Trust-experiment corpus collector for Feed trajectory outputs.
 * It runs matrix/export cycles until configured corpus targets are met and records the aggregate collection manifest.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

const FEED_REPO_ROOT = path.resolve(import.meta.dir, "..");

interface Options {
  runs: number;
  targetTrajectories: number;
  targetRankingGroups: number;
  targetRankingRows: number;
  agents: number;
  npcs: number;
  archetypes: number;
  modelSizes: string;
  worldTicks: number;
  agentTicks: number;
  initialGroupChatsMin: number;
  initialGroupChatsMax: number;
  parallel: number;
  delayMs: number;
  matrixOutputDir: string;
  exportOutputDir: string;
  collectionOutputPath: string;
  runtimeBaseUrl?: string;
  runtimeModel?: string;
  runtimeModelVersion?: string;
  fastMode: boolean;
  seed: number;
}

interface RunRecord {
  runIndex: number;
  experimentRunId: string;
  matrixDir: string;
  exportDir: string;
  trajectoryCount: number;
  matchedAgentCount: number;
  warning: string | null;
}

interface CorpusMetrics {
  validTrajectories: number;
  rankingGroups: number;
  rankingRows: number;
  sftExamples: number;
  rawTrajectories: number;
}

function resolvePythonCommand(): string {
  const override = process.env.FEED_PYTHON_BIN?.trim();
  if (override) {
    return override;
  }
  return Bun.which("python") ? "python" : "python3";
}

function parseOptions(): Options {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      runs: { type: "string", default: "5" },
      "target-trajectories": { type: "string", default: "1000" },
      "target-ranking-groups": { type: "string", default: "0" },
      "target-ranking-rows": { type: "string", default: "0" },
      agents: { type: "string", default: "30" },
      npcs: { type: "string", default: "150" },
      archetypes: { type: "string", default: "30" },
      "model-sizes": {
        type: "string",
        default: "0.5b,1.5b,3b,7b,14b,30b",
      },
      "world-ticks": { type: "string", default: "3" },
      "agent-ticks": { type: "string", default: "4" },
      "initial-group-chats-min": { type: "string", default: "0" },
      "initial-group-chats-max": { type: "string", default: "6" },
      parallel: { type: "string", default: "15" },
      delay: { type: "string", default: "100" },
      "matrix-output": {
        type: "string",
        default: "training-data/trust-experiment-matrix",
      },
      "export-output": {
        type: "string",
        default: "training-data/trust-experiment-exports",
      },
      "collection-output": {
        type: "string",
        default:
          "training-data/trust-experiment-corpus/collection-summary.json",
      },
      "runtime-base-url": { type: "string" },
      "runtime-model": { type: "string" },
      "runtime-model-version": { type: "string" },
      "fast-mode": { type: "boolean", default: false },
      seed: { type: "string", default: "1337" },
    },
    strict: true,
    allowPositionals: false,
  });

  const parsePositiveInt = (
    value: string | undefined,
    fallback: number,
  ): number => {
    const parsed = Number.parseInt(value ?? "", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };

  const parseNonNegativeInt = (
    value: string | undefined,
    fallback: number,
  ): number => {
    const parsed = Number.parseInt(value ?? "", 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  };

  const normalize = (value: string | undefined): string | undefined => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
  };

  return {
    runs: parsePositiveInt(values.runs as string | undefined, 5),
    targetTrajectories: parsePositiveInt(
      values["target-trajectories"] as string | undefined,
      1000,
    ),
    targetRankingGroups: parseNonNegativeInt(
      values["target-ranking-groups"] as string | undefined,
      0,
    ),
    targetRankingRows: parseNonNegativeInt(
      values["target-ranking-rows"] as string | undefined,
      0,
    ),
    agents: parsePositiveInt(values.agents as string | undefined, 30),
    npcs: parsePositiveInt(values.npcs as string | undefined, 150),
    archetypes: parsePositiveInt(values.archetypes as string | undefined, 30),
    modelSizes: String(values["model-sizes"] ?? "0.5b,1.5b,3b,7b,14b,30b"),
    worldTicks: parseNonNegativeInt(
      values["world-ticks"] as string | undefined,
      3,
    ),
    agentTicks: parsePositiveInt(
      values["agent-ticks"] as string | undefined,
      4,
    ),
    initialGroupChatsMin: parseNonNegativeInt(
      values["initial-group-chats-min"] as string | undefined,
      0,
    ),
    initialGroupChatsMax: parseNonNegativeInt(
      values["initial-group-chats-max"] as string | undefined,
      6,
    ),
    parallel: parsePositiveInt(values.parallel as string | undefined, 15),
    delayMs: parseNonNegativeInt(values.delay as string | undefined, 100),
    matrixOutputDir: path.resolve(
      FEED_REPO_ROOT,
      String(
        values["matrix-output"] ?? "training-data/trust-experiment-matrix",
      ),
    ),
    exportOutputDir: path.resolve(
      FEED_REPO_ROOT,
      String(
        values["export-output"] ?? "training-data/trust-experiment-exports",
      ),
    ),
    collectionOutputPath: path.resolve(
      FEED_REPO_ROOT,
      String(
        values["collection-output"] ??
          "training-data/trust-experiment-corpus/collection-summary.json",
      ),
    ),
    runtimeBaseUrl: normalize(values["runtime-base-url"] as string | undefined),
    runtimeModel: normalize(values["runtime-model"] as string | undefined),
    runtimeModelVersion: normalize(
      values["runtime-model-version"] as string | undefined,
    ),
    fastMode: Boolean(values["fast-mode"]),
    seed: parseNonNegativeInt(values.seed as string | undefined, 1337),
  };
}

async function runCommand(
  command: string[],
  cwd: string,
  envOverrides: Record<string, string> = {},
): Promise<void> {
  console.log(`[run] cwd=${cwd} :: ${command.join(" ")}`);
  const proc = Bun.spawn(command, {
    cwd,
    env: {
      ...process.env,
      ...envOverrides,
    },
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`Command failed (${exitCode}): ${command.join(" ")}`);
  }
}

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(filePath, "utf-8")) as Record<
    string,
    unknown
  >;
}

async function resolveRunDirByExperimentId(
  outputRoot: string,
  experimentRunId: string,
): Promise<string> {
  const dirs = Array.from(
    new Bun.Glob("*/manifest.json").scanSync(outputRoot),
  ).map((relativePath) => path.join(outputRoot, relativePath));
  for (const manifestPath of dirs.sort().reverse()) {
    const payload = await readJson(manifestPath);
    if (
      payload.experimentRunId === experimentRunId ||
      payload.sourceExperimentRunId === experimentRunId ||
      payload.batchId === experimentRunId ||
      payload.sourceBatchId === experimentRunId
    ) {
      return path.dirname(manifestPath);
    }
  }
  throw new Error(
    `Could not resolve manifest for experimentRunId=${experimentRunId} under ${outputRoot}`,
  );
}

async function summarizeCorpusMetrics(
  sourceDir: string,
  summaryRoot: string,
): Promise<CorpusMetrics | null> {
  const workDir = path.join(summaryRoot, "__corpus_metrics__", `${Date.now()}`);
  const pythonBin = resolvePythonCommand();
  await mkdir(workDir, { recursive: true });

  try {
    await runCommand(
      [
        pythonBin,
        "packages/training/python/scripts/hf/trajectories_to_hf_dataset.py",
        "--source-dir",
        sourceDir,
        "--output",
        workDir,
        "--format",
        "all",
      ],
      FEED_REPO_ROOT,
    );

    const summary = await readJson(path.join(workDir, "export_summary.json"));
    const counts = (summary.counts ?? {}) as Record<string, unknown>;
    return {
      validTrajectories: Number(counts.raw ?? 0),
      rankingGroups: Number(counts.rankings ?? 0),
      rankingRows: Number(counts.ranking_rows ?? 0),
      sftExamples: Number(counts.sft ?? 0),
      rawTrajectories: Number(counts.raw ?? 0),
    };
  } catch (error) {
    console.warn(
      `Failed to summarize corpus metrics for ${sourceDir}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const options = parseOptions();
  await mkdir(path.dirname(options.collectionOutputPath), { recursive: true });

  const runRecords: RunRecord[] = [];
  let totalTrajectories = 0;
  let latestCorpusMetrics: CorpusMetrics | null = null;
  const fastModeEnv = options.fastMode
    ? {
        FEED_TRUST_CORPUS_FAST_MODE: "true",
        FEED_SKIP_ALPHA_GROUP_INVITES: "true",
        FEED_SKIP_NPC_GROUP_DYNAMICS: "true",
        FEED_DISABLE_REDIS: "1",
      }
    : {};

  for (let index = 0; index < options.runs; index++) {
    const reachedTrajectoryTarget =
      options.targetTrajectories > 0 &&
      totalTrajectories >= options.targetTrajectories;
    const reachedGroupTarget =
      options.targetRankingGroups > 0 &&
      (latestCorpusMetrics?.rankingGroups ?? 0) >= options.targetRankingGroups;
    const reachedRowTarget =
      options.targetRankingRows > 0 &&
      (latestCorpusMetrics?.rankingRows ?? 0) >= options.targetRankingRows;

    if (reachedTrajectoryTarget || reachedGroupTarget || reachedRowTarget) {
      break;
    }

    const experimentRunId = `trust-corpus-${Date.now()}-${index + 1}`;
    const seed = options.seed + index;
    const matrixCommand = [
      "bun",
      "run",
      "scripts/run-trust-experiment-matrix.ts",
      "--run",
      "--run-id",
      experimentRunId,
      "--seed",
      String(seed),
      "--agents",
      String(options.agents),
      "--npcs",
      String(options.npcs),
      "--archetypes",
      String(options.archetypes),
      "--model-sizes",
      options.modelSizes,
      "--world-ticks",
      String(options.worldTicks),
      "--agent-ticks",
      String(options.agentTicks),
      "--initial-group-chats-min",
      String(options.initialGroupChatsMin),
      "--initial-group-chats-max",
      String(options.initialGroupChatsMax),
      "--parallel",
      String(options.parallel),
      "--delay",
      String(options.delayMs),
      "--output",
      options.matrixOutputDir,
    ];

    if (options.runtimeBaseUrl) {
      matrixCommand.push("--runtime-base-url", options.runtimeBaseUrl);
    }
    if (options.runtimeModel) {
      matrixCommand.push("--runtime-model", options.runtimeModel);
    }
    if (options.runtimeModelVersion) {
      matrixCommand.push(
        "--runtime-model-version",
        options.runtimeModelVersion,
      );
    }

    await runCommand(matrixCommand, FEED_REPO_ROOT, fastModeEnv);
    const matrixDir = await resolveRunDirByExperimentId(
      options.matrixOutputDir,
      experimentRunId,
    );
    const manifestPath = path.join(matrixDir, "manifest.json");

    await runCommand(
      [
        "bun",
        "run",
        "scripts/export-trust-experiment-trajectories.ts",
        "--manifest",
        manifestPath,
        "--output",
        options.exportOutputDir,
      ],
      FEED_REPO_ROOT,
      fastModeEnv,
    );

    const exportDir = await resolveRunDirByExperimentId(
      options.exportOutputDir,
      experimentRunId,
    );
    const exportManifest = await readJson(
      path.join(exportDir, "manifest.json"),
    );
    const trajectoryCount = Number(exportManifest.trajectoryCount ?? 0);
    totalTrajectories += trajectoryCount;
    latestCorpusMetrics = await summarizeCorpusMetrics(
      options.exportOutputDir,
      path.dirname(options.collectionOutputPath),
    );

    runRecords.push({
      runIndex: index + 1,
      experimentRunId,
      matrixDir,
      exportDir,
      trajectoryCount,
      matchedAgentCount: Number(exportManifest.matchedAgentCount ?? 0),
      warning:
        typeof exportManifest.warning === "string"
          ? exportManifest.warning
          : null,
    });

    console.log(
      `Collected run ${index + 1}: trajectories=${trajectoryCount} total=${totalTrajectories}`,
    );
    if (latestCorpusMetrics) {
      console.log(
        `Corpus metrics: valid=${latestCorpusMetrics.validTrajectories} ranking_groups=${latestCorpusMetrics.rankingGroups} ranking_rows=${latestCorpusMetrics.rankingRows}`,
      );
    }
  }

  await writeFile(
    options.collectionOutputPath,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        targetTrajectories: options.targetTrajectories,
        targetRankingGroups: options.targetRankingGroups,
        targetRankingRows: options.targetRankingRows,
        totalTrajectories,
        corpusMetrics: latestCorpusMetrics,
        completedRuns: runRecords.length,
        runs: runRecords,
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );

  console.log(`Saved collection summary to ${options.collectionOutputPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
