/**
 * Nightly trajectory → training-dataset export cron.
 *
 * Pulls recent trajectories from the runtime's trajectory service, runs them
 * through the privacy filter, then bucketizes them into per-task JSONL files
 * under `<state>/training/datasets/<YYYY-MM-DD>/`.
 *
 * Privacy filter is REQUIRED and runs on every export — both for disk writes
 * and any subsequent cloud upload.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Trajectory } from "@elizaos/agent";
import { resolveStateDir } from "@elizaos/core";
import {
  type CronServiceLike,
  ensureNamedCronJob,
  registerRuntimeEventOnce,
} from "./ensure-cron-job.js";
import {
  type AnonymizerLookup,
  applyPrivacyFilter,
  createHashAnonymizer,
  type FilterableTrajectory,
} from "./privacy-filter.js";
import {
  type HfUploadResult,
  resolveHfUploadConfig,
  uploadTrajectoryJsonlToHuggingFace,
} from "./trajectory-hf-upload.js";
import {
  exportTrajectoryTaskDatasets,
  type TrajectoryTaskDatasetExport,
} from "./trajectory-task-datasets.js";
import { waitForService } from "./wait-for-service.js";

const EXPORT_EVENT_NAME = "TRACK_C_TRAJECTORY_EXPORT";
const DEFAULT_TRAJECTORY_LIMIT = 500;

interface MinimalLogger {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
  debug: (message: string) => void;
}

interface RuntimeLike {
  getService: (name: string) => unknown;
  logger?: MinimalLogger;
  registerEvent?: (
    name: string,
    handler: (payload: unknown) => Promise<void>,
  ) => void;
}

interface TrajectoryServiceLike {
  listTrajectories: (options: {
    limit?: number;
  }) => Promise<{ trajectories: Array<{ id: string }> }>;
  getTrajectoryDetail: (id: string) => Promise<ExportableTrajectory | null>;
}

type ExportableTrajectory = Trajectory & FilterableTrajectory;

function todaySegment(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export interface RunNightlyExportOptions {
  trajectoryLimit?: number;
  outputRoot?: string;
  anonymizer?: AnonymizerLookup;
  now?: () => Date;
}

export interface NightlyExportReport {
  outputDir: string;
  pulledTrajectories: number;
  keptTrajectories: number;
  droppedTrajectories: number;
  redactionCount: number;
  anonymizationCount: number;
  exportSummary: TrajectoryTaskDatasetExport["summary"];
  exportPaths: TrajectoryTaskDatasetExport["paths"];
  /** Path to the single consolidated sanitized JSONL written alongside the per-task files. */
  sanitizedJsonlPath: string;
  /** Outcome of the HuggingFace upload, when configured. `null` when HF is not configured. */
  huggingFaceUpload: HfUploadResult | null;
}

