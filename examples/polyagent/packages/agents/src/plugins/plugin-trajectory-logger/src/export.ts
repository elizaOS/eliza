/**
 * Export Trajectories to Hugging Face Datasets
 *
 * Prepares trajectory data for RLAIF training pipelines.
 * Exports to HuggingFace Hub for easy access in training scripts.
 *
 * NOTE: Requires trajectory schema that's not yet in main schema
 */

import {
  and,
  db,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  lte,
  sql,
  trajectories,
} from "@babylon/db";
import type { JsonValue } from "../../../types/common";

/**
 * Fisher-Yates shuffle algorithm
 */
function shuffleArray<T>(array: T[]): T[] {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

import type { Trajectory } from "./types";

export interface ExportOptions {
  // Dataset configuration
  datasetName: string; // e.g., 'Polyagent/babylon-agent-trajectories'
  huggingFaceToken?: string;

  // Data filtering
  startDate?: Date;
  endDate?: Date;
  agentIds?: string[];
  scenarioIds?: string[];
  minReward?: number;
  maxReward?: number;
  includeJudged?: boolean; // Only include trajectories with AI judge scores

  // Limits
  maxTrajectories?: number;

  // Format
  format?: "jsonl" | "parquet" | "arrow";
  splitRatio?: { train: number; validation: number; test: number };
}

export interface ExportResult {
  success: boolean;
  trajectoriesExported: number;
  datasetUrl?: string;
  error?: string;
}

/**
 * Export trajectories to Hugging Face Dataset
 */
export async function exportToHuggingFace(
  options: ExportOptions,
): Promise<ExportResult> {
  // Build where conditions
  const conditions = buildWhereConditions(options);

  // Fetch trajectories using Drizzle
  const result = await db
    .select({
      trajectoryId: trajectories.trajectoryId,
      agentId: trajectories.agentId,
      episodeId: trajectories.episodeId,
      scenarioId: trajectories.scenarioId,
      startTime: trajectories.startTime,
      durationMs: trajectories.durationMs,
      stepsJson: trajectories.stepsJson,
      metricsJson: trajectories.metricsJson,
      metadataJson: trajectories.metadataJson,
      totalReward: trajectories.totalReward,
      finalStatus: trajectories.finalStatus,
      finalPnL: trajectories.finalPnL,
      aiJudgeReward: trajectories.aiJudgeReward,
      aiJudgeReasoning: trajectories.aiJudgeReasoning,
    })
    .from(trajectories)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(trajectories.startTime))
    .limit(options.maxTrajectories || 10000);

  console.log(`Exporting ${result.length} trajectories...`);

  // Transform to training format
  const dataset = result.map((traj) => transformForTraining(traj));

  // Split into train/validation/test
  const splits = splitDataset(dataset, options.splitRatio);

  // Export based on format
  if (options.format === "parquet" || options.format === "arrow") {
    return await exportToParquet<TrainingTrajectory>(splits, options);
  } else {
    return await exportToJSONL<TrainingTrajectory>(splits, options);
  }
}

/**
 * Transform trajectory to training format
 */
interface TrajectoryRecord {
  trajectoryId: string;
  agentId: string;
  episodeId: string | null;
  scenarioId: string | null;
  startTime: Date;
  durationMs: number;
  stepsJson: string;
  metricsJson: string;
  metadataJson: string;
  totalReward: number;
  finalStatus: string;
  finalPnL: number | null;
  aiJudgeReward: number | null;
  aiJudgeReasoning: string | null;
}

interface TrajectoryStep {
  stepNumber: number;
  timestamp: number;
  environmentState: Record<string, JsonValue>;
  observation: Record<string, JsonValue>;
  llmCalls: Array<{
    model: string;
    systemPrompt: string;
    userPrompt: string;
    response: string;
    reasoning?: string;
    temperature: number;
    purpose: string;
  }>;
  action: {
    actionType: string;
    parameters: Record<string, JsonValue>;
    success: boolean;
    result?: Record<string, JsonValue>;
    error?: string;
  };
  reward: number;
  reasoning?: string;
}

