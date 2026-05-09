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
 *      (`atropos` | `tinker` | `native`).
 *   5. Persist a run record at `<state>/training/runs/<runId>.json`.
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Trajectory } from "@elizaos/agent";
import {
  type AnonymizerLookup,
  applyPrivacyFilter,
  type FilterableTrajectory,
} from "./privacy-filter.js";
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

function baselinePlaceholder(task: TrajectoryTrainingTask): string {
  return `# baseline placeholder for ${task}`;
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

function firstStringExport(
  promptModule: Record<string, unknown>,
  names: readonly string[],
): string | null {
  for (const name of names) {
    const value = promptModule[name];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return null;
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
    case "atropos": {
      const { runAtroposBackend } = await import("../backends/atropos.js");
      const result = await runAtroposBackend({
        datasetPath: input.datasetPath,
        task: input.task,
      });
      return {
        invoked: result.invoked,
        artifactPath: result.stagedPath,
        notes: result.invoked
          ? [`atropos exited with code ${result.exitCode ?? 0}`]
          : ["atropos CLI not configured (set ATROPOS_BIN to invoke)"],
      };
    }
    case "tinker": {
      const { runTinkerBackend } = await import("../backends/tinker.js");
      const result = await runTinkerBackend({
        datasetPath: input.datasetPath,
        task: input.task,
      });
      return {
        invoked: result.invoked,
        artifactPath: result.jobId,
        notes: result.notes,
      };
    }
    case "native": {
      const { runNativeBackend } = await import("../backends/native.js");
      const useModelHandler = extractUseModel(input.runtime);
      if (!useModelHandler) {
        return {
          invoked: false,
          notes: [
            "native backend requires a runtime exposing useModel; skipped",
          ],
        };
      }
      const baselinePrompt = await loadBaselineForTask(input.task);
      const result = await runNativeBackend({
        datasetPath: input.datasetPath,
        task: input.task,
        optimizer: "instruction-search",
        baselinePrompt,
        runtime: { useModel: useModelHandler },
      });
      const notes = [...result.notes];
      let artifactPath: string | undefined;
      if (result.invoked) {
        const writePath = await persistOptimizedPromptArtifact(input.runtime, {
          task: input.task,
          optimizer: result.optimizer,
          baseline: baselinePrompt,
          prompt: result.result.optimizedPrompt,
          score: result.score,
          baselineScore: result.baselineScore,
          datasetId: input.datasetPath,
          datasetSize: result.datasetSize,
          generatedAt: new Date().toISOString(),
          lineage: result.result.lineage,
          fewShotExamples: result.result.fewShotExamples,
        });
        artifactPath = writePath ?? undefined;
        if (writePath) notes.push(`artifact written to ${writePath}`);
        else
          notes.push(
            "OptimizedPromptService unavailable; artifact not persisted",
          );
      }
      return {
        invoked: result.invoked,
        artifactPath,
        notes,
      };
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

function extractUseModel(runtime: RuntimeLike): UseModelLike | null {
  const candidate = runtime as RuntimeLike & UseModelRuntime;
  if (typeof candidate.useModel !== "function") return null;
  return async (input) => {
    // We always route native calls through TEXT_LARGE because the optimizers
    // need high-quality rewrites. The hardcoding mirrors how trajectory
    // teachers resolve the model — the operator can pin a different provider
    // by overriding the runtime's TEXT_LARGE handler.
    return await candidate.useModel?.("TEXT_LARGE", input);
  };
}

interface OptimizedPromptArtifactInput {
  task: TrajectoryTrainingTask;
  optimizer: "instruction-search" | "prompt-evolution" | "bootstrap-fewshot";
  baseline: string;
  prompt: string;
  score: number;
  baselineScore: number;
  datasetId: string;
  datasetSize: number;
  generatedAt: string;
  lineage: Array<{
    round: number;
    variant: number;
    score: number;
    notes?: string;
  }>;
  fewShotExamples?: Array<{
    id?: string;
    input: { user: string; system?: string };
    expectedOutput: string;
    reward?: number;
    metadata?: Record<string, unknown>;
  }>;
}

interface OptimizedPromptServiceLike {
  setPrompt: (
    task: TrajectoryTrainingTask,
    artifact: OptimizedPromptArtifactInput,
  ) => Promise<string>;
}

async function persistOptimizedPromptArtifact(
  runtime: RuntimeLike,
  artifact: OptimizedPromptArtifactInput,
): Promise<string | null> {
  const service = runtime.getService(
    "optimized_prompt",
  ) as OptimizedPromptServiceLike | null;
  if (!service || typeof service.setPrompt !== "function") return null;
  return await service.setPrompt(artifact.task, artifact);
}

/**
 * Pull the live runtime template for the task. Falls back to the v5 planner
 * baseline for action-planner training, or a generic placeholder for other
 * tasks when the runtime cannot expose its template.
 */
async function loadBaselineForTask(
  task: TrajectoryTrainingTask,
): Promise<string> {
  const prompts = await import("@elizaos/core").catch(() => null);
  if (!prompts) {
    return task === "action_planner"
      ? PLANNER_BASELINE
      : baselinePlaceholder(task);
  }
  const promptModule = prompts as Record<string, unknown>;
  switch (task) {
    case "should_respond":
    case "context_routing":
      return (
        firstStringExport(promptModule, [
          "shouldRespondTemplate",
          "messageHandlerTemplate",
        ]) ?? baselinePlaceholder(task)
      );
    case "response":
      return (
        firstStringExport(promptModule, [
          "messageHandlerTemplate",
          "replyTemplate",
        ]) ?? baselinePlaceholder(task)
      );
    case "action_planner":
      return (
        firstStringExport(promptModule, [
          "plannerTemplate",
          "plannerTemplate",
        ]) ?? PLANNER_BASELINE
      );
    case "media_description":
      return (
        firstStringExport(promptModule, ["imageDescriptionTemplate"]) ??
        baselinePlaceholder(task)
      );
  }
}

export async function recordRun(record: TrainingRunRecord): Promise<string> {
  const dir = runsDir();
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${record.runId}.json`);
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, "utf-8");
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
  for (const item of list.trajectories ?? []) {
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
    filtered.trajectories as unknown as Parameters<
      typeof exportTrajectoryTaskDatasets
    >[0],
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
