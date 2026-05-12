import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Trajectory } from "@elizaos/agent";
import {
  applyPrivacyFilter,
  type FilterableTrajectory,
  type FilterResult,
  type PrivacyFilterOptions,
} from "./privacy-filter.js";
import {
  type HfUploadConfig,
  resolveHfUploadConfig,
  uploadTrajectoryJsonlToHuggingFace,
} from "./trajectory-hf-upload.js";
import {
  exportTrajectoryTaskDatasets,
  type TrajectoryTaskDatasetExport,
  type TrajectoryTrainingTask,
} from "./trajectory-task-datasets.js";

export const TRAJECTORY_EXPORT_BUNDLE_SCHEMA = "eliza_trajectory_export_bundle";
export const TRAJECTORY_EXPORT_BUNDLE_VERSION = 1;

type ExportableTrajectory = Trajectory & FilterableTrajectory;

export interface TrajectoryExportBundleSource {
  kind: string;
  runId?: string;
  runIds?: string[];
  metadata?: Record<string, unknown>;
}

export interface TrajectoryExportBundlePrivacyStats {
  applied: boolean;
  redactionCount: number | null;
  anonymizationCount: number | null;
  droppedCount: number;
  dropped: Array<{ trajectoryId?: string; reason: string }>;
}

export interface TrajectoryExportBundleTaskFile {
  path: string;
  exampleCount: number;
  sourceCallCount: number;
  sourceTrajectoryCount: number;
}

export interface TrajectoryExportBundleCloudUpload {
  uploadedToHuggingFace: boolean;
  huggingFaceRepo?: string;
  huggingFacePath?: string;
  huggingFaceError?: string;
}

export interface TrajectoryExportBundleManifest {
  schema: typeof TRAJECTORY_EXPORT_BUNDLE_SCHEMA;
  schemaVersion: typeof TRAJECTORY_EXPORT_BUNDLE_VERSION;
  generatedAt: string;
  runId: string | null;
  source: TrajectoryExportBundleSource & {
    inputTrajectoryCount: number;
    sanitizedTrajectoryCount: number;
    droppedTrajectoryCount: number;
  };
  paths: {
    bundleDir: string;
    manifestPath: string;
    rawJsonlPath?: string;
    sanitizedJsonlPath?: string;
    taskDatasetDir?: string;
    taskDatasetSummaryPath?: string;
  };
  counts: {
    rawTrajectoryRows: number;
    sanitizedTrajectoryRows: number;
    taskRows: Record<TrajectoryTrainingTask, number>;
    taskFiles: number;
    taskExamples: number;
    llmCalls: number | null;
    skippedNonNativeRows: number | null;
  };
  tasks: Partial<
    Record<TrajectoryTrainingTask, TrajectoryExportBundleTaskFile>
  >;
  privacy: TrajectoryExportBundlePrivacyStats;
  cloudUpload: TrajectoryExportBundleCloudUpload;
}

export interface TrajectoryExportBundle {
  outputDir: string;
  manifestPath: string;
  manifest: TrajectoryExportBundleManifest;
}

export interface BuildTrajectoryExportBundleOptions {
  outputDir: string;
  trajectories?: Trajectory[];
  sanitizedTrajectories?: Trajectory[];
  rawJsonlPath?: string;
  sanitizedJsonlPath?: string;
  includeRawJsonl?: boolean;
  tasks?: readonly TrajectoryTrainingTask[];
  source?: TrajectoryExportBundleSource;
  privacy?: {
    apply?: boolean;
    options?: PrivacyFilterOptions;
    stats?: TrajectoryExportBundlePrivacyStats;
  };
  /**
   * Upload the sanitized JSONL to a HuggingFace dataset repo. `true` resolves
   * the config from the environment (`ELIZA_TRAJECTORY_HF_REPO` + HF token);
   * pass an explicit `HfUploadConfig` to override. Defaults to no upload.
   */
  uploadToHuggingFace?: boolean | HfUploadConfig;
  now?: () => Date;
}

