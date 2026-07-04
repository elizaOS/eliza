#!/usr/bin/env bun

/**
 * Production trajectory batch exporter for Feed training data.
 * It pages through Postgres trajectory rows, writes JSONL batches, and records cursor metadata for resumable exports.
 */

import {
  createWriteStream,
  existsSync,
  promises as fs,
  mkdirSync,
} from "node:fs";
import path from "node:path";
import { config as loadEnvFile } from "dotenv";
import { Client } from "pg";

type JsonPrimitive = boolean | number | string | null;
type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
type JsonObject = { [key: string]: JsonValue };

type CliOptions = {
  envFile: string;
  outputDir: string;
  batchSize: number;
  since: string | null;
  trainableOnly: boolean;
};

type ExportStatsRow = {
  total_rows: string;
  training_rows: string;
  judged_rows: string;
  min_created_at: Date | string | null;
  max_created_at: Date | string | null;
  max_id: string | null;
};

type LlmStatsRow = {
  total_llm_rows: string;
  distinct_trajectory_rows: string;
};

type DbTrajectoryRow = {
  id: string;
  trajectoryId: string;
  agentId: string;
  archetype: string | null;
  startTime: Date | string;
  endTime: Date | string;
  durationMs: number;
  windowId: string | null;
  windowHours: number;
  episodeId: string | null;
  scenarioId: string | null;
  batchId: string | null;
  stepsJson: string;
  rewardComponentsJson: string;
  metricsJson: string;
  metadataJson: string;
  totalReward: number | string;
  episodeLength: number;
  finalStatus: string;
  finalBalance: number | string | null;
  finalPnL: number | string | null;
  tradesExecuted: number | null;
  postsCreated: number | null;
  aiJudgeReward: number | string | null;
  aiJudgeReasoning: string | null;
  judgedAt: Date | string | null;
  isTrainingData: boolean;
  isEvaluation: boolean;
  usedInTraining: boolean;
  trainedInBatch: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};

type ExportedTrajectoryRow = {
  id: string;
  trajectory_id: string;
  agent_id: string;
  archetype: string | null;
  start_time: string;
  end_time: string;
  duration_ms: number;
  window_id: string | null;
  window_hours: number;
  episode_id: string | null;
  scenario_id: string | null;
  batch_id: string | null;
  steps: JsonValue[];
  reward_components: JsonValue;
  metrics: JsonValue;
  metadata: JsonValue;
  total_reward: number;
  episode_length: number;
  final_status: string;
  final_balance: number | null;
  final_pnl: number | null;
  trades_executed: number | null;
  posts_created: number | null;
  ai_judge_reward: number | null;
  ai_judge_reasoning: string | null;
  judged_at: string | null;
  is_training_data: boolean;
  is_evaluation: boolean;
  used_in_training: boolean;
  trained_in_batch: string | null;
  created_at: string;
  updated_at: string;
  has_steps: boolean;
  step_count: number;
  llm_call_count: number;
  steps_with_llm_calls: number;
  is_trainable: boolean;
};

type ExportManifest = {
  source: {
    env_file: string;
    batch_size: number;
    since: string | null;
    trainable_only: boolean;
    exported_at: string;
  };
  db_snapshot: {
    total_rows: number;
    training_rows: number;
    judged_rows: number;
    llm_call_log_rows: number;
    llm_call_log_distinct_trajectories: number;
    snapshot_max_id: string | null;
    earliest_created_at: string | null;
    latest_created_at: string | null;
  };
  exported: {
    total_rows: number;
    raw_chunk_count: number;
    rows_with_steps: number;
    rows_with_llm_calls: number;
    rows_with_steps_and_llm_calls: number;
    empty_step_rows: number;
    hf_all_rows: number;
    hf_trainable_rows: number;
  };
  output: {
    root: string;
    raw_dir: string;
    hf_all_path: string;
    hf_trainable_path: string;
  };
};

function printUsage(): void {
  console.log(`
Export production trajectories into a local cache and Hugging Face compatible JSONL.

Usage:
  bun run scripts/export-production-trajectories.ts [options]

Options:
  --env-file <path>     Env file with POSTGRES_URL (default: .env.production.local)
  --output-dir <path>   Output directory (default: training-data/production-trajectories/<timestamp>)
  --batch-size <n>      Rows per fetch batch (default: 5000)
  --since <iso>         Only export rows created at/after this ISO timestamp
  --trainable-only      Only write rows with steps and LLM calls
  -h, --help            Show this help
`);
}

