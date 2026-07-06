/**
 * training-trigger orchestrator.
 *
 * Single entry point for all paths that kick off a training run:
 *   - threshold:  TrainingTriggerService fires when the per-task counter passes
 *                 the configured threshold.
 *   - cron:       Scheduled job (e.g. nightly trajectory-export cron) calls
 *                 with `source: 'cron'`.
 *   - manual:     UI / CLI / API caller asks for an immediate run.
 *
 * Pipeline:
 *   1. Fetch the most recent matching trajectories from the runtime's
 *      trajectory service.
 *   2. Run them through the privacy filter (REQUIRED — never bypass).
 *   3. Bucket trajectories into per-task JSONL files via dataset-generator
 *      (`exportTrajectoryTaskDatasets`). When `task` is supplied, only that
 *      bucket is forwarded to the backend.
 *   4. Dispatch the chosen task's dataset to the configured backend
 *      (`native`).
 *   5. Persist a run record at `<state>/training/runs/<runId>.json`.
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Trajectory } from "@elizaos/agent";
import {
  type OptimizationRunReport,
  writeOptimizationRunReport,
} from "./optimization-report.js";
import {
  type AnonymizerLookup,
  applyPrivacyFilter,
  type FilterableTrajectory,
} from "./privacy-filter.js";
import {
  gatedPersistNativeResult,
  type PromotionServiceLike,
} from "./promotion-persist.js";
import {
  ALL_TRAINING_TASKS,
  loadTrainingConfig,
  resolveTaskPolicy,
  type TrainingBackend,
  type TrainingConfig,
  trainingStateRoot,
} from "./training-config.js";
import {
  exportTrajectoryTaskDatasets,
  type TrajectoryTaskDatasetExport,
  type TrajectoryTrainingTask,
} from "./trajectory-task-datasets.js";

interface MinimalLogger {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

interface RuntimeLike {
  getService: (name: string) => unknown;
  logger?: MinimalLogger;
}

interface TrajectoryServiceLike {
  listTrajectories: (options: {
    limit?: number;
  }) => Promise<{ trajectories: Array<{ id: string }> }>;
  getTrajectoryDetail: (id: string) => Promise<ExportableTrajectory | null>;
}

type ExportableTrajectory = Trajectory & FilterableTrajectory;

export type TriggerSource = "threshold" | "cron" | "manual";

export type TrainingRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped";

export interface TriggerTrainingOptions {
  task?: TrajectoryTrainingTask;
  backend?: TrainingBackend;
  source: TriggerSource;
  /** When true, run the full pipeline up to dispatch but do not invoke the backend. */
  dryRun?: boolean;
  /** Maximum trajectories pulled from the trajectory service. */
  trajectoryLimit?: number;
  /** Optional anonymizer for the privacy filter. */
  anonymizer?: AnonymizerLookup;
  /**
   * Backend dispatcher override — primarily for tests. Production callers
   * should leave this undefined and let the orchestrator route by name.
   */
  dispatcher?: BackendDispatcher;
  /** Override the loaded config (tests). */
  config?: TrainingConfig;
}

export interface TriggerTrainingResult {
  runId: string;
  status: TrainingRunStatus;
  reason?: string;
  task: TrajectoryTrainingTask | null;
  backend: TrainingBackend | null;
  source: TriggerSource;
  datasetSize: number;
  startedAt: string;
  finishedAt: string;
  artifactPath?: string;
  reportJsonPath?: string;
  reportHtmlPath?: string;
  report?: Pick<OptimizationRunReport, "schema" | "version" | "headline">;
}

export interface TrainingRunRecord extends TriggerTrainingResult {
  pulledTrajectories: number;
  filteredTrajectories: number;
  redactionCount: number;
  anonymizationCount: number;
  datasetPaths?: TrajectoryTaskDatasetExport["paths"];
  perTaskCounts?: TrajectoryTaskDatasetExport["counts"];
  dryRun: boolean;
  notes?: string[];
}