function taskPathMap(
  paths: TrajectoryTaskDatasetExport["paths"],
): Record<TrajectoryTrainingTask, string> {
  return {
    should_respond: paths.shouldRespondPath,
    context_routing: paths.contextRoutingPath,
    action_planner: paths.actionPlannerPath,
    response: paths.responsePath,
    media_description: paths.mediaDescriptionPath,
  };
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortJsonValue((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function jsonl(rows: readonly unknown[]): string {
  if (rows.length === 0) return "";
  return `${rows.map(stableJson).join("\n")}\n`;
}

function countJsonlRows(payload: string): number {
  return payload
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean).length;
}

function normalizePrivacyStats(
  privacyResult: FilterResult<ExportableTrajectory> | null,
  explicitStats: TrajectoryExportBundlePrivacyStats | undefined,
  applied: boolean,
): TrajectoryExportBundlePrivacyStats {
  if (explicitStats) {
    return explicitStats;
  }
  if (privacyResult) {
    return {
      applied: true,
      redactionCount: privacyResult.redactionCount,
      anonymizationCount: privacyResult.anonymizationCount,
      droppedCount: privacyResult.dropped.length,
      dropped: privacyResult.dropped,
    };
  }
  return {
    applied,
    redactionCount: null,
    anonymizationCount: null,
    droppedCount: 0,
    dropped: [],
  };
}

function buildTaskFiles(
  dataset: TrajectoryTaskDatasetExport | null,
): Partial<Record<TrajectoryTrainingTask, TrajectoryExportBundleTaskFile>> {
  if (!dataset) return {};
  const pathsByTask = taskPathMap(dataset.paths);
  const tasks: Partial<
    Record<TrajectoryTrainingTask, TrajectoryExportBundleTaskFile>
  > = {};
  for (const task of dataset.summary.tasks) {
    const metrics = dataset.summary.taskMetrics[task];
    tasks[task] = {
      path: pathsByTask[task],
      exampleCount: metrics.exampleCount,
      sourceCallCount: metrics.sourceCallCount,
      sourceTrajectoryCount: metrics.sourceTrajectoryCount,
    };
  }
  return tasks;
}

function emptyTaskCounts(): Record<TrajectoryTrainingTask, number> {
  return {
    should_respond: 0,
    context_routing: 0,
    action_planner: 0,
    response: 0,
    media_description: 0,
  };
}

function normalizeRunId(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function addRunId(runIds: Set<string>, value: unknown): void {
  const runId = normalizeRunId(value);
  if (runId) runIds.add(runId);
}

function collectTrajectoryRunIds(
  trajectories: readonly Trajectory[],
): string[] {
  const runIds = new Set<string>();
  for (const trajectory of trajectories) {
    const record = trajectory as Trajectory & {
      runId?: unknown;
      metadata?: Record<string, unknown>;
    };
    addRunId(runIds, record.runId);
    addRunId(runIds, record.metadata?.runId);
    addRunId(runIds, record.metadata?.appRunId);

    for (const step of trajectory.steps ?? []) {
      for (const call of step.llmCalls ?? []) {
        addRunId(runIds, call.runId);
      }
      for (const access of step.providerAccesses ?? []) {
        addRunId(runIds, access.runId);
      }
    }
  }
  return [...runIds].sort();
}

function resolveBundleRunIds(
  source: TrajectoryExportBundleSource | undefined,
  trajectories: readonly Trajectory[],
): { runId: string | null; runIds: string[] } {
  const runIds = new Set<string>(collectTrajectoryRunIds(trajectories));
  addRunId(runIds, source?.runId);
  for (const runId of source?.runIds ?? []) {
    addRunId(runIds, runId);
  }

  const sorted = [...runIds].sort();
  const explicitRunId = normalizeRunId(source?.runId);
  return {
    runId: explicitRunId ?? (sorted.length === 1 ? sorted[0] : null),
    runIds: sorted,
  };
}

export async function buildTrajectoryExportBundle(
  options: BuildTrajectoryExportBundleOptions,
): Promise<TrajectoryExportBundle> {
  await mkdir(options.outputDir, { recursive: true });

  const inputTrajectories = options.trajectories ?? [];
  const exportableTrajectories = inputTrajectories as ExportableTrajectory[];
  const hasPreSanitizedInput =
    options.sanitizedTrajectories !== undefined ||
    options.sanitizedJsonlPath !== undefined;
  const shouldApplyPrivacy = options.privacy?.apply ?? !hasPreSanitizedInput;
  const privacyResult =
    shouldApplyPrivacy && exportableTrajectories.length > 0
      ? applyPrivacyFilter(exportableTrajectories, options.privacy?.options)
      : null;
  const sanitizedTrajectories =
    options.sanitizedTrajectories ??
    (privacyResult?.trajectories as Trajectory[] | undefined) ??
    [];
  const privacy = normalizePrivacyStats(
    privacyResult,
    options.privacy?.stats,
    shouldApplyPrivacy,
  );

  let rawTrajectoryRows = 0;
  let rawJsonlPath: string | undefined;
  if (options.includeRawJsonl) {
    await mkdir(join(options.outputDir, "raw"), { recursive: true });
    rawJsonlPath = join(options.outputDir, "raw", "trajectories.raw.jsonl");
    if (options.rawJsonlPath) {
      await copyFile(options.rawJsonlPath, rawJsonlPath);
      rawTrajectoryRows = countJsonlRows(await readFile(rawJsonlPath, "utf8"));
    } else {
      await writeFile(rawJsonlPath, jsonl(inputTrajectories));
      rawTrajectoryRows = inputTrajectories.length;
    }
  }

  let sanitizedTrajectoryRows = sanitizedTrajectories.length;
  let sanitizedJsonlPath: string | undefined;
  let sanitizedJsonlText: string | null = null;
  if (options.sanitizedJsonlPath) {
    await mkdir(join(options.outputDir, "sanitized"), { recursive: true });
    sanitizedJsonlPath = join(
      options.outputDir,
      "sanitized",
      "trajectories.sanitized.jsonl",
    );
    await copyFile(options.sanitizedJsonlPath, sanitizedJsonlPath);
    sanitizedJsonlText = await readFile(sanitizedJsonlPath, "utf8");
    sanitizedTrajectoryRows = countJsonlRows(sanitizedJsonlText);
  } else if (sanitizedTrajectories.length > 0 || inputTrajectories.length > 0) {
    await mkdir(join(options.outputDir, "sanitized"), { recursive: true });
    sanitizedJsonlPath = join(
      options.outputDir,
      "sanitized",
      "trajectories.sanitized.jsonl",
    );
    sanitizedJsonlText = jsonl(sanitizedTrajectories);
    await writeFile(sanitizedJsonlPath, sanitizedJsonlText);
  }

  // Upload the sanitized JSONL to HuggingFace when requested. The privacy
  // filter has already run above — this only ever touches the sanitized file.
  let cloudUpload: TrajectoryExportBundleCloudUpload = {
    uploadedToHuggingFace: false,
  };
  if (options.uploadToHuggingFace && sanitizedJsonlPath) {
    const uploadConfig =
      options.uploadToHuggingFace === true
        ? resolveHfUploadConfig()
        : options.uploadToHuggingFace;
    if (uploadConfig) {
      const pathInRepo = `trajectories/${(options.now?.() ?? new Date())
        .toISOString()
        .replace(/[:.]/g, "-")}.jsonl`;
      const uploadResult = await uploadTrajectoryJsonlToHuggingFace(
        sanitizedJsonlPath,
        pathInRepo,
        uploadConfig,
      );
      cloudUpload = {
        uploadedToHuggingFace: uploadResult.uploaded,
        huggingFaceRepo: uploadResult.repo ?? undefined,
        huggingFacePath: uploadResult.pathInRepo ?? undefined,
        huggingFaceError: uploadResult.error ?? undefined,
      };
    } else {
      cloudUpload = {
        uploadedToHuggingFace: false,
        huggingFaceError:
          "HuggingFace upload requested but not configured (set ELIZA_TRAJECTORY_HF_REPO and an HF token)",
      };
    }
  }

  let taskDataset: TrajectoryTaskDatasetExport | null = null;
  if (sanitizedJsonlText !== null || sanitizedTrajectories.length > 0) {
    const taskDatasetDir = join(options.outputDir, "tasks");
    taskDataset = await exportTrajectoryTaskDatasets(
      sanitizedJsonlText !== null && options.sanitizedJsonlPath
        ? sanitizedJsonlText
        : sanitizedTrajectories,
      taskDatasetDir,
      options.tasks,
    );
  }

  const taskFiles = buildTaskFiles(taskDataset);
  const taskExamples = Object.values(taskFiles).reduce(
    (sum, task) => sum + task.exampleCount,
    0,
  );
  const taskCounts = taskDataset?.counts ?? emptyTaskCounts();
  const manifestPath = join(options.outputDir, "manifest.json");
  const generatedAt = (options.now?.() ?? new Date()).toISOString();
  const runLineage = resolveBundleRunIds(options.source, [
    ...inputTrajectories,
    ...sanitizedTrajectories,
  ]);
  const manifest: TrajectoryExportBundleManifest = {
    schema: TRAJECTORY_EXPORT_BUNDLE_SCHEMA,
    schemaVersion: TRAJECTORY_EXPORT_BUNDLE_VERSION,
    generatedAt,
    runId: runLineage.runId,
    source: {
      kind: options.source?.kind ?? "trajectory-export-bundle",
      runId: runLineage.runId ?? undefined,
      runIds: runLineage.runIds,
      inputTrajectoryCount: inputTrajectories.length || rawTrajectoryRows,
      sanitizedTrajectoryCount: sanitizedTrajectoryRows,
      droppedTrajectoryCount: privacy.droppedCount,
      metadata: options.source?.metadata
        ? (sortJsonValue(options.source.metadata) as Record<string, unknown>)
        : undefined,
    },
    paths: {
      bundleDir: options.outputDir,
      manifestPath,
      rawJsonlPath,
      sanitizedJsonlPath,
      taskDatasetDir: taskDataset
        ? join(options.outputDir, "tasks")
        : undefined,
      taskDatasetSummaryPath: taskDataset?.paths.summaryPath,
    },
    counts: {
      rawTrajectoryRows,
      sanitizedTrajectoryRows,
      taskRows: taskCounts,
      taskFiles: Object.keys(taskFiles).length,
      taskExamples,
      llmCalls: taskDataset?.summary.llmCallCount ?? null,
      skippedNonNativeRows: taskDataset?.summary.skippedNonNativeRows ?? null,
    },
    tasks: taskFiles,
    privacy,
    cloudUpload,
  };

  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  return {
    outputDir: options.outputDir,
    manifestPath,
    manifest,
  };
}
