/**
 * Scenario-trajectory → `eliza_native_v1` corpus bridge.
 *
 * `eliza-scenarios run <dir> --run-dir <runDir>` makes the runtime's
 * `JsonFileTrajectoryRecorder` write one `RecordedTrajectory` JSON file per
 * agent turn under `<runDir>/trajectories/<agentId>/<trajectoryId>.json`. That
 * shape (`stages[].model`) is a per-stage trace, not the canonical training
 * corpus record. The eliza-1 training prep script
 * (`packages/training/scripts/prepare_eliza1_trajectory_dataset.py`) ingests
 * `eliza_native_v1` model-boundary rows — one row per Vercel AI SDK
 * `generateText`/`streamText` call. This module converts the recorded stages
 * into those rows so the scenario corpus can feed model training.
 *
 * Output shape mirrors `packages/core/src/services/trajectory-types.ts`
 * (`ElizaNativeTrajectoryRow`) and the contract in
 * `packages/training/docs/dataset/CANONICAL_RECORD.md`. The privacy filter is
 * applied downstream by the training prep script on every input row.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { logger } from "@elizaos/core";
import type {
  RecordedModelCall,
  RecordedStage,
  RecordedTrajectory,
} from "@elizaos/core";

const NATIVE_FORMAT = "eliza_native_v1" as const;
const NATIVE_SCHEMA_VERSION = 1 as const;
const GENERATE_TEXT_BOUNDARY = "vercel_ai_sdk.generateText" as const;

export interface NativeBoundaryRow {
  format: typeof NATIVE_FORMAT;
  schemaVersion: typeof NATIVE_SCHEMA_VERSION;
  boundary: typeof GENERATE_TEXT_BOUNDARY;
  request: {
    system?: string;
    messages?: unknown[];
    prompt?: string;
    tools?: unknown;
    toolChoice?: unknown;
    providerOptions?: unknown;
    settings?: { temperature?: number; maxOutputTokens?: number; topP?: number };
  };
  response: {
    text: string;
    toolCalls?: Array<{ toolCallId?: string; toolName: string; input: unknown }>;
    finishReason?: string;
    usage?: {
      promptTokens?: number;
      completionTokens?: number;
      totalTokens?: number;
      cacheReadInputTokens?: number;
      cacheCreationInputTokens?: number;
    };
  };
  trajectoryId: string;
  agentId: string;
  scenarioId: string | null;
  batchId: string | null;
  stepId: string;
  callId: string;
  stepIndex: number;
  callIndex: number;
  timestamp: number;
  purpose?: string;
  stepType?: string;
  model?: string;
  modelVersion?: string;
  modelType?: string;
  provider?: string;
  metadata: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRecordedTrajectory(value: unknown): value is RecordedTrajectory {
  return (
    isRecord(value) &&
    typeof value.trajectoryId === "string" &&
    typeof value.agentId === "string" &&
    Array.isArray(value.stages)
  );
}

function stageKindToTaskType(kind: string | undefined, modelType: string | undefined): string {
  const tokens = `${kind ?? ""} ${modelType ?? ""}`
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
  if (tokens.includes("planner")) return "action_planner";
  if (tokens.includes("message_handler") || tokens.includes("should_respond")) {
    return "should_respond";
  }
  if (tokens.includes("evaluation") || tokens.includes("evaluator")) return "evaluation";
  if (tokens.includes("facts") || tokens.includes("relationships")) return "facts_and_relationships";
  return "response";
}

function normalizeToolCalls(
  toolCalls: RecordedModelCall["toolCalls"],
): Array<{ toolCallId?: string; toolName: string; input: unknown }> | undefined {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return undefined;
  const out: Array<{ toolCallId?: string; toolName: string; input: unknown }> = [];
  for (const call of toolCalls) {
    if (!isRecord(call)) continue;
    const name = typeof call.name === "string" ? call.name.trim() : "";
    if (!name) continue;
    const entry: { toolCallId?: string; toolName: string; input: unknown } = {
      toolName: name,
      input: isRecord(call.args) ? call.args : {},
    };
    if (typeof call.id === "string" && call.id.length > 0) entry.toolCallId = call.id;
    out.push(entry);
  }
  return out.length > 0 ? out : undefined;
}

function buildRequest(model: RecordedModelCall): NativeBoundaryRow["request"] {
  const request: NativeBoundaryRow["request"] = {};
  const messages = Array.isArray(model.messages) ? model.messages : undefined;
  const firstIsSystem =
    !!messages?.[0] &&
    isRecord(messages[0]) &&
    (messages[0] as { role?: unknown }).role === "system";
  if (messages && messages.length > 0) {
    request.messages = messages;
  } else if (typeof model.prompt === "string" && model.prompt.length > 0) {
    request.prompt = model.prompt;
  }
  // The recorder folds the system prompt into `messages[0]` when present; only
  // surface a separate `system` field if there isn't a leading system message.
  void firstIsSystem;
  if (model.tools !== undefined) request.tools = model.tools;
  if (model.toolChoice !== undefined) request.toolChoice = model.toolChoice;
  if (model.providerOptions !== undefined) request.providerOptions = model.providerOptions;
  return request;
}

function buildResponse(model: RecordedModelCall): NativeBoundaryRow["response"] {
  const response: NativeBoundaryRow["response"] = {
    text: typeof model.response === "string" ? model.response : "",
  };
  const toolCalls = normalizeToolCalls(model.toolCalls);
  if (toolCalls) response.toolCalls = toolCalls;
  if (typeof model.finishReason === "string") response.finishReason = model.finishReason;
  const usage = model.usage;
  if (usage) {
    const out: NonNullable<NativeBoundaryRow["response"]["usage"]> = {};
    if (typeof usage.promptTokens === "number") out.promptTokens = usage.promptTokens;
    if (typeof usage.completionTokens === "number") out.completionTokens = usage.completionTokens;
    if (typeof usage.totalTokens === "number") out.totalTokens = usage.totalTokens;
    if (typeof usage.cacheReadInputTokens === "number") {
      out.cacheReadInputTokens = usage.cacheReadInputTokens;
    }
    if (typeof usage.cacheCreationInputTokens === "number") {
      out.cacheCreationInputTokens = usage.cacheCreationInputTokens;
    }
    if (Object.keys(out).length > 0) response.usage = out;
  }
  return response;
}

/**
 * Convert one recorded scenario trajectory into the model-boundary rows that
 * `eliza_native_v1` defines — one row per `stages[].model` call. Stages without
 * a model call (tool execution, tool search, cache snapshots) are skipped:
 * they are not training-supervision boundaries.
 */
