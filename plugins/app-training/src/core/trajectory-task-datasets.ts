import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  Trajectory,
  TrajectoryLlmCall,
} from "@elizaos/agent/types/trajectory";
import {
  buildElizaNativeTrajectoryRows,
  ELIZA_NATIVE_TRAJECTORY_FORMAT,
  type ElizaNativeTrajectoryRow,
} from "@elizaos/core";
import {
  extractElizaNativeRowsFromExportText,
  extractTrajectoriesFromExportText,
  listTrajectoryCallEntries,
} from "./trajectory-consumer.js";

export type ElizaNativeTrainingExample = ElizaNativeTrajectoryRow;

export type TrajectoryTrainingTask =
  | "should_respond"
  | "context_routing"
  | "action_planner"
  | "response"
  | "media_description";

export interface TrajectoryTaskDatasetPaths {
  shouldRespondPath: string;
  contextRoutingPath: string;
  actionPlannerPath: string;
  responsePath: string;
  mediaDescriptionPath: string;
  summaryPath: string;
}

export interface TrajectoryTaskDatasetExport {
  counts: Record<TrajectoryTrainingTask, number>;
  paths: TrajectoryTaskDatasetPaths;
  examples: Record<TrajectoryTrainingTask, ElizaNativeTrainingExample[]>;
  summary: TrajectoryTaskDatasetSummary;
}

export interface TrajectoryTaskDatasetTaskSummary {
  exampleCount: number;
  sourceCallCount: number;
  sourceTrajectoryCount: number;
}

export interface TrajectoryTaskDatasetSummary {
  generatedAt: string;
  trajectoryCount: number;
  llmCallCount: number;
  skippedNonNativeRows: number;
  warnings: string[];
  counts: Record<TrajectoryTrainingTask, number>;
  tasks: TrajectoryTrainingTask[];
  taskMetrics: Record<TrajectoryTrainingTask, TrajectoryTaskDatasetTaskSummary>;
}

type TrajectoryCallLike = TrajectoryLlmCall & {
  metadata?: Record<string, unknown>;
};

const TASK_FILE_NAMES: Record<TrajectoryTrainingTask, string> = {
  should_respond: "should_respond_trajectories.jsonl",
  context_routing: "context_routing_trajectories.jsonl",
  action_planner: "action_planner_trajectories.jsonl",
  response: "response_trajectories.jsonl",
  media_description: "media_description_trajectories.jsonl",
};

type TaskExampleMap = Record<TrajectoryTrainingTask, ElizaNativeTrainingExample[]>;
type TaskCountMap = Record<TrajectoryTrainingTask, number>;
type TaskTrajectoryIdMap = Record<TrajectoryTrainingTask, Set<string>>;

interface TrajectoryTaskExtractionResult {
  examples: TaskExampleMap;
  sourceCallCounts: TaskCountMap;
  sourceTrajectoryIds: TaskTrajectoryIdMap;
  llmCallCount: number;
  skippedNonNativeRows: number;
  warnings: string[];
}

function createEmptyExampleMap(): TaskExampleMap {
  return {
    should_respond: [],
    context_routing: [],
    action_planner: [],
    response: [],
    media_description: [],
  };
}

function createEmptyCountMap(): TaskCountMap {
  return {
    should_respond: 0,
    context_routing: 0,
    action_planner: 0,
    response: 0,
    media_description: 0,
  };
}

function createEmptyTrajectoryIdMap(): TaskTrajectoryIdMap {
  return {
    should_respond: new Set<string>(),
    context_routing: new Set<string>(),
    action_planner: new Set<string>(),
    response: new Set<string>(),
    media_description: new Set<string>(),
  };
}

function normalizeToken(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }

  return value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9:_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
}

function normalizeTrainingTask(value: unknown): TrajectoryTrainingTask | null {
  const normalized = normalizeToken(value);
  if (
    normalized === "should_respond" ||
    normalized === "context_routing" ||
    normalized === "action_planner" ||
    normalized === "response" ||
    normalized === "reply" ||
    normalized === "media_description"
  ) {
    return normalized === "reply" ? "response" : normalized;
  }
  return null;
}

function collectCallHints(call: TrajectoryCallLike): string[] {
  const metadata = call.metadata ?? {};
  const tags = Array.isArray(call.tags) ? call.tags : [];
  const values = [
    call.purpose,
    call.stepType,
    call.actionType,
    call.model,
    metadata.modelType,
    metadata.purpose,
    metadata.model_type,
    metadata.stepType,
    ...tags,
  ];

  return values
    .map(normalizeToken)
    .filter(
      (value, index, items) =>
        value.length > 0 && items.indexOf(value) === index,
    );
}