interface TrainingTrajectory {
  trajectory_id: string;
  agent_id: string;
  episode_id: string | null;
  scenario_id: string | null;
  start_time: string;
  duration_ms: number;
  steps: Array<{
    step_number: number;
    timestamp: number;
    environment_state: Record<string, JsonValue>;
    observation: Record<string, JsonValue>;
    llm_calls: Array<{
      model: string;
      system_prompt: string;
      user_prompt: string;
      response: string;
      reasoning: string | null;
      temperature: number;
      purpose: string;
    }>;
    action: {
      type: string;
      parameters: Record<string, JsonValue>;
      success: boolean;
      result: Record<string, JsonValue> | null;
      error: string | null;
    };
    reward: number;
    reasoning: string | null;
  }>;
  total_reward: number;
  final_status: string;
  final_pnl: number | null;
  ai_judge_reward: number | null;
  ai_judge_reasoning: string | null;
  metrics: {
    episode_length: number;
    trades_executed: number | null;
    posts_created: number | null;
    messages_handled: number | null;
    error_count: number | null;
  };
  metadata: Record<string, JsonValue>;
}

function transformForTraining(traj: TrajectoryRecord): TrainingTrajectory {
  const steps = JSON.parse(traj.stepsJson) as TrajectoryStep[];
  const metrics = JSON.parse(traj.metricsJson) as Record<string, JsonValue>;
  const metadata = JSON.parse(traj.metadataJson) as Record<string, JsonValue>;

  return {
    // Identifiers
    trajectory_id: traj.trajectoryId,
    agent_id: traj.agentId,
    episode_id: traj.episodeId,
    scenario_id: traj.scenarioId,

    // Timing
    start_time: traj.startTime.toISOString(),
    duration_ms: traj.durationMs,

    // Steps (full trajectory)
    steps: steps.map((step: TrajectoryStep) => ({
      step_number: step.stepNumber,
      timestamp: step.timestamp,

      // Environment
      environment_state: step.environmentState,
      observation: step.observation,

      // Agent cognition
      llm_calls: step.llmCalls.map((call) => ({
        model: call.model,
        system_prompt: call.systemPrompt,
        user_prompt: call.userPrompt,
        response: call.response,
        reasoning: call.reasoning ?? null,
        temperature: call.temperature,
        purpose: call.purpose,
      })),

      // Action
      action: {
        type: step.action.actionType,
        parameters: step.action.parameters,
        success: step.action.success,
        result: step.action.result ?? null,
        error: step.action.error ?? null,
      },

      // Feedback
      reward: step.reward,
      reasoning: step.reasoning ?? null,
    })),

    // Outcomes
    total_reward: traj.totalReward,
    final_status: traj.finalStatus,
    final_pnl: traj.finalPnL,

    // AI Judge scores
    ai_judge_reward: traj.aiJudgeReward,
    ai_judge_reasoning: traj.aiJudgeReasoning,

    // Metrics
    metrics: {
      episode_length:
        typeof metrics.episodeLength === "number" ? metrics.episodeLength : 0,
      trades_executed:
        typeof metrics.tradesExecuted === "number"
          ? metrics.tradesExecuted
          : null,
      posts_created:
        typeof metrics.postsCreated === "number" ? metrics.postsCreated : null,
      messages_handled:
        typeof metrics.messagesHandled === "number"
          ? metrics.messagesHandled
          : null,
      error_count:
        typeof metrics.errorCount === "number" ? metrics.errorCount : null,
    },

    // Metadata
    metadata,
  };
}

/**
 * Split dataset into train/val/test
 */
function splitDataset<T>(
  data: T[],
  ratio?: { train: number; validation: number; test: number },
): { train: T[]; validation: T[]; test: T[] } {
  const defaultRatio = { train: 0.8, validation: 0.1, test: 0.1 };
  const { train, validation, test: testRatio } = ratio || defaultRatio;

  // Shuffle data
  const shuffled = shuffleArray(data);

  const trainSize = Math.floor(shuffled.length * train);
  const valSize = Math.floor(shuffled.length * validation);

  return {
    train: shuffled.slice(0, trainSize),
    validation: shuffled.slice(trainSize, trainSize + valSize),
    test: shuffled.slice(trainSize + valSize),
  };

  // Suppress unused variable warning
  void testRatio;
}

/**
 * Export to JSONL format
 */