export async function runNightlyTrajectoryExport(
  runtime: RuntimeLike,
  options: RunNightlyExportOptions = {},
): Promise<NightlyExportReport | null> {
  const log: MinimalLogger = runtime.logger ?? {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };
  const trajectoryService = runtime.getService(
    "trajectories",
  ) as TrajectoryServiceLike | null;
  if (
    !trajectoryService ||
    typeof trajectoryService.listTrajectories !== "function" ||
    typeof trajectoryService.getTrajectoryDetail !== "function"
  ) {
    log.warn("[TrajectoryExportCron] trajectories service unavailable");
    return null;
  }

  const limit = options.trajectoryLimit ?? DEFAULT_TRAJECTORY_LIMIT;
  const list = await trajectoryService.listTrajectories({ limit });
  const trajectories: ExportableTrajectory[] = [];
  for (const item of list.trajectories ?? []) {
    const detail = await trajectoryService.getTrajectoryDetail(item.id);
    if (detail) trajectories.push(detail);
  }

  // Privacy filter is REQUIRED here — the downstream export writes JSONL
  // datasets to disk (and may upload them), and they must not contain raw
  // user secrets or un-anonymized handles. The filter runs before any write
  // path below. The default anonymizer maps handles to stable opaque ids.
  const filtered = applyPrivacyFilter(trajectories, {
    anonymizer: options.anonymizer ?? createHashAnonymizer(),
  });

  const stateDir = options.outputRoot ?? resolveStateDir();
  const outputDir = join(stateDir, "training", "datasets", todaySegment());
  await mkdir(outputDir, { recursive: true });

  // privacy filter applied above
  const summary = await exportTrajectoryTaskDatasets(
    filtered.trajectories,
    outputDir,
  );

  // Single consolidated sanitized JSONL — the artifact uploaded to HuggingFace.
  const sanitizedJsonlPath = join(outputDir, "trajectories.sanitized.jsonl");
  const sanitizedJsonl =
    filtered.trajectories.length === 0
      ? ""
      : `${filtered.trajectories
          .map((trajectory) => JSON.stringify(trajectory))
          .join("\n")}\n`;
  await writeFile(sanitizedJsonlPath, sanitizedJsonl);

  let huggingFaceUpload: HfUploadResult | null = null;
  const hfConfig = resolveHfUploadConfig();
  if (hfConfig) {
    const pathInRepo = `trajectories/${todaySegment()}.jsonl`;
    huggingFaceUpload = await uploadTrajectoryJsonlToHuggingFace(
      sanitizedJsonlPath,
      pathInRepo,
      hfConfig,
    );
    log.info(
      huggingFaceUpload.uploaded
        ? `[TrajectoryExportCron] uploaded sanitized trajectories to ${hfConfig.repo}/${pathInRepo}`
        : `[TrajectoryExportCron] HuggingFace upload skipped: ${huggingFaceUpload.error ?? "unknown"}`,
    );
  }

  log.info(
    `[TrajectoryExportCron] exported ${filtered.trajectories.length} trajectories to ${outputDir} (dropped ${filtered.dropped.length}, redacted ${filtered.redactionCount}, anonymized ${filtered.anonymizationCount})`,
  );

  return {
    outputDir,
    pulledTrajectories: trajectories.length,
    keptTrajectories: filtered.trajectories.length,
    droppedTrajectories: filtered.dropped.length,
    redactionCount: filtered.redactionCount,
    anonymizationCount: filtered.anonymizationCount,
    exportSummary: summary.summary,
    exportPaths: summary.paths,
    sanitizedJsonlPath,
    huggingFaceUpload,
  };
}

/**
 * Register the nightly trajectory-export job against the agent runtime.
 * Schedule defaults to "0 3 * * *" (03:00 local) so the skill-scoring cron
 * registered at "5 3 * * *" runs after fresh data has landed.
 */
export async function registerTrajectoryExportCron(
  runtime: RuntimeLike,
  options?: { schedule?: string; tz?: string; anonymizer?: AnonymizerLookup },
): Promise<void> {
  const log: MinimalLogger = runtime.logger ?? {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };
  const cronService = await waitForService<CronServiceLike>(runtime, "CRON", {
    timeoutMs: 2_000,
  });
  if (!cronService || typeof cronService.createJob !== "function") {
    log.debug(
      `[TrajectoryExportCron] CRON service not registered; cron not scheduled (run on-demand via ${EXPORT_EVENT_NAME} event)`,
    );
    return;
  }
  registerRuntimeEventOnce(runtime, EXPORT_EVENT_NAME, async () => {
    await runNightlyTrajectoryExport(runtime, {
      anonymizer: options?.anonymizer,
    });
  });
  const registration = await ensureNamedCronJob(
    cronService,
    {
      name: "track-c-trajectory-export-nightly",
      description:
        "Nightly export of trajectories into per-task JSONL training datasets",
      enabled: true,
      schedule: {
        kind: "cron",
        expr: options?.schedule ?? "0 3 * * *",
        tz: options?.tz,
      },
      payload: { kind: "event", eventName: EXPORT_EVENT_NAME },
      metadata: { trackC: true, kind: "trajectory-export" },
    },
    { log, logPrefix: "[TrajectoryExportCron]" },
  );
  log.info(
    registration === "created"
      ? "[TrajectoryExportCron] registered nightly trajectory-export cron"
      : "[TrajectoryExportCron] using existing nightly trajectory-export cron",
  );
}