function hasContextRoutingFields(text: string): boolean {
  return (
    /(^|\n)primaryContext:/m.test(text) ||
    /(^|\n)secondaryContexts:/m.test(text) ||
    /<primaryContext>/i.test(text) ||
    /<secondaryContexts>/i.test(text)
  );
}

function hasMessageHandlerJsonFields(text: string): boolean {
  const parsed = parseJsonObject(text);
  if (!parsed) return false;
  const candidate = getMessageHandlerCandidate(parsed);
  return Boolean(candidate);
}

function looksLikePlannerCall(call: TrajectoryCallLike): boolean {
  const response = call.response ?? "";
  const prompt = `${call.systemPrompt ?? ""}\n${call.userPrompt ?? ""}`;

  return (
    /(^|\n)actions:/m.test(response) ||
    (/thought/i.test(response) && /text/i.test(response)) ||
    /available actions/i.test(prompt) ||
    /actionNames/i.test(prompt)
  );
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");
  if (!trimmed.startsWith("{")) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function getMessageHandlerCandidate(
  parsed: Record<string, unknown>,
): Record<string, unknown> | null {
  const nested = parsed.messageHandler;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    return nested as Record<string, unknown>;
  }
  if (
    typeof parsed.action === "string" &&
    typeof parsed.simple === "boolean" &&
    Array.isArray(parsed.contexts) &&
    typeof parsed.thought === "string"
  ) {
    return parsed;
  }
  return null;
}

function normalizeMessageHandlerJson(response: string): string | null {
  const parsed = parseJsonObject(response);
  if (!parsed) return null;
  const candidate = getMessageHandlerCandidate(parsed);
  if (!candidate) return null;

  const action = candidate.action;
  if (action !== "RESPOND" && action !== "IGNORE" && action !== "STOP") {
    return null;
  }

  const contexts = Array.isArray(candidate.contexts)
    ? candidate.contexts.filter(
        (context): context is string => typeof context === "string",
      )
    : [];
  const normalized = {
    messageHandler: {
      action,
      simple:
        typeof candidate.simple === "boolean"
          ? candidate.simple
          : action === "RESPOND" && contexts.length === 0,
      contexts,
      thought: typeof candidate.thought === "string" ? candidate.thought : "",
      reply: typeof candidate.reply === "string" ? candidate.reply : "",
    },
  };
  return JSON.stringify(normalized);
}

function inferTasksForCall(call: TrajectoryCallLike): TrajectoryTrainingTask[] {
  const hints = collectCallHints(call);
  const response = call.response ?? "";
  const tasks = new Set<TrajectoryTrainingTask>();

  if (
    hints.includes("should_respond") ||
    hints.includes("response_handler") ||
    hints.includes("shouldrespond") ||
    hasMessageHandlerJsonFields(response)
  ) {
    tasks.add("should_respond");
  }

  if (hasContextRoutingFields(response)) {
    tasks.add("context_routing");
    tasks.add("should_respond");
  }

  if (
    hints.includes("action_planner") ||
    hints.includes("planner") ||
    hints.includes("action") ||
    hints.includes("runtime_use_model") ||
    looksLikePlannerCall(call)
  ) {
    tasks.add("action_planner");
  }

  if (
    hints.includes("media_description") ||
    hints.includes("image_description") ||
    hints.includes("describe_image") ||
    hints.includes("describe_audio") ||
    hints.includes("describe_video")
  ) {
    tasks.add("media_description");
  }

  if (
    hints.includes("response") ||
    hints.includes("reply") ||
    hints.includes("message_response")
  ) {
    tasks.add("response");
  }

  if (
    tasks.size === 0 &&
    typeof call.response === "string" &&
    call.response.trim()
  ) {
    tasks.add("response");
  }

  return [...tasks];
}