async function exportToJSONL<T extends object>(
  splits: { train: T[]; validation: T[]; test: T[] },
  options: ExportOptions,
): Promise<ExportResult> {
  // Check if we're in a Node.js environment with file system access
  if (typeof process === "undefined" || typeof process.cwd !== "function") {
    throw new Error(
      "exportToJSONL requires Node.js environment with file system access. Not available in edge runtime.",
    );
  }

  const fs = await import("node:fs/promises");
  const path = await import("node:path");

  // Create export directory
  const exportDir = path.resolve(process.cwd(), "exports", "trajectories");
  await fs.mkdir(exportDir, { recursive: true });

  // Write splits
  for (const [splitName, data] of Object.entries(splits)) {
    if (data.length === 0) continue;

    const filePath = path.join(exportDir, `${splitName}.jsonl`);
    const lines = data.map((item: T) => JSON.stringify(item)).join("\n");
    await fs.writeFile(filePath, lines, "utf-8");

    console.log(`Exported ${data.length} trajectories to ${filePath}`);
  }

  // If HuggingFace token provided, upload
  if (options.huggingFaceToken) {
    await uploadToHuggingFaceHub(exportDir, options);
  }

  return {
    success: true,
    trajectoriesExported:
      splits.train.length + splits.validation.length + splits.test.length,
    datasetUrl: options.huggingFaceToken
      ? `https://huggingface.co/datasets/${options.datasetName}`
      : undefined,
  };
}

/**
 * Export to Parquet format (more efficient for large datasets)
 */
async function exportToParquet<T extends object>(
  splits: { train: T[]; validation: T[]; test: T[] },
  options: ExportOptions,
): Promise<ExportResult> {
  // This would require Apache Arrow/Parquet libraries
  // For now, fallback to JSONL
  console.warn("Parquet export not yet implemented, falling back to JSONL");
  return exportToJSONL(splits, options);
}

/**
 * Upload to Hugging Face Hub
 */
async function uploadToHuggingFaceHub(
  exportDir: string,
  options: ExportOptions,
): Promise<void> {
  if (!options.huggingFaceToken) {
    throw new Error("HuggingFace token is required for upload");
  }

  // Try using child_process to call huggingface-cli (most reliable method)
  const { exec } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execAsync = promisify(exec);

  // Set token as environment variable for huggingface-cli
  process.env.HUGGINGFACE_HUB_TOKEN = options.huggingFaceToken;

  console.log("Uploading to Hugging Face Hub...");
  console.log(`Dataset: ${options.datasetName}`);

  await execAsync(
    `huggingface-cli upload ${options.datasetName} ${exportDir} --repo-type dataset`,
  );
  console.log("✅ Successfully uploaded via huggingface-cli");
}

/**
 * Export trajectories grouped by scenario (for GRPO training)
 */
export async function exportGroupedByScenario(
  options: Omit<ExportOptions, "format">,
): Promise<ExportResult> {
  // Check if we're in a Node.js environment with file system access
  if (typeof process === "undefined" || typeof process.cwd !== "function") {
    throw new Error(
      "exportGroupedByScenario requires Node.js environment with file system access. Not available in edge runtime.",
    );
  }

  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const exportDir = path.resolve(process.cwd(), "exports", "scenarios");
  await fs.mkdir(exportDir, { recursive: true });

  // Build conditions
  const baseConditions = buildWhereConditions(options);
  baseConditions.push(isNotNull(trajectories.scenarioId));

  // Get distinct scenario IDs
  const scenarioResults = await db
    .selectDistinct({ scenarioId: trajectories.scenarioId })
    .from(trajectories)
    .where(baseConditions.length > 0 ? and(...baseConditions) : undefined);

  let totalExported = 0;

  for (const { scenarioId } of scenarioResults) {
    if (!scenarioId) continue;

    // Get all trajectories for this scenario
    const trajResults = await db
      .select()
      .from(trajectories)
      .where(and(eq(trajectories.scenarioId, scenarioId), ...baseConditions))
      .orderBy(trajectories.startTime);

    if (trajResults.length < 2) continue; // Need at least 2 for comparison

    const transformed = trajResults.map((traj) =>
      transformForTraining({
        trajectoryId: traj.trajectoryId,
        agentId: traj.agentId,
        episodeId: traj.episodeId,
        scenarioId: traj.scenarioId,
        startTime: traj.startTime,
        durationMs: traj.durationMs,
        stepsJson: traj.stepsJson,
        metricsJson: traj.metricsJson,
        metadataJson: traj.metadataJson,
        totalReward: traj.totalReward,
        finalStatus: traj.finalStatus,
        finalPnL: traj.finalPnL,
        aiJudgeReward: traj.aiJudgeReward,
        aiJudgeReasoning: traj.aiJudgeReasoning,
      }),
    );

    const filePath = path.join(exportDir, `scenario-${scenarioId}.jsonl`);
    const lines = transformed.map((item) => JSON.stringify(item)).join("\n");
    await fs.writeFile(filePath, lines, "utf-8");

    console.log(
      `Exported ${trajResults.length} trajectories for scenario ${scenarioId}`,
    );
    totalExported += trajResults.length;
  }

  return {
    success: true,
    trajectoriesExported: totalExported,
  };
}