export function recordedTrajectoryToNativeRows(trajectory: RecordedTrajectory): NativeBoundaryRow[] {
  const rows: NativeBoundaryRow[] = [];
  const stages: RecordedStage[] = Array.isArray(trajectory.stages) ? trajectory.stages : [];
  for (const [stepIndex, stage] of stages.entries()) {
    const model = stage?.model;
    if (!model || typeof model !== "object") continue;
    const request = buildRequest(model);
    const response = buildResponse(model);
    const hasRequest =
      (Array.isArray(request.messages) && request.messages.length > 0) ||
      (typeof request.prompt === "string" && request.prompt.length > 0);
    const hasResponse =
      response.text.trim().length > 0 || (response.toolCalls?.length ?? 0) > 0;
    if (!hasRequest || !hasResponse) continue;

    const stepId =
      typeof stage.stageId === "string" && stage.stageId.length > 0
        ? stage.stageId
        : `${trajectory.trajectoryId}:stage:${stepIndex + 1}`;
    const callId = `${trajectory.trajectoryId}:${stepId}`;
    const scenarioId =
      typeof trajectory.scenarioId === "string" && trajectory.scenarioId.length > 0
        ? trajectory.scenarioId
        : null;
    const taskType = stageKindToTaskType(stage.kind, model.modelType);
    rows.push({
      format: NATIVE_FORMAT,
      schemaVersion: NATIVE_SCHEMA_VERSION,
      boundary: GENERATE_TEXT_BOUNDARY,
      request,
      response,
      trajectoryId: trajectory.trajectoryId,
      agentId: trajectory.agentId,
      scenarioId,
      batchId: null,
      stepId,
      callId,
      stepIndex,
      callIndex: 0,
      timestamp:
        typeof stage.startedAt === "number" && Number.isFinite(stage.startedAt)
          ? stage.startedAt
          : (trajectory.startedAt ?? 0),
      purpose: stage.kind,
      stepType: stage.kind,
      model: typeof model.modelName === "string" ? model.modelName : undefined,
      modelVersion: typeof model.modelName === "string" ? model.modelName : undefined,
      modelType: typeof model.modelType === "string" ? model.modelType : undefined,
      provider: typeof model.provider === "string" ? model.provider : undefined,
      metadata: {
        task_type: taskType,
        source_dataset: "scenario_trajectory_boundary",
        trajectory_id: trajectory.trajectoryId,
        step_id: stepId,
        call_id: callId,
        agent_id: trajectory.agentId,
        ...(typeof trajectory.runId === "string" && trajectory.runId.length > 0
          ? { source_run_id: trajectory.runId }
          : {}),
        ...(typeof trajectory.roomId === "string" && trajectory.roomId.length > 0
          ? { source_room_id: trajectory.roomId }
          : {}),
        ...(scenarioId ? { scenario_id: scenarioId } : {}),
        source_stage_kind: stage.kind,
        ...(typeof stage.iteration === "number" ? { source_stage_iteration: stage.iteration } : {}),
        source_model: typeof model.modelName === "string" ? model.modelName : undefined,
        source_model_type: typeof model.modelType === "string" ? model.modelType : undefined,
        source_provider: typeof model.provider === "string" ? model.provider : undefined,
        trajectory_status: trajectory.status,
        ...(typeof model.costUsd === "number" ? { source_cost_usd: model.costUsd } : {}),
      },
    });
  }
  return rows;
}