function buildExampleForTask(
  trajectory: Trajectory,
  call: TrajectoryCallLike,
  task: TrajectoryTrainingTask,
): ElizaNativeTrainingExample | null {
  const response = call.response?.trim();
  const trajectoryId = String(trajectory.trajectoryId ?? "");
  const callId =
    typeof call.callId === "string" && call.callId.trim().length > 0
      ? call.callId
      : `${trajectoryId}-call`;

  if (!response) {
    return null;
  }

  if (task === "should_respond" || task === "context_routing") {
    if (!normalizeMessageHandlerJson(response)) {
      return null;
    }
  }

  const row = buildElizaNativeTrajectoryRows([trajectory]).find(
    (candidate) => candidate.callId === callId,
  );
  if (!row) return null;

  return {
    ...row,
    format: ELIZA_NATIVE_TRAJECTORY_FORMAT,
    metadata: {
      ...row.metadata,
      task_type: task,
      source_dataset: `eliza_native/${task}`,
      trajectory_id: trajectoryId,
      call_id: callId,
      agent_id: String(trajectory.agentId ?? "unknown"),
      trajectory_source:
        typeof trajectory.metadata?.source === "string"
          ? trajectory.metadata.source
          : row.metadata.trajectory_source,
    },
  };
}

function collectTrajectoryExamplesByTask(
  trajectoriesInput: Trajectory[] | string,
  tasks?: readonly TrajectoryTrainingTask[],
): TrajectoryTaskExtractionResult {
  const nativeRows =
    typeof trajectoriesInput === "string"
      ? extractElizaNativeRowsFromExportText(trajectoriesInput)
      : [];
  const trajectories =
    typeof trajectoriesInput === "string"
      ? extractTrajectoriesFromExportText(trajectoriesInput)
      : trajectoriesInput;
  const requestedTasks = new Set<TrajectoryTrainingTask>(
    tasks ?? [
      "should_respond",
      "context_routing",
      "action_planner",
      "response",
      "media_description",
    ],
  );
  const examples = createEmptyExampleMap();
  const sourceCallCounts = createEmptyCountMap();
  const sourceTrajectoryIds = createEmptyTrajectoryIdMap();
  let llmCallCount = 0;
  let skippedNonNativeRows = 0;
  const warnings: string[] = [];
  const warnSkip = (message: string): void => {
    skippedNonNativeRows += 1;
    warnings.push(message);
    console.warn(message);
  };

  if (nativeRows.length > 0) {
    for (const row of nativeRows) {
      llmCallCount += 1;
      const task =
        normalizeTrainingTask(row.metadata?.task_type) ??
        normalizeTrainingTask(row.purpose) ??
        normalizeTrainingTask(row.stepType) ??
        normalizeTrainingTask(row.actionType);
      if (!task || !requestedTasks.has(task)) {
        continue;
      }
      examples[task].push(row);
      sourceCallCounts[task] += 1;
      if (typeof row.trajectoryId === "string") {
        sourceTrajectoryIds[task].add(row.trajectoryId);
      }
    }
    return {
      examples,
      sourceCallCounts,
      sourceTrajectoryIds,
      llmCallCount,
      skippedNonNativeRows,
      warnings,
    };
  }

  for (const trajectory of trajectories) {
    const trajectoryId = trajectory.trajectoryId;
    for (const entry of listTrajectoryCallEntries(trajectory)) {
      llmCallCount += 1;
      const call = entry.call as TrajectoryCallLike;
      const inferredTasks = inferTasksForCall(call);
      for (const task of inferredTasks) {
        if (!requestedTasks.has(task)) {
          continue;
        }

        const example = buildExampleForTask(trajectory, call, task);
        if (!example) {
          if (task === "should_respond" || task === "context_routing") {
            warnSkip(
              `[trajectory-task-datasets] skipped non-native ${task} row from trajectory ${trajectoryId} call ${call.callId ?? "unknown"}; expected native messageHandler JSON`,
            );
          }
          continue;
        }

        examples[task].push(example);
        sourceCallCounts[task] += 1;
        sourceTrajectoryIds[task].add(trajectoryId);
      }
    }
  }

  return {
    examples,
    sourceCallCounts,
    sourceTrajectoryIds,
    llmCallCount,
    skippedNonNativeRows,
    warnings,
  };
}

export function extractTrajectoryExamplesByTask(
  trajectories: Trajectory[] | string,
  tasks?: readonly TrajectoryTrainingTask[],
): Record<TrajectoryTrainingTask, ElizaNativeTrainingExample[]> {
  return collectTrajectoryExamplesByTask(trajectories, tasks).examples;
}

