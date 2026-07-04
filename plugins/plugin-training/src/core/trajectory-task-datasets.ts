/**
 * Extracts per-task training examples from recorded trajectories and writes
 * them as `eliza_native_v1` JSONL, one file per training task. Reward/quality
 * signals (scenario status, judge score) ride along so failed scenarios are not
 * cloned as gold supervision. Shared by the export bundle and the nightly cron.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Trajectory, TrajectoryLlmCall } from "@elizaos/agent";
import {
  buildElizaNativeTrajectoryRows,
  ELIZA_NATIVE_MODEL_BOUNDARIES,
  ELIZA_NATIVE_TRAJECTORY_FORMAT,
  type ElizaNativeTrajectoryRow,
} from "@elizaos/core";
import {
  extractElizaNativeRowsFromExportText,
  listTrajectoryCallEntries,
  parseTrajectoryExportText,
} from "./trajectory-consumer.js";

export type ElizaNativeTrainingExample = ElizaNativeTrajectoryRow;

/**
 * Canonical, ordered list of trajectory training tasks. The union type and
 * every per-task map/record in this module derive from this single list so
 * adding a task (e.g. a LifeOps capability) is a one-line change that the
 * compiler then forces to be handled everywhere a full record is required.
 *
 * The first six are the generic-runtime decision tasks; the rest are the
 * LifeOps per-capability tasks introduced for the GEPA/trajectory optimization
 * loop (issue #8795). They mirror `LIFEOPS_OPTIMIZED_PROMPT_TASKS` in
 * `@elizaos/core` (kept in sync — core is the source of truth for the artifact
 * store, this list is the source of truth for the trajectory dataset buckets).
 */
export const ALL_TRAJECTORY_TRAINING_TASKS = [
  "should_respond",
  "context_routing",
  "action_planner",
  "response",
  "media_description",
  "view_context",
  // LifeOps per-capability tasks (#8795).
  "calendar_extract",
  "schedule_plan",
  "reminder_dispatch",
  "inbox_triage",
  "meeting_prep",
  "morning_brief",
  "health_checkin",
  "screentime_recap",
] as const;

export type TrajectoryTrainingTask =
  (typeof ALL_TRAJECTORY_TRAINING_TASKS)[number];

/** The LifeOps per-capability subset of {@link ALL_TRAJECTORY_TRAINING_TASKS}. */
export const LIFEOPS_TRAINING_TASKS = [
  "calendar_extract",
  "schedule_plan",
  "reminder_dispatch",
  "inbox_triage",
  "meeting_prep",
  "morning_brief",
  "health_checkin",
  "screentime_recap",
] as const satisfies readonly TrajectoryTrainingTask[];

export type LifeOpsTrainingTask = (typeof LIFEOPS_TRAINING_TASKS)[number];

/** Build a full per-task record by deriving an entry for every training task. */
export function buildTaskRecord<T>(
  make: (task: TrajectoryTrainingTask) => T,
): Record<TrajectoryTrainingTask, T> {
  const out = {} as Record<TrajectoryTrainingTask, T>;
  for (const task of ALL_TRAJECTORY_TRAINING_TASKS) {
    out[task] = make(task);
  }
  return out;
}

export interface TrajectoryTaskDatasetPaths {
  shouldRespondPath: string;
  contextRoutingPath: string;
  actionPlannerPath: string;
  responsePath: string;
  mediaDescriptionPath: string;
  viewContextPath: string;
  calendarExtractPath: string;
  schedulePlanPath: string;
  reminderDispatchPath: string;
  inboxTriagePath: string;
  meetingPrepPath: string;
  morningBriefPath: string;
  healthCheckinPath: string;
  screentimeRecapPath: string;
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
  /**
   * Rows dropped because their scenario outcome was `failed`/`skipped`
   * (quality gate — a failed trajectory must not be cloned as gold-weight
   * supervision, #8795).
   */
  excludedFailedScenarioRows: number;
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
  view_context: "view_context_trajectories.jsonl",
  calendar_extract: "calendar_extract_trajectories.jsonl",
  schedule_plan: "schedule_plan_trajectories.jsonl",
  reminder_dispatch: "reminder_dispatch_trajectories.jsonl",
  inbox_triage: "inbox_triage_trajectories.jsonl",
  meeting_prep: "meeting_prep_trajectories.jsonl",
  morning_brief: "morning_brief_trajectories.jsonl",
  health_checkin: "health_checkin_trajectories.jsonl",
  screentime_recap: "screentime_recap_trajectories.jsonl",
};

const NATIVE_MODEL_BOUNDARIES = new Set<string>(ELIZA_NATIVE_MODEL_BOUNDARIES);

type TaskExampleMap = Record<
  TrajectoryTrainingTask,
  ElizaNativeTrainingExample[]