/**
 * Export to OpenPipe ART format
 * Matches the format expected by ART/GRPO training
 */
export async function exportForOpenPipeART(
  options: ExportOptions,
): Promise<ExportResult> {
  // Check if we're in a Node.js environment with file system access
  if (typeof process === "undefined" || typeof process.cwd !== "function") {
    throw new Error(
      "exportForOpenPipeART requires Node.js environment with file system access. Not available in edge runtime.",
    );
  }

  const { toARTTrajectory } = await import("./art-format");

  const conditions = buildWhereConditions(options);

  const trajResults = await db
    .select()
    .from(trajectories)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .limit(options.maxTrajectories || 10000)
    .orderBy(trajectories.startTime);

  const artFormat = trajResults.map((traj) => {
    const steps = JSON.parse(traj.stepsJson);
    const metrics = JSON.parse(traj.metricsJson);
    const metadata = JSON.parse(traj.metadataJson);

    const trajectory = {
      trajectoryId: traj.trajectoryId,
      agentId:
        traj.agentId as `${string}-${string}-${string}-${string}-${string}`,
      scenarioId: traj.scenarioId,
      groupIndex: traj.batchId
        ? parseInt(traj.batchId.split("-").pop() || "0", 10)
        : undefined,
      startTime: traj.startTime.getTime(),
      endTime: traj.endTime.getTime(),
      durationMs: traj.durationMs,
      steps,
      totalReward: traj.totalReward,
      rewardComponents: JSON.parse(traj.rewardComponentsJson),
      metrics,
      metadata,
    };

    return toARTTrajectory(trajectory as Trajectory);
  });

  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const exportDir = path.resolve(process.cwd(), "exports", "openpipe-art");
  await fs.mkdir(exportDir, { recursive: true });

  const filePath = path.join(exportDir, "trajectories.jsonl");
  const lines = artFormat.map((item) => JSON.stringify(item)).join("\n");
  await fs.writeFile(filePath, lines, "utf-8");

  console.log(
    `Exported ${artFormat.length} trajectories in OpenPipe ART format`,
  );

  return {
    success: true,
    trajectoriesExported: artFormat.length,
  };
}

/**
 * Export trajectories grouped by scenario for GRPO
 * This creates the structure RULER needs for comparative ranking
 */