export async function exportTrajectoryTaskDatasets(
  trajectories: Trajectory[] | string,
  outputDir: string,
  tasks?: readonly TrajectoryTrainingTask[],
): Promise<TrajectoryTaskDatasetExport> {
  await mkdir(outputDir, { recursive: true });

  const extraction = collectTrajectoryExamplesByTask(trajectories, tasks);
  const normalizedTrajectories =
    typeof trajectories === "string"
      ? extractTrajectoriesFromExportText(trajectories)
      : trajectories;
  const nativeRows =
    typeof trajectories === "string"
      ? extractElizaNativeRowsFromExportText(trajectories)
      : [];
  const { examples } = extraction;
  const counts: Record<TrajectoryTrainingTask, number> = {
    should_respond: examples.should_respond.length,
    context_routing: examples.context_routing.length,
    action_planner: examples.action_planner.length,
    response: examples.response.length,
    media_description: examples.media_description.length,
  };

  const paths: TrajectoryTaskDatasetPaths = {
    shouldRespondPath: join(outputDir, TASK_FILE_NAMES.should_respond),
    contextRoutingPath: join(outputDir, TASK_FILE_NAMES.context_routing),
    actionPlannerPath: join(outputDir, TASK_FILE_NAMES.action_planner),
    responsePath: join(outputDir, TASK_FILE_NAMES.response),
    mediaDescriptionPath: join(outputDir, TASK_FILE_NAMES.media_description),
    summaryPath: join(outputDir, "trajectory_dataset_summary.json"),
  };
  const summary: TrajectoryTaskDatasetSummary = {
    generatedAt: new Date().toISOString(),
    trajectoryCount:
      normalizedTrajectories.length > 0
        ? normalizedTrajectories.length
        : new Set(nativeRows.map((row) => row.trajectoryId)).size,
    llmCallCount: extraction.llmCallCount,
    skippedNonNativeRows: extraction.skippedNonNativeRows,
    warnings: extraction.warnings,
    counts,
    tasks: [
      "should_respond",
      "context_routing",
      "action_planner",
      "response",
      "media_description",
    ].filter(
      (task) => tasks?.includes(task as TrajectoryTrainingTask) ?? true,
    ) as TrajectoryTrainingTask[],
    taskMetrics: {
      should_respond: {
        exampleCount: counts.should_respond,
        sourceCallCount: extraction.sourceCallCounts.should_respond,
        sourceTrajectoryCount:
          extraction.sourceTrajectoryIds.should_respond.size,
      },
      context_routing: {
        exampleCount: counts.context_routing,
        sourceCallCount: extraction.sourceCallCounts.context_routing,
        sourceTrajectoryCount:
          extraction.sourceTrajectoryIds.context_routing.size,
      },
      action_planner: {
        exampleCount: counts.action_planner,
        sourceCallCount: extraction.sourceCallCounts.action_planner,
        sourceTrajectoryCount:
          extraction.sourceTrajectoryIds.action_planner.size,
      },
      response: {
        exampleCount: counts.response,
        sourceCallCount: extraction.sourceCallCounts.response,
        sourceTrajectoryCount: extraction.sourceTrajectoryIds.response.size,
      },
      media_description: {
        exampleCount: counts.media_description,
        sourceCallCount: extraction.sourceCallCounts.media_description,
        sourceTrajectoryCount:
          extraction.sourceTrajectoryIds.media_description.size,
      },
    },
  };

  await writeFile(
    paths.shouldRespondPath,
    `${examples.should_respond.map((example) => JSON.stringify(example)).join("\n")}${examples.should_respond.length > 0 ? "\n" : ""}`,
  );
  await writeFile(
    paths.contextRoutingPath,
    `${examples.context_routing.map((example) => JSON.stringify(example)).join("\n")}${examples.context_routing.length > 0 ? "\n" : ""}`,
  );
  await writeFile(
    paths.actionPlannerPath,
    `${examples.action_planner.map((example) => JSON.stringify(example)).join("\n")}${examples.action_planner.length > 0 ? "\n" : ""}`,
  );
  await writeFile(
    paths.responsePath,
    `${examples.response.map((example) => JSON.stringify(example)).join("\n")}${examples.response.length > 0 ? "\n" : ""}`,
  );
  await writeFile(
    paths.mediaDescriptionPath,
    `${examples.media_description.map((example) => JSON.stringify(example)).join("\n")}${examples.media_description.length > 0 ? "\n" : ""}`,
  );

  await writeFile(paths.summaryPath, JSON.stringify(summary, null, 2));

  return {
    counts,
    paths,
    examples,
    summary,
  };
}