>;
type TaskCountMap = Record<TrajectoryTrainingTask, number>;
type TaskTrajectoryIdMap = Record<TrajectoryTrainingTask, Set<string>>;

interface TrajectoryTaskExtractionResult {
  examples: TaskExampleMap;
  sourceCallCounts: TaskCountMap;
  sourceTrajectoryIds: TaskTrajectoryIdMap;
  llmCallCount: number;
  skippedNonNativeRows: number;
  excludedFailedScenarioRows: number;
  warnings: string[];
}

function createEmptyExampleMap(): TaskExampleMap {
  return buildTaskRecord<ElizaNativeTrainingExample[]>(() => []);
}

function createEmptyCountMap(): TaskCountMap {
  return buildTaskRecord<number>(() => 0);
}

function createEmptyTrajectoryIdMap(): TaskTrajectoryIdMap {
  return buildTaskRecord<Set<string>>(() => new Set<string>());
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

const TRAINING_TASK_SET = new Set<string>(ALL_TRAJECTORY_TRAINING_TASKS);

function normalizeTrainingTask(value: unknown): TrajectoryTrainingTask | null {
  const normalized = normalizeToken(value);
  if (normalized === "reply") {
    return "response";
  }
  // Honors an explicit `task_type` of any known training task — including the
  // LifeOps per-capability tasks, which is how LifeOps planner/extractor
  // trajectories bucket into their own datasets (#8795).
  if (TRAINING_TASK_SET.has(normalized)) {
    return normalized as TrajectoryTrainingTask;
  }
  return null;
}

/**
 * Quality signal attached to a trajectory row (#8795).
 *
 * What exists today:
 * - The scenario-runner CLI (`eliza-scenarios run … --export-native`) stamps
 *   each exported row with `metadata.scenario_status` (passed/failed/skipped,
 *   from the scenario report) and, when a judge ran, `metadata.judge_score`
 *   (0..1 numeric).
 * - The runtime recorder tags trajectories with `scenarioId` (via
 *   `ELIZA_LIFEOPS_SCENARIO_ID`) but does NOT record pass/fail itself — a
 *   producer that knows the outcome (scenario CLI, benchmark runner) must
 *   stamp `scenario_status` / `judge_score` onto `trajectory.metadata`, which
 *   `buildElizaNativeTrajectoryRows` copies into
 *   `metadata.trajectory_metadata`.
 *
 * Both locations are read here so either path reward-weights identically.
 */
export interface TrajectoryQualitySignal {
  scenarioStatus?: "passed" | "failed" | "skipped";
  judgeScore?: number;
}

function readQualityBag(bag: Record<string, unknown>): TrajectoryQualitySignal {
  const out: TrajectoryQualitySignal = {};
  const status = bag.scenario_status;
  if (status === "passed" || status === "failed" || status === "skipped") {
    out.scenarioStatus = status;
  }
  const score = bag.judge_score;
  if (typeof score === "number" && Number.isFinite(score)) {
    out.judgeScore = Math.min(1, Math.max(0, score));
  }
  return out;
}

/**
 * Extract the quality signal for a native row's metadata. Direct keys win;
 * the nested `trajectory_metadata` bag (runtime-trajectory path) is the
 * fallback.
 */
export function qualitySignalForRowMetadata(
  metadata: Record<string, unknown> | undefined,
): TrajectoryQualitySignal {
  if (!metadata) return {};
  const direct = readQualityBag(metadata);
  const nested =
    metadata.trajectory_metadata &&
    typeof metadata.trajectory_metadata === "object" &&
    !Array.isArray(metadata.trajectory_metadata)
      ? readQualityBag(metadata.trajectory_metadata as Record<string, unknown>)
      : {};
  return {
    scenarioStatus: direct.scenarioStatus ?? nested.scenarioStatus,
    judgeScore: direct.judgeScore ?? nested.judgeScore,
  };
}

/**
 * Reward for an optimization example derived from its quality signal:
 * numeric judge score when present, else 1.0 for a passed scenario, else
 * undefined (no signal — never fabricate). Failed/skipped rows should be
 * excluded before this is consulted ({@link isFailedScenarioSignal}).
 */
export function rewardForQualitySignal(
  signal: TrajectoryQualitySignal,
): number | undefined {
  if (typeof signal.judgeScore === "number") return signal.judgeScore;
  if (signal.scenarioStatus === "passed") return 1;
  return undefined;
}

export function isFailedScenarioSignal(
  signal: TrajectoryQualitySignal,
): boolean {
  return (
    signal.scenarioStatus === "failed" || signal.scenarioStatus === "skipped"
  );
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

/**
 * Contextual view-selection call (the `view_context` evaluator). Its response is
 * a `{viewId, reason?}` JSON object — `viewId` is a registered view id or the
 * decline sentinel ("none"). We classify on the structural `viewId` string field
 * rather than a value allowlist so the bucket survives the matcher/registry
 * growing new views, mirroring how `hasContextRoutingFields` keys on shape.
 */
function hasViewContextFields(text: string): boolean {
  const parsed = parseJsonObject(text);
  if (!parsed) return false;
  return typeof parsed.viewId === "string" && parsed.viewId.trim().length > 0;
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
    hints.includes("view_context") ||
    hints.includes("view_selection") ||
    hasViewContextFields(response)
  ) {
    tasks.add("view_context");
  }

  if (
    hints.includes("response") ||
    hints.includes("reply") ||
    hints.includes("message_response")
  ) {
    tasks.add("response");
  }

  // LifeOps per-capability tasks (#8795): a planner/extractor call that tags
  // itself with a LifeOps task (via purpose / stepType / actionType / a tag, or
  // an explicit `task_type`) buckets into that LifeOps dataset. This is the
  // raw-trajectory counterpart of the explicit `task_type` honored on the
  // native-row path; the two together let real LifeOps trajectories optimize.
  for (const lifeOpsTask of LIFEOPS_TRAINING_TASKS) {
    if (hints.includes(lifeOpsTask)) {
      tasks.add(lifeOpsTask);
    }
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
  const trajectoryId = String(trajectory.trajectoryId);
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

  if (task === "view_context" && !hasViewContextFields(response)) {
    return null;
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
      agent_id: String(trajectory.agentId),
      trajectory_source:
        typeof trajectory.metadata?.source === "string"
          ? trajectory.metadata.source
          : row.metadata.trajectory_source,
    },
  };
}

function hasNativeRequestPayload(row: ElizaNativeTrajectoryRow): boolean {
  const request = row.request;
  if (!request || typeof request !== "object") {
    return false;
  }
  if (typeof request.prompt === "string" && request.prompt.length > 0) {
    return true;
  }
  if (Array.isArray(request.messages) && request.messages.length > 0) {
    return true;
  }
  return false;
}

function hasNativeResponsePayload(row: ElizaNativeTrajectoryRow): boolean {
  const response = row.response;
  if (!response || typeof response !== "object") {
    return false;
  }
  if (typeof response.text === "string" && response.text.length > 0) {
    return true;
  }
  return Array.isArray(response.toolCalls) && response.toolCalls.length > 0;
}

function isNativeRowUsableForTask(
  row: ElizaNativeTrajectoryRow,
  task: TrajectoryTrainingTask,
): boolean {
  if (!NATIVE_MODEL_BOUNDARIES.has(row.boundary)) {
    return false;
  }
  if (!hasNativeRequestPayload(row) || !hasNativeResponsePayload(row)) {
    return false;
  }
  if (task === "should_respond" || task === "context_routing") {
    return normalizeMessageHandlerJson(row.response.text) !== null;
  }
  if (task === "view_context") {
    return hasViewContextFields(row.response.text);
  }
  return true;
}

function collectTrajectoryExamplesByTask(
  trajectoriesInput: Trajectory[] | string,
  tasks?: readonly TrajectoryTrainingTask[],
): TrajectoryTaskExtractionResult {
  const nativeRows =
    typeof trajectoriesInput === "string"
      ? extractElizaNativeRowsFromExportText(trajectoriesInput)
      : [];
  const nonNativeRowCount =
    typeof trajectoriesInput === "string" && nativeRows.length === 0
      ? parseTrajectoryExportText(trajectoriesInput).length
      : 0;
  const trajectories =
    typeof trajectoriesInput === "string" ? [] : trajectoriesInput;
  const requestedTasks = new Set<TrajectoryTrainingTask>(
    tasks ?? ALL_TRAJECTORY_TRAINING_TASKS,
  );
  const examples = createEmptyExampleMap();
  const sourceCallCounts = createEmptyCountMap();
  const sourceTrajectoryIds = createEmptyTrajectoryIdMap();
  let llmCallCount = 0;
  let skippedNonNativeRows = 0;
  let excludedFailedScenarioRows = 0;
  const warnings: string[] = [];
  const warnSkip = (message: string, count = 1): void => {
    skippedNonNativeRows += count;
    warnings.push(message);
    console.warn(message);
  };
  const warnExcludeFailed = (message: string): void => {
    excludedFailedScenarioRows += 1;
    warnings.push(message);
    console.warn(message);
  };

  if (nativeRows.length > 0) {
    for (const row of nativeRows) {
      llmCallCount += 1;
      const task =
        normalizeTrainingTask(row.metadata.task_type) ??
        normalizeTrainingTask(row.purpose) ??
        normalizeTrainingTask(row.stepType) ??
        normalizeTrainingTask(row.actionType);
      if (!task || !requestedTasks.has(task)) {
        continue;
      }
      if (!isNativeRowUsableForTask(row, task)) {
        warnSkip(
          `[trajectory-task-datasets] skipped native ${task} row from trajectory ${row.trajectoryId} call ${row.callId}; expected exact request payload and model response`,
        );
        continue;
      }
      const quality = qualitySignalForRowMetadata(row.metadata);
      if (isFailedScenarioSignal(quality)) {
        warnExcludeFailed(
          `[trajectory-task-datasets] excluded ${task} row from trajectory ${row.trajectoryId} call ${row.callId}; scenario_status=${quality.scenarioStatus} must not train as gold (#8795)`,
        );
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
      excludedFailedScenarioRows,
      warnings,
    };
  }

  if (nonNativeRowCount > 0) {
    warnSkip(
      `[trajectory-task-datasets] skipped ${nonNativeRowCount} non-native trajectory row(s); expected eliza_native_v1`,
      nonNativeRowCount,
    );
  }

  for (const trajectory of trajectories) {
    const trajectoryId = trajectory.trajectoryId;
    // Trajectory-level quality gate: a producer that knows the scenario
    // outcome stamps `scenario_status` / `judge_score` onto
    // trajectory.metadata (see TrajectoryQualitySignal). A failed/skipped
    // trajectory is excluded wholesale — cloning its responses as
    // expectedOutput would train the failure.
    const trajectoryQuality = readQualityBag(trajectory.metadata ?? {});
    if (isFailedScenarioSignal(trajectoryQuality)) {
      const callTotal = listTrajectoryCallEntries(trajectory).length;
      llmCallCount += callTotal;
      excludedFailedScenarioRows += callTotal;
      const message = `[trajectory-task-datasets] excluded trajectory ${trajectoryId} (${callTotal} call(s)); scenario_status=${trajectoryQuality.scenarioStatus} must not train as gold (#8795)`;
      warnings.push(message);
      console.warn(message);
      continue;
    }
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
    excludedFailedScenarioRows,
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
    typeof trajectories === "string" ? [] : trajectories;
  const nativeRows =
    typeof trajectories === "string"
      ? extractElizaNativeRowsFromExportText(trajectories)
      : [];
  const { examples } = extraction;
  const counts = buildTaskRecord<number>((task) => examples[task].length);

  const paths: TrajectoryTaskDatasetPaths = {
    shouldRespondPath: join(outputDir, TASK_FILE_NAMES.should_respond),
    contextRoutingPath: join(outputDir, TASK_FILE_NAMES.context_routing),
    actionPlannerPath: join(outputDir, TASK_FILE_NAMES.action_planner),
    responsePath: join(outputDir, TASK_FILE_NAMES.response),
    mediaDescriptionPath: join(outputDir, TASK_FILE_NAMES.media_description),
    viewContextPath: join(outputDir, TASK_FILE_NAMES.view_context),
    calendarExtractPath: join(outputDir, TASK_FILE_NAMES.calendar_extract),
    schedulePlanPath: join(outputDir, TASK_FILE_NAMES.schedule_plan),
    reminderDispatchPath: join(outputDir, TASK_FILE_NAMES.reminder_dispatch),
    inboxTriagePath: join(outputDir, TASK_FILE_NAMES.inbox_triage),
    meetingPrepPath: join(outputDir, TASK_FILE_NAMES.meeting_prep),
    morningBriefPath: join(outputDir, TASK_FILE_NAMES.morning_brief),
    healthCheckinPath: join(outputDir, TASK_FILE_NAMES.health_checkin),
    screentimeRecapPath: join(outputDir, TASK_FILE_NAMES.screentime_recap),
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
    excludedFailedScenarioRows: extraction.excludedFailedScenarioRows,
    warnings: extraction.warnings,
    counts,
    tasks: ALL_TRAJECTORY_TRAINING_TASKS.filter(
      (task) => tasks?.includes(task) ?? true,
    ),
    taskMetrics: buildTaskRecord((task) => ({
      exampleCount: counts[task],
      sourceCallCount: extraction.sourceCallCounts[task],
      sourceTrajectoryCount: extraction.sourceTrajectoryIds[task].size,
    })),
  };

  // Write one JSONL per task (empty file when a task had no examples), so the
  // on-disk dataset layout always has a slot for every task — including the
  // LifeOps capabilities. Mirrors the prior per-task writeFile behavior.
  for (const task of ALL_TRAJECTORY_TRAINING_TASKS) {
    const rows = examples[task];
    await writeFile(
      join(outputDir, TASK_FILE_NAMES[task]),
      `${rows.map((example) => JSON.stringify(example)).join("\n")}${rows.length > 0 ? "\n" : ""}`,
    );
  }

  await writeFile(paths.summaryPath, JSON.stringify(summary, null, 2));

  return {
    counts,
    paths,
    examples,
    summary,
  };
}