function readArgValue(args: string[], name: string): string | null {
  const exactIndex = args.indexOf(name);
  if (exactIndex !== -1) {
    const value = args[exactIndex + 1];
    if (!value) {
      throw new Error(`Missing value after ${name}`);
    }
    return value.trim();
  }

  const prefixed = args.find((arg) => arg.startsWith(`${name}=`));
  if (!prefixed) {
    return null;
  }

  const value = prefixed.slice(name.length + 1).trim();
  if (!value) {
    throw new Error(`${name} cannot be empty`);
  }
  return value;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function timestampForPath(date: Date): string {
  return date.toISOString().replace(/[:]/g, "-").replace(/\..+$/, "Z");
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);

  if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
    printUsage();
    process.exit(0);
  }

  const now = new Date();
  const defaultOutputDir = path.join(
    "training-data",
    "production-trajectories",
    timestampForPath(now),
  );
  const batchSizeRaw = readArgValue(args, "--batch-size");
  const batchSize = batchSizeRaw ? Number(batchSizeRaw) : 5000;

  if (!Number.isFinite(batchSize) || batchSize <= 0) {
    throw new Error("--batch-size must be a positive number");
  }

  return {
    envFile: readArgValue(args, "--env-file") ?? ".env.production.local",
    outputDir: readArgValue(args, "--output-dir") ?? defaultOutputDir,
    batchSize: Math.floor(batchSize),
    since: readArgValue(args, "--since"),
    trainableOnly: hasFlag(args, "--trainable-only"),
  };
}

function requirePostgresUrl(envFile: string): string {
  const result = loadEnvFile({ path: envFile, override: true });
  if (result.error) {
    throw result.error;
  }

  const postgresUrl = process.env.POSTGRES_URL;
  if (!postgresUrl) {
    throw new Error(`POSTGRES_URL not found in ${envFile}`);
  }
  return postgresUrl;
}

function ensureDirectory(directoryPath: string): void {
  if (!existsSync(directoryPath)) {
    mkdirSync(directoryPath, { recursive: true });
  }
}

function normalizeTimestamp(value: Date | string | null): string | null {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return new Date(value).toISOString();
}

function normalizeNumber(value: number | string | null): number | null {
  if (value === null) {
    return null;
  }
  return typeof value === "number" ? value : Number(value);
}

function parseJsonValue(raw: string): JsonValue {
  return JSON.parse(raw) as JsonValue;
}

function toJsonArray(value: JsonValue): JsonValue[] {
  return Array.isArray(value) ? value : [];
}

function toJsonObject(value: JsonValue): JsonObject | null {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    return null;
  }
  return value as JsonObject;
}

function countLlmCalls(steps: JsonValue[]): {
  llmCallCount: number;
  stepsWithLlmCalls: number;
} {
  let llmCallCount = 0;
  let stepsWithLlmCalls = 0;

  for (const step of steps) {
    const stepObject = toJsonObject(step);
    if (!stepObject) {
      continue;
    }

    const llmCallsValue = stepObject.llmCalls ?? stepObject.llm_calls ?? [];
    const llmCalls = Array.isArray(llmCallsValue) ? llmCallsValue : [];
    if (llmCalls.length > 0) {
      stepsWithLlmCalls += 1;
      llmCallCount += llmCalls.length;
    }
  }

  return { llmCallCount, stepsWithLlmCalls };
}

function transformRow(row: DbTrajectoryRow): ExportedTrajectoryRow {
  const steps = toJsonArray(parseJsonValue(row.stepsJson));
  const rewardComponents = parseJsonValue(row.rewardComponentsJson);
  const metrics = parseJsonValue(row.metricsJson);
  const metadata = parseJsonValue(row.metadataJson);
  const { llmCallCount, stepsWithLlmCalls } = countLlmCalls(steps);
  const hasSteps = steps.length > 0;
  const isTrainable = hasSteps && llmCallCount > 0;

  return {
    id: row.id,
    trajectory_id: row.trajectoryId,
    agent_id: row.agentId,
    archetype: row.archetype,
    start_time: normalizeTimestamp(row.startTime) ?? "",
    end_time: normalizeTimestamp(row.endTime) ?? "",
    duration_ms: row.durationMs,
    window_id: row.windowId,
    window_hours: row.windowHours,
    episode_id: row.episodeId,
    scenario_id: row.scenarioId,
    batch_id: row.batchId,
    steps,
    reward_components: rewardComponents,
    metrics,
    metadata,
    total_reward: normalizeNumber(row.totalReward) ?? 0,
    episode_length: row.episodeLength,
    final_status: row.finalStatus,
    final_balance: normalizeNumber(row.finalBalance),
    final_pnl: normalizeNumber(row.finalPnL),
    trades_executed: row.tradesExecuted,
    posts_created: row.postsCreated,
    ai_judge_reward: normalizeNumber(row.aiJudgeReward),
    ai_judge_reasoning: row.aiJudgeReasoning,
    judged_at: normalizeTimestamp(row.judgedAt),
    is_training_data: row.isTrainingData,
    is_evaluation: row.isEvaluation,
    used_in_training: row.usedInTraining,
    trained_in_batch: row.trainedInBatch,
    created_at: normalizeTimestamp(row.createdAt) ?? "",
    updated_at: normalizeTimestamp(row.updatedAt) ?? "",
    has_steps: hasSteps,
    step_count: steps.length,
    llm_call_count: llmCallCount,
    steps_with_llm_calls: stepsWithLlmCalls,
    is_trainable: isTrainable,
  };
}