export async function exportGroupedForGRPO(
  options: ExportOptions,
): Promise<ExportResult> {
  // Check if we're in a Node.js environment with file system access
  if (typeof process === "undefined" || typeof process.cwd !== "function") {
    throw new Error(
      "exportGroupedForGRPO requires Node.js environment with file system access. Not available in edge runtime.",
    );
  }

  const { groupTrajectories, toARTTrajectory } = await import("./art-format");

  // CRITICAL: Enforce maxTrajectories limit to prevent 200GB disk usage
  const MAX_TRAJECTORIES = options.maxTrajectories || 2000; // Default hard limit
  const MAX_TRAJECTORIES_PER_SCENARIO = 50; // Limit per scenario to prevent huge files

  const baseConditions = buildWhereConditions(options);

  // Get scenarios with counts using raw SQL for groupBy
  const scenarioCountsRaw = await db.execute(sql`
      SELECT "scenarioId", COUNT(*) as count 
      FROM trajectories 
      WHERE "scenarioId" IS NOT NULL AND "isTrainingData" = true
      GROUP BY "scenarioId"
    `);

  // Type for raw SQL scenario count row with index signature for compatibility
  interface ScenarioCountRow {
    scenarioId: string | null;
    count: string | number;
    [key: string]: string | number | null;
  }

  // Type guard for scenario count row
  function isScenarioCountRow(row: object): row is ScenarioCountRow {
    return "scenarioId" in row && "count" in row;
  }

  // Validate and type the raw SQL result
  if (!Array.isArray(scenarioCountsRaw)) {
    throw new Error("Invalid scenario counts result from database");
  }
  const scenarioCounts: Array<{ scenarioId: string; count: string }> = (
    scenarioCountsRaw as object[]
  )
    .filter(
      (row): row is ScenarioCountRow =>
        row !== null && typeof row === "object" && isScenarioCountRow(row),
    )
    .map((row) => ({
      scenarioId: String(row.scenarioId),
      count: String(row.count),
    }));

  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const exportDir = path.resolve(process.cwd(), "exports", "grpo-groups");
  await fs.mkdir(exportDir, { recursive: true });

  let totalExported = 0;
  let remainingQuota = MAX_TRAJECTORIES;

  for (const { scenarioId, count } of scenarioCounts) {
    const countNum = parseInt(count, 10);
    if (!scenarioId || countNum < 2) continue; // Need at least 2 for comparison
    if (remainingQuota <= 0) break; // Stop if we've hit the limit

    // Calculate how many trajectories we can take for this scenario
    const takeForScenario = Math.min(
      MAX_TRAJECTORIES_PER_SCENARIO,
      remainingQuota,
    );

    const trajResults = await db
      .select()
      .from(trajectories)
      .where(and(eq(trajectories.scenarioId, scenarioId), ...baseConditions))
      .orderBy(trajectories.startTime)
      .limit(takeForScenario);

    // Convert to trajectory objects
    const trajObjects = trajResults.map((traj, index) => ({
      trajectoryId: traj.trajectoryId,
      agentId:
        traj.agentId as `${string}-${string}-${string}-${string}-${string}`,
      scenarioId: traj.scenarioId,
      groupIndex: index,
      startTime: traj.startTime.getTime(),
      endTime: traj.endTime.getTime(),
      durationMs: traj.durationMs,
      steps: JSON.parse(traj.stepsJson),
      totalReward: traj.totalReward,
      rewardComponents: JSON.parse(traj.rewardComponentsJson),
      metrics: JSON.parse(traj.metricsJson),
      metadata: JSON.parse(traj.metadataJson),
    }));

    const groups = groupTrajectories(trajObjects as Trajectory[]);

    for (const group of groups) {
      // Skip if we've hit the global limit
      if (remainingQuota <= 0) break;

      const artFormat = {
        groupId: group.groupId,
        scenarioId: group.scenarioId,
        sharedPrefix: group.sharedPrefix || [],
        trajectories: group.trajectories.map((t) => toARTTrajectory(t)),
        createdAt: group.createdAt,
      };

      const filePath = path.join(exportDir, `group-${scenarioId}.jsonl`);
      await fs.writeFile(filePath, `${JSON.stringify(artFormat)}\n`, "utf-8");

      const exported = group.trajectories.length;
      totalExported += exported;
      remainingQuota -= exported;
    }
  }

  console.log(
    `Exported ${totalExported} trajectories in ${scenarioCounts.length} GRPO groups (limit: ${MAX_TRAJECTORIES})`,
  );

  return {
    success: true,
    trajectoriesExported: totalExported,
  };
}

/**
 * Build Drizzle where conditions from export options
 */
function buildWhereConditions(options: ExportOptions) {
  const conditions = [eq(trajectories.isTrainingData, true)];

  if (options.startDate) {
    conditions.push(gte(trajectories.startTime, options.startDate));
  }
  if (options.endDate) {
    conditions.push(lte(trajectories.startTime, options.endDate));
  }
  if (options.agentIds && options.agentIds.length > 0) {
    conditions.push(inArray(trajectories.agentId, options.agentIds));
  }
  if (options.scenarioIds && options.scenarioIds.length > 0) {
    conditions.push(inArray(trajectories.scenarioId, options.scenarioIds));
  }
  if (options.minReward !== undefined) {
    conditions.push(gte(trajectories.totalReward, options.minReward));
  }
  if (options.maxReward !== undefined) {
    conditions.push(lte(trajectories.totalReward, options.maxReward));
  }
  if (options.includeJudged) {
    conditions.push(isNotNull(trajectories.aiJudgeReward));
  }

  return conditions;
}