function collectTrajectoryFiles(rootDir: string): string[] {
  const out: string[] = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (
        entry.isFile() &&
        entry.name.endsWith(".json") &&
        !entry.name.endsWith(".tmp")
      ) {
        out.push(full);
      }
    }
  }
  return out.sort();
}

/**
 * Read every `RecordedTrajectory` JSON under `<runDir>/trajectories/` and write
 * the converted `eliza_native_v1` rows as JSONL to `outPath`. Returns the
 * number of rows written. Trajectory files that fail to parse or aren't
 * recorded-trajectory shaped are skipped with a warning — a malformed file in
 * the run directory should not block the rest of the export.
 */
export function exportScenarioNativeJsonl(runDir: string, outPath: string): number {
  const trajectoriesDir = path.join(runDir, "trajectories");
  const files = collectTrajectoryFiles(trajectoriesDir);
  const rows: NativeBoundaryRow[] = [];
  for (const file of files) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf-8"));
    } catch (err) {
      logger.warn(
        `[scenario-runner] skipping unparseable trajectory file ${file}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    if (!isRecordedTrajectory(parsed)) {
      logger.warn(
        `[scenario-runner] skipping non-trajectory JSON file ${file} (no trajectoryId/agentId/stages)`,
      );
      continue;
    }
    rows.push(...recordedTrajectoryToNativeRows(parsed));
  }
  mkdirSync(path.dirname(outPath), { recursive: true });
  const body = rows.length === 0 ? "" : `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
  writeFileSync(outPath, body, "utf-8");
  logger.info(
    `[scenario-runner] wrote ${rows.length} eliza_native_v1 row(s) from ${files.length} trajectory file(s) → ${outPath}`,
  );
  return rows.length;
}