async function fetchStats(client: Client): Promise<{
  exportStats: ExportStatsRow;
  llmStats: LlmStatsRow;
}> {
  const exportStatsResult = await client.query<ExportStatsRow>(`
    SELECT
      COUNT(*)::text AS total_rows,
      COUNT(*) FILTER (WHERE "isTrainingData" = true)::text AS training_rows,
      COUNT(*) FILTER (WHERE "aiJudgeReward" IS NOT NULL)::text AS judged_rows,
      MAX(id::bigint)::text AS max_id,
      MIN("createdAt") AS min_created_at,
      MAX("createdAt") AS max_created_at
    FROM trajectories
  `);
  const llmStatsResult = await client.query<LlmStatsRow>(`
    SELECT
      COUNT(*)::text AS total_llm_rows,
      COUNT(DISTINCT "trajectoryId")::text AS distinct_trajectory_rows
    FROM llm_call_logs
  `);

  const exportStats = exportStatsResult.rows[0];
  const llmStats = llmStatsResult.rows[0];

  if (!exportStats || !llmStats) {
    throw new Error("Failed to fetch export statistics");
  }

  return { exportStats, llmStats };
}

async function main(): Promise<void> {
  const options = parseArgs();
  const postgresUrl = requirePostgresUrl(options.envFile);

  const outputRoot = path.resolve(options.outputDir);
  const rawDir = path.join(outputRoot, "raw");
  const hfAllDir = path.join(outputRoot, "hf", "all");
  const hfTrainableDir = path.join(outputRoot, "hf", "trainable");
  const manifestPath = path.join(outputRoot, "manifest.json");

  ensureDirectory(outputRoot);
  ensureDirectory(rawDir);
  ensureDirectory(hfAllDir);
  ensureDirectory(hfTrainableDir);

  const hfAllPath = path.join(hfAllDir, "train.jsonl");
  const hfTrainablePath = path.join(hfTrainableDir, "train.jsonl");

  const client = new Client({
    connectionString: postgresUrl,
    statement_timeout: 120000,
  });

  const hfAllWriter = createWriteStream(hfAllPath, { encoding: "utf8" });
  const hfTrainableWriter = createWriteStream(hfTrainablePath, {
    encoding: "utf8",
  });

  let rawChunkWriter = createWriteStream(
    path.join(rawDir, "chunk-00001.jsonl"),
    {
      encoding: "utf8",
    },
  );
  let rawChunkCount = 1;
  let rowsWrittenToCurrentChunk = 0;
  const rowsPerChunk = options.batchSize;

  let totalExported = 0;
  let rowsWithSteps = 0;
  let rowsWithLlmCalls = 0;
  let rowsWithStepsAndLlmCalls = 0;
  let emptyStepRows = 0;
  let hfAllRows = 0;
  let hfTrainableRows = 0;

  let lastSeenId = "0";

  try {
    await client.connect();
    const { exportStats, llmStats } = await fetchStats(client);
    const totalRows = Number(exportStats.total_rows);
    const snapshotMaxId = exportStats.max_id;
    const sinceTimestamp = options.since;

    if (!snapshotMaxId) {
      throw new Error("Could not determine snapshot max trajectory id");
    }

    console.log(
      `Exporting ${totalRows.toLocaleString()} trajectories from ${options.envFile} into ${outputRoot}`,
    );

    while (true) {
      const result = await client.query<DbTrajectoryRow>(
        `
          SELECT *
          FROM trajectories
          WHERE id::bigint > $1::bigint
            AND id::bigint <= $2::bigint
            AND ($3::timestamptz IS NULL OR "createdAt" >= $3::timestamptz)
          ORDER BY id::bigint ASC
          LIMIT $4
        `,
        [lastSeenId, snapshotMaxId, sinceTimestamp, options.batchSize],
      );

      if (result.rows.length === 0) {
        break;
      }

      for (const row of result.rows) {
        const exportedRow = transformRow(row);
        const serialized = JSON.stringify(exportedRow);

        if (!options.trainableOnly) {
          rawChunkWriter.write(`${serialized}\n`);
          hfAllWriter.write(`${serialized}\n`);
        }

        totalExported += 1;
        if (!options.trainableOnly) {
          hfAllRows += 1;
          rowsWrittenToCurrentChunk += 1;
        }

        if (exportedRow.has_steps) {
          rowsWithSteps += 1;
        } else {
          emptyStepRows += 1;
        }

        if (exportedRow.llm_call_count > 0) {
          rowsWithLlmCalls += 1;
        }

        if (exportedRow.is_trainable) {
          rowsWithStepsAndLlmCalls += 1;
          hfTrainableRows += 1;
          hfTrainableWriter.write(`${serialized}\n`);
        }

        if (
          !options.trainableOnly &&
          rowsWrittenToCurrentChunk >= rowsPerChunk
        ) {
          rawChunkWriter.end();
          rawChunkCount += 1;
          rowsWrittenToCurrentChunk = 0;
          const chunkName = `chunk-${String(rawChunkCount).padStart(5, "0")}.jsonl`;
          rawChunkWriter = createWriteStream(path.join(rawDir, chunkName), {
            encoding: "utf8",
          });
        }
      }

      const finalRow = result.rows[result.rows.length - 1];
      if (!finalRow) {
        throw new Error("Missing final row while advancing export cursor");
      }
      lastSeenId = finalRow.id;

      console.log(
        `Processed ${totalExported.toLocaleString()} / ${totalRows.toLocaleString()} trajectories`,
      );
    }

    if (!sinceTimestamp && totalExported !== totalRows) {
      throw new Error(
        `Export row mismatch: expected ${totalRows}, exported ${totalExported}`,
      );
    }

    rawChunkWriter.end();
    hfAllWriter.end();
    hfTrainableWriter.end();

    const manifest: ExportManifest = {
      source: {
        env_file: options.envFile,
        batch_size: options.batchSize,
        since: options.since,
        trainable_only: options.trainableOnly,
        exported_at: new Date().toISOString(),
      },
      db_snapshot: {
        total_rows: Number(exportStats.total_rows),
        training_rows: Number(exportStats.training_rows),
        judged_rows: Number(exportStats.judged_rows),
        llm_call_log_rows: Number(llmStats.total_llm_rows),
        llm_call_log_distinct_trajectories: Number(
          llmStats.distinct_trajectory_rows,
        ),
        snapshot_max_id: snapshotMaxId,
        earliest_created_at: normalizeTimestamp(exportStats.min_created_at),
        latest_created_at: normalizeTimestamp(exportStats.max_created_at),
      },
      exported: {
        total_rows: totalExported,
        raw_chunk_count:
          rowsWrittenToCurrentChunk === 0 ? rawChunkCount - 1 : rawChunkCount,
        rows_with_steps: rowsWithSteps,
        rows_with_llm_calls: rowsWithLlmCalls,
        rows_with_steps_and_llm_calls: rowsWithStepsAndLlmCalls,
        empty_step_rows: emptyStepRows,
        hf_all_rows: hfAllRows,
        hf_trainable_rows: hfTrainableRows,
      },
      output: {
        root: outputRoot,
        raw_dir: rawDir,
        hf_all_path: hfAllPath,
        hf_trainable_path: hfTrainablePath,
      },
    };

    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

    console.log("");
    console.log("Export complete.");
    console.log(`Manifest: ${manifestPath}`);
    console.log(`Rows exported: ${totalExported.toLocaleString()}`);
    console.log(`Rows with steps: ${rowsWithSteps.toLocaleString()}`);
    console.log(`Rows with LLM calls: ${rowsWithLlmCalls.toLocaleString()}`);
    console.log(`Trainable rows: ${hfTrainableRows.toLocaleString()}`);
  } finally {
    if (!hfAllWriter.destroyed) {
      hfAllWriter.end();
    }
    if (!hfTrainableWriter.destroyed) {
      hfTrainableWriter.end();
    }
    if (!rawChunkWriter.destroyed) {
      rawChunkWriter.end();
    }
    await client.end();
  }
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});