export interface BackendDispatchInput {
  task: TrajectoryTrainingTask;
  backend: TrainingBackend;
  datasetPath: string;
  runId: string;
  outputDir: string;
  /**
   * Runtime forwarded to backends that need an LLM (currently only `native`).
   * Other backends ignore it.
   */
  runtime: RuntimeLike;
}

export interface BackendDispatchResult {
  invoked: boolean;
  artifactPath?: string;
  notes?: string[];
}

export type BackendDispatcher = (
  input: BackendDispatchInput,
) => Promise<BackendDispatchResult>;

function runsDir(): string {
  return join(trainingStateRoot(), "runs");
}

function newRunId(): string {
  return `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

const PLANNER_BASELINE = `task: Plan the next native tool calls for the current ContextObject.

context_object:
{{contextObject}}

trajectory:
{{trajectory}}

rules:
- use only tools exposed in the current context object
- plan the smallest grounded queue of useful tool calls
- include arguments only when grounded in the user request or prior tool results
- if the task is complete or the only next step is speaking to the user, return no toolCalls and set messageToUser
- do not invent tool names, connector names, providers, ids, or benchmark ids

return:
JSON object only. No markdown, no prose, no XML, no legacy formats.`;

const SHOULD_RESPOND_BASELINE = `task: Decide whether the agent should respond to the current conversation turn.

context_object:
{{contextObject}}

trajectory:
{{trajectory}}

rules:
- choose respond when the user directly addresses the agent, asks for help, or the agent has a useful next action
- choose ignore for ambient chatter, messages clearly meant for someone else, or turns where responding would add noise
- choose stop when the conversation is complete or the user asks the agent to stop
- ground the decision in the provided context and trajectory only

return:
JSON object only with decision ("respond" | "ignore" | "stop") and concise reasoning.`;

const CONTEXT_ROUTING_BASELINE = `task: Route the current turn to the smallest useful execution context.

context_object:
{{contextObject}}

trajectory:
{{trajectory}}

rules:
- classify whether the turn needs ordinary reply generation, tool planning, memory/context lookup, media analysis, or no action
- prefer the narrowest context that can satisfy the user request
- do not invent capabilities that are absent from the context object
- if the current context is sufficient for a direct answer, keep routing simple

return:
JSON object only with context, requiresTool, candidateAction when grounded, and concise reasoning.`;

const RESPONSE_BASELINE = `task: Write the final user-facing response for the current turn.

context_object:
{{contextObject}}

trajectory:
{{trajectory}}

rules:
- answer directly using the available trajectory and context
- include relevant tool outputs or results instead of describing that tools were run
- be concise, concrete, and honest about any missing or failed evidence
- do not promise background work after this response
- do not include private chain-of-thought or implementation-only notes

return:
Natural language response text only.`;

const MEDIA_DESCRIPTION_BASELINE = `task: Describe the supplied media for downstream agent reasoning.

context_object:
{{contextObject}}

trajectory:
{{trajectory}}

rules:
- identify visible subjects, text, layout, actions, and notable details
- separate direct observations from uncertain inferences
- mention safety-relevant, UI-relevant, or task-relevant details when present
- avoid guessing identities or hidden intent without evidence

return:
JSON object only with summary, observations, text, uncertainty, and taskRelevantDetails.`;

const VIEW_CONTEXT_BASELINE = `task: Infer which app view fits the user's current situation when they did not name one.

context_object:
{{contextObject}}

trajectory:
{{trajectory}}

rules:
- only choose a view when the message clearly implies an activity that maps to one (e.g. coding work → task-coordinator, scheduling → calendar, spending → finances)
- return "none" when the message names a view directly (the navigation action handles those) or implies no specific surface
- never guess; ambiguous or chit-chat turns return "none"

return:
JSON object only with viewId (a registered view id or "none") and an optional reason.`;

// -----------------------------------------------------------------------------
// LifeOps per-capability fallback baselines (#8795). The optimizer prefers the
// live exported prompt template from the owning plugin via `loadBaselineForTask`
// below; these strings remain as last-resort fallbacks for stripped-down
// training installs where the LifeOps plugins are unavailable.
// -----------------------------------------------------------------------------

const CALENDAR_EXTRACT_BASELINE = `task: Extract a structured calendar event from a natural-language request.

request:
{{request}}

rules:
- resolve relative dates/times against the owner's current local time
- infer end time from a stated duration; default to a 30-minute event when none is given
- only include attendees explicitly named in the request

return:
JSON object only: { title, start (ISO 8601), end (ISO 8601), recurrence (RRULE or null), attendees (array), location (string or null) }.`;

const SCHEDULE_PLAN_BASELINE = `task: Order the owner's pending commitments into a concrete plan for the available time.

commitments:
{{commitments}}

free_slots:
{{freeSlots}}

rules:
- never double-book a slot; respect hard deadlines and fixed-time events first
- keep travel/buffer time between location-bound items
- surface anything that does not fit rather than silently dropping it

return:
JSON object only: { schedule: [{ itemId, start, end }], unplaced: [itemId], notes }.`;

const REMINDER_DISPATCH_BASELINE = `task: Decide whether to fire a reminder now and compose its message.

reminder:
{{reminder}}

context:
{{context}}

rules:
- only fire when the trigger condition is met; otherwise return shouldFire false
- write a short, specific message in the owner's voice; no filler
- escalate channel only when the reminder is overdue or marked urgent

return:
JSON object only: { shouldFire (boolean), channel, message }.`;

const INBOX_TRIAGE_BASELINE = `task: Classify one inbox message for the owner.

message:
{{message}}

rules:
- category must be one of ignore, info, notify, needs_reply, urgent
- urgency must be low, medium, or high
- use needs_reply when someone asks a question or expects a response
- use urgent only for time-sensitive or critical owner attention

return:
JSON object only: { category, urgency, confidence, reasoning, suggestedResponse }.`;

const MEETING_PREP_BASELINE = `task: Produce a concise prebrief for an upcoming meeting.

meeting:
{{meeting}}

context:
{{context}}

rules:
- lead with the meeting's purpose and the owner's desired outcome
- include only attendees and prior-thread facts that matter for this meeting
- keep talking points actionable; no generic advice

return:
JSON object only: { purpose, attendees: [{ name, note }], agenda: [string], talkingPoints: [string] }.`;

const MORNING_BRIEF_BASELINE = `task: Compose the owner's morning brief.

calendar:
{{calendar}}

tasks:
{{tasks}}

inbox:
{{inbox}}

rules:
- lead with the single most important thing for the day
- group by calendar, then must-do tasks, then inbox items needing a reply
- be brief and scannable; no greetings or filler

return:
Markdown brief only.`;

const HEALTH_CHECKIN_BASELINE = `task: Generate a health/sleep check-in for the owner.

signals:
{{signals}}

rules:
- ground every observation in a provided signal; never fabricate metrics
- ask at most one follow-up question, and only when a signal is missing or anomalous
- keep an encouraging, non-clinical tone

return:
JSON object only: { observation, question (string or null), suggestion }.`;

const SCREENTIME_RECAP_BASELINE = `task: Summarize the owner's screen-time and propose a focus adjustment.

usage:
{{usage}}

rules:
- highlight the largest changes vs. the prior period, not raw totals alone
- tie any suggestion to an actual usage pattern in the data
- propose at most one concrete blocker/focus change

return:
JSON object only: { recap, topApps: [{ app, minutes }], suggestion }.`;

function defaultBaselineForTask(task: TrajectoryTrainingTask): string {
  switch (task) {
    case "should_respond":
      return SHOULD_RESPOND_BASELINE;
    case "context_routing":
      return CONTEXT_ROUTING_BASELINE;
    case "action_planner":
      return PLANNER_BASELINE;
    case "response":
      return RESPONSE_BASELINE;
    case "media_description":
      return MEDIA_DESCRIPTION_BASELINE;
    case "view_context":
      return VIEW_CONTEXT_BASELINE;
    case "calendar_extract":
      return CALENDAR_EXTRACT_BASELINE;
    case "schedule_plan":
      return SCHEDULE_PLAN_BASELINE;
    case "reminder_dispatch":
      return REMINDER_DISPATCH_BASELINE;
    case "inbox_triage":
      return INBOX_TRIAGE_BASELINE;
    case "meeting_prep":
      return MEETING_PREP_BASELINE;
    case "morning_brief":
      return MORNING_BRIEF_BASELINE;
    case "health_checkin":
      return HEALTH_CHECKIN_BASELINE;
    case "screentime_recap":
      return SCREENTIME_RECAP_BASELINE;
  }
}

function firstStringExport(
  promptModule: Record<string, unknown>,
  names: readonly string[],
): string | null {
  for (const name of names) {
    const value = promptModule[name];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
    if (
      Array.isArray(value) &&
      value.every((entry) => typeof entry === "string")
    ) {
      const joined = value.join("\n").trim();
      if (joined.length > 0) {
        return joined;
      }
    }
  }
  return null;
}

async function importOptionalModule(
  specifier: string,
): Promise<Record<string, unknown> | null> {
  try {
    const imported = await import(specifier);
    return imported as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function loadFirstStringExport(
  specifier: string,
  names: readonly string[],
  sourceSpecifier?: string,
): Promise<string | null> {
  if (sourceSpecifier) {
    const sourceUrl = new URL(sourceSpecifier, import.meta.url);
    const sourceModule = await importOptionalModule(sourceUrl.href);
    const sourceExported = sourceModule
      ? firstStringExport(sourceModule, names)
      : null;
    if (sourceExported) {
      return sourceExported;
    }
  }
  const promptModule = await importOptionalModule(specifier);
  return promptModule ? firstStringExport(promptModule, names) : null;
}

async function loadLiveLifeOpsBaseline(
  task: TrajectoryTrainingTask,
): Promise<string | null> {
  switch (task) {
    case "calendar_extract":
      return loadFirstStringExport(
        "@elizaos/plugin-calendar/actions/optimized-prompt-instructions",
        ["CALENDAR_PLAN_INSTRUCTIONS"],
        "../../../plugin-calendar/src/actions/optimized-prompt-instructions.ts",
      );
    case "schedule_plan":
      return loadFirstStringExport(
        "@elizaos/plugin-personal-assistant/lifeops/optimized-prompt-instructions",
        ["SCHEDULE_PLAN_INSTRUCTIONS"],
        "../../../plugin-personal-assistant/src/lifeops/optimized-prompt-instructions.ts",
      );
    case "reminder_dispatch":
      return loadFirstStringExport(
        "@elizaos/plugin-personal-assistant/lifeops/optimized-prompt-instructions",
        ["REMINDER_DISPATCH_INSTRUCTIONS"],
        "../../../plugin-personal-assistant/src/lifeops/optimized-prompt-instructions.ts",
      );
    case "inbox_triage":
      return loadFirstStringExport(
        "@elizaos/plugin-inbox/inbox/triage-classifier",
        ["INBOX_TRIAGE_INSTRUCTIONS"],
        "../../../plugin-inbox/src/inbox/triage-classifier.ts",
      );
    case "meeting_prep":
      return loadFirstStringExport(
        "@elizaos/plugin-personal-assistant/lifeops/optimized-prompt-instructions",
        ["MEETING_PREP_INSTRUCTIONS"],
        "../../../plugin-personal-assistant/src/lifeops/optimized-prompt-instructions.ts",
      );
    case "morning_brief":
      return loadFirstStringExport(
        "@elizaos/plugin-personal-assistant/lifeops/optimized-prompt-instructions",
        ["BRIEF_NARRATIVE_INSTRUCTIONS"],
        "../../../plugin-personal-assistant/src/lifeops/optimized-prompt-instructions.ts",
      );
    case "health_checkin":
      return loadFirstStringExport(
        "@elizaos/plugin-health/actions/optimized-prompt-instructions",
        ["HEALTH_PLAN_INSTRUCTIONS"],
        "../../../plugin-health/src/actions/optimized-prompt-instructions.ts",
      );
    case "screentime_recap":
      return loadFirstStringExport(
        "@elizaos/plugin-health/actions/optimized-prompt-instructions",
        ["SCREENTIME_RECAP_INSTRUCTIONS"],
        "../../../plugin-health/src/actions/optimized-prompt-instructions.ts",
      );
    default:
      return null;
  }
}

function pathForTask(
  paths: TrajectoryTaskDatasetExport["paths"],
  task: TrajectoryTrainingTask,
): string {
  switch (task) {
    case "should_respond":
      return paths.shouldRespondPath;
    case "context_routing":
      return paths.contextRoutingPath;
    case "action_planner":
      return paths.actionPlannerPath;
    case "response":
      return paths.responsePath;
    case "media_description":
      return paths.mediaDescriptionPath;
    case "view_context":
      return paths.viewContextPath;
    case "calendar_extract":
      return paths.calendarExtractPath;
    case "schedule_plan":
      return paths.schedulePlanPath;
    case "reminder_dispatch":
      return paths.reminderDispatchPath;
    case "inbox_triage":
      return paths.inboxTriagePath;
    case "meeting_prep":
      return paths.meetingPrepPath;
    case "morning_brief":
      return paths.morningBriefPath;
    case "health_checkin":
      return paths.healthCheckinPath;
    case "screentime_recap":
      return paths.screentimeRecapPath;
  }
}

function selectTask(
  config: TrainingConfig,
  explicit: TrajectoryTrainingTask | undefined,
  counts: TrajectoryTaskDatasetExport["counts"],
): TrajectoryTrainingTask | null {
  if (explicit) return explicit;
  let bestTask: TrajectoryTrainingTask | null = null;
  let bestCount = 0;
  for (const task of ALL_TRAINING_TASKS) {
    const policy = resolveTaskPolicy(config, task);
    const count = counts[task];
    if (count > bestCount && count >= policy.threshold) {
      bestCount = count;
      bestTask = task;
    }
  }
  return bestTask;
}

async function defaultDispatcher(
  input: BackendDispatchInput,
): Promise<BackendDispatchResult> {
  switch (input.backend) {
    case "native": {
      const { runNativeBackend } = await import("../backends/native.js");
      const useModelHandler = await extractUseModel(input.runtime);
      if (!useModelHandler) {
        return {
          invoked: false,
          notes: [
            "native backend requires a runtime exposing useModel; skipped",
          ],
        };
      }
      const baselinePrompt = await loadBaselineForTask(input.task);
      const optimizerName = process.env.TRAIN_OPTIMIZER?.trim() ?? "gepa";
      const result = await runNativeBackend({
        datasetPath: input.datasetPath,
        task: input.task,
        optimizer:
          optimizerName as import("../optimizers/types.js").OptimizerName,
        baselinePrompt,
        runtime: { useModel: useModelHandler },
      });
      const notes = [...result.notes];
      if (!result.invoked) {
        return { invoked: false, notes };
      }

      const service = getOptimizedPromptService(input.runtime);
      if (!service) {
        notes.push(
          "OptimizedPromptService unavailable; artifact not persisted",
        );
        return { invoked: true, notes };
      }

      return await gatedPersistNativeResult({
        task: input.task,
        datasetPath: input.datasetPath,
        runId: input.runId,
        baselinePrompt,
        result,
        service,
        notesPrefix: notes,
      });
    }
  }
}

type UseModelLike = (input: {
  prompt: string;
  temperature?: number;
  maxTokens?: number;
}) => Promise<string | object | undefined>;

interface UseModelRuntime {
  useModel?: (
    modelType: string,
    input: { prompt: string; temperature?: number; maxTokens?: number },
  ) => Promise<string | object | undefined>;
}

async function extractUseModel(
  runtime: RuntimeLike,
): Promise<UseModelLike | null> {
  // Standing direction: training optimizer / variant generation runs on
  // Cerebras (default gemma-4-31b), NOT through the agent's primary provider.
  const trainProvider =
    process.env.TRAIN_MODEL_PROVIDER?.trim() ??
    process.env.TRAINING_PROVIDER?.trim();
  if (trainProvider === "cerebras") {
    const { getTrainingUseModelAdapter } = await import(
      "./cerebras-eval-model.js"
    );
    return getTrainingUseModelAdapter();
  }

  const candidate = runtime as RuntimeLike & UseModelRuntime;
  if (typeof candidate.useModel !== "function") return null;
  return async (input) => {
    return await candidate.useModel?.("TEXT_LARGE", input);
  };
}

function getOptimizedPromptService(
  runtime: RuntimeLike,
): PromotionServiceLike | null {
  const service = runtime.getService(
    "optimized_prompt",
  ) as PromotionServiceLike | null;
  if (!service || typeof service.setPrompt !== "function") return null;
  return service;
}

/**
 * Pull the live runtime template for the task. Falls back to concrete bundled
 * task baselines when the runtime cannot expose its template.
 */
export async function loadBaselineForTask(
  task: TrajectoryTrainingTask,
): Promise<string> {
  const prompts = await import("@elizaos/core").catch(() => null);
  if (!prompts) {
    return defaultBaselineForTask(task);
  }
  const promptModule = prompts as Record<string, unknown>;
  switch (task) {
    case "should_respond":
      return (
        firstStringExport(promptModule, [
          "shouldRespondTemplate",
          "messageHandlerTemplate",
        ]) ?? defaultBaselineForTask(task)
      );
    case "context_routing":
      return (
        firstStringExport(promptModule, [
          "messageHandlerTemplate",
          "shouldRespondTemplate",
        ]) ?? defaultBaselineForTask(task)
      );
    case "response":
      return (
        firstStringExport(promptModule, [
          "messageHandlerTemplate",
          "replyTemplate",
        ]) ?? defaultBaselineForTask(task)
      );
    case "action_planner":
      return (
        firstStringExport(promptModule, [
          "plannerTemplate",
          "PLANNER_TEMPLATE",
        ]) ?? PLANNER_BASELINE
      );
    case "media_description":
      return (
        firstStringExport(promptModule, [
          "imageDescriptionTemplate",
          "IMAGE_DESCRIPTION_TEMPLATE",
        ]) ?? defaultBaselineForTask(task)
      );
    case "view_context":
      // The runtime exposes no core template for the contextual view evaluator;
      // its baseline lives in @elizaos/plugin-app-control. Use the bundled
      // baseline so the optimizer always has a concrete starting prompt.
      return defaultBaselineForTask(task);
    case "calendar_extract":
    case "schedule_plan":
    case "reminder_dispatch":
    case "inbox_triage":
    case "meeting_prep":
    case "morning_brief":
    case "health_checkin":
    case "screentime_recap": {
      const liveBaseline = await loadLiveLifeOpsBaseline(task);
      return liveBaseline ?? defaultBaselineForTask(task);
    }
  }
}

export async function recordRun(record: TrainingRunRecord): Promise<string> {
  const dir = runsDir();
  await mkdir(dir, { recursive: true });
  const reportResult = await writeOptimizationRunReport(record);
  const enriched: TrainingRunRecord = {
    ...record,
    reportJsonPath: reportResult.reportJsonPath,
    reportHtmlPath: reportResult.reportHtmlPath,
    report: {
      schema: reportResult.report.schema,
      version: reportResult.report.version,
      headline: reportResult.report.headline,
    },
  };
  const path = join(dir, `${record.runId}.json`);
  await writeFile(path, `${JSON.stringify(enriched, null, 2)}\n`, "utf-8");
  return path;
}

export async function loadRun(
  runId: string,
): Promise<TrainingRunRecord | null> {
  const path = join(runsDir(), `${runId}.json`);
  if (!existsSync(path)) return null;
  const raw = await readFile(path, "utf-8");
  return JSON.parse(raw) as TrainingRunRecord;
}

export async function listRuns(limit = 20): Promise<TrainingRunRecord[]> {
  const dir = runsDir();
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir);
  const runFiles = entries.filter((name) => name.endsWith(".json"));
  // Filenames embed the timestamp prefix `run-<ms>-...` so a reverse
  // lexicographic sort yields newest-first without a stat call.
  runFiles.sort((a, b) => (a < b ? 1 : -1));
  const sliced = runFiles.slice(0, Math.max(0, limit));
  const records: TrainingRunRecord[] = [];
  for (const file of sliced) {
    const raw = await readFile(join(dir, file), "utf-8");
    records.push(JSON.parse(raw) as TrainingRunRecord);
  }
  return records;
}

/**
 * Single entry point for kicking off a training run from any caller.
 *
 * Returns a record describing what happened, including `status: "skipped"`
 * when the pipeline ran but the configured backend declined to invoke (no
 * data, no backend configured, unavailable optimizer backend, etc.). Errors are
 * surfaced as `status: "failed"` with `reason`; never swallowed.
 */
export async function triggerTraining(
  runtime: RuntimeLike,
  options: TriggerTrainingOptions,
): Promise<TrainingRunRecord> {
  const runId = newRunId();
  const startedAt = nowIso();
  const log: MinimalLogger = runtime.logger ?? {
    info: () => {},
    warn: () => {},
    error: () => {},
  };
  const config = options.config ?? loadTrainingConfig();

  const trajectoryService = runtime.getService(
    "trajectories",
  ) as TrajectoryServiceLike | null;
  if (
    !trajectoryService ||
    typeof trajectoryService.listTrajectories !== "function" ||
    typeof trajectoryService.getTrajectoryDetail !== "function"
  ) {
    const finishedAt = nowIso();
    const record: TrainingRunRecord = {
      runId,
      status: "skipped",
      reason: "trajectories service unavailable",
      task: options.task ?? null,
      backend: options.backend ?? null,
      source: options.source,
      datasetSize: 0,
      startedAt,
      finishedAt,
      pulledTrajectories: 0,
      filteredTrajectories: 0,
      redactionCount: 0,
      anonymizationCount: 0,
      dryRun: options.dryRun ?? false,
    };
    await recordRun(record);
    log.warn(
      `[TrainingOrchestrator] ${runId} skipped: trajectories service unavailable`,
    );
    return record;
  }

  const limit = options.trajectoryLimit ?? 500;
  const list = await trajectoryService.listTrajectories({ limit });
  const trajectories: ExportableTrajectory[] = [];
  for (const item of list.trajectories) {
    const detail = await trajectoryService.getTrajectoryDetail(item.id);
    if (detail) trajectories.push(detail);
  }

  // Privacy filter is REQUIRED here — the downstream export writes JSONL to
  // disk, and those files must never contain raw user secrets or un-anonymized
  // handles. Filtering happens before any write path below runs.
  const filtered = applyPrivacyFilter(trajectories, {
    anonymizer: options.anonymizer,
  });

  const outputDir = join(trainingStateRoot(), "runs", runId, "datasets");
  await mkdir(outputDir, { recursive: true });
  // privacy filter applied above
  const dataset = await exportTrajectoryTaskDatasets(
    filtered.trajectories as Parameters<typeof exportTrajectoryTaskDatasets>[0],
    outputDir,
  );

  const task = selectTask(config, options.task, dataset.counts);
  if (!task) {
    const finishedAt = nowIso();
    const record: TrainingRunRecord = {
      runId,
      status: "skipped",
      reason:
        "no task reached its trigger threshold and none was specified explicitly",
      task: null,
      backend: options.backend ?? null,
      source: options.source,
      datasetSize: 0,
      startedAt,
      finishedAt,
      pulledTrajectories: trajectories.length,
      filteredTrajectories: filtered.trajectories.length,
      redactionCount: filtered.redactionCount,
      anonymizationCount: filtered.anonymizationCount,
      datasetPaths: dataset.paths,
      perTaskCounts: dataset.counts,
      dryRun: options.dryRun ?? false,
    };
    await recordRun(record);
    log.info(
      `[TrainingOrchestrator] ${runId} skipped: no task selected (counts=${JSON.stringify(dataset.counts)})`,
    );
    return record;
  }

  const policy = resolveTaskPolicy(config, task);
  const backend = options.backend ?? policy.backend;
  const datasetPath = pathForTask(dataset.paths, task);
  const datasetSize = dataset.counts[task];

  if (!backend) {
    const finishedAt = nowIso();
    const record: TrainingRunRecord = {
      runId,
      status: "skipped",
      reason: "no backend configured",
      task,
      backend: null,
      source: options.source,
      datasetSize,
      startedAt,
      finishedAt,
      pulledTrajectories: trajectories.length,
      filteredTrajectories: filtered.trajectories.length,
      redactionCount: filtered.redactionCount,
      anonymizationCount: filtered.anonymizationCount,
      datasetPaths: dataset.paths,
      perTaskCounts: dataset.counts,
      dryRun: options.dryRun ?? false,
      notes: [
        "Set training.backends in <state>/training/config.json to enable dispatch.",
      ],
    };
    await recordRun(record);
    log.info(
      `[TrainingOrchestrator] ${runId} skipped: no backend configured for task=${task}`,
    );
    return record;
  }

  if (options.dryRun) {
    const finishedAt = nowIso();
    const record: TrainingRunRecord = {
      runId,
      status: "succeeded",
      reason: "dry run",
      task,
      backend,
      source: options.source,
      datasetSize,
      startedAt,
      finishedAt,
      pulledTrajectories: trajectories.length,
      filteredTrajectories: filtered.trajectories.length,
      redactionCount: filtered.redactionCount,
      anonymizationCount: filtered.anonymizationCount,
      datasetPaths: dataset.paths,
      perTaskCounts: dataset.counts,
      dryRun: true,
      notes: [`dry run; would dispatch ${datasetPath} to backend=${backend}`],
    };
    await recordRun(record);
    log.info(
      `[TrainingOrchestrator] ${runId} dry-run task=${task} backend=${backend} datasetSize=${datasetSize}`,
    );
    return record;
  }

  const dispatcher = options.dispatcher ?? defaultDispatcher;
  const dispatchResult = await dispatcher({
    task,
    backend,
    datasetPath,
    runId,
    outputDir,
    runtime,
  });

  const finishedAt = nowIso();
  const status: TrainingRunStatus = dispatchResult.invoked
    ? "succeeded"
    : "skipped";
  const record: TrainingRunRecord = {
    runId,
    status,
    reason: dispatchResult.invoked ? undefined : "backend declined to invoke",
    task,
    backend,
    source: options.source,
    datasetSize,
    startedAt,
    finishedAt,
    pulledTrajectories: trajectories.length,
    filteredTrajectories: filtered.trajectories.length,
    redactionCount: filtered.redactionCount,
    anonymizationCount: filtered.anonymizationCount,
    datasetPaths: dataset.paths,
    perTaskCounts: dataset.counts,
    artifactPath: dispatchResult.artifactPath,
    dryRun: false,
    notes: dispatchResult.notes,
  };
  await recordRun(record);
  log.info(
    `[TrainingOrchestrator] ${runId} ${status} task=${task} backend=${backend} datasetSize=${datasetSize}`,
  );
  return record;
}
