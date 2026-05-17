import { MODEL_CATALOG } from "./catalog";
import { catalogDownloadSizeBytes } from "./recommendation";
import type {
  ActiveModelState,
  CatalogModel,
  DownloadJob,
  DownloadState,
  InstalledModel,
  LocalInferenceDownloadStatus,
  LocalInferenceReadiness,
  LocalInferenceSlotReadiness,
  ModelAssignments,
  TextGenerationSlot,
} from "./types";

const TERMINAL_STATES = new Set<DownloadState>([
  "completed",
  "failed",
  "cancelled",
]);

function catalogById(catalog: CatalogModel[]): Map<string, CatalogModel> {
  return new Map(catalog.map((model) => [model.id, model]));
}

function installedById(
  installed: InstalledModel[],
): Map<string, InstalledModel> {
  return new Map(installed.map((model) => [model.id, model]));
}

function latestJobByModel(downloads: DownloadJob[]): Map<string, DownloadJob> {
  const jobs = new Map<string, DownloadJob>();
  for (const job of downloads) {
    const current = jobs.get(job.modelId);
    if (!current || job.updatedAt.localeCompare(current.updatedAt) > 0) {
      jobs.set(job.modelId, job);
    }
  }
  return jobs;
}

function requiredModelIds(
  assignedModelId: string,
  catalog: Map<string, CatalogModel>,
): string[] {
  const model = catalog.get(assignedModelId);
  return [assignedModelId, ...(model?.companionModelIds ?? [])];
}

function statusFromJobs(
  jobs: DownloadJob[],
  missingModelIds: string[],
): LocalInferenceDownloadStatus {
  const activeJobs = jobs.filter(
    (job) => job.state === "queued" || job.state === "downloading",
  );
  const terminalJobs = jobs.filter((job) => TERMINAL_STATES.has(job.state));
  const relevantJobs = activeJobs.length > 0 ? activeJobs : terminalJobs;
  const state =
    relevantJobs.find((job) => job.state === "failed")?.state ??
    relevantJobs.find((job) => job.state === "cancelled")?.state ??
    relevantJobs.find((job) => job.state === "downloading")?.state ??
    relevantJobs.find((job) => job.state === "queued")?.state ??
    relevantJobs.find((job) => job.state === "completed")?.state ??
    (missingModelIds.length > 0 ? "missing" : "completed");
  const receivedBytes = relevantJobs.reduce(
    (total, job) => total + job.received,
    0,
  );
  const totalBytes = relevantJobs.reduce((total, job) => total + job.total, 0);
  const bytesPerSec = activeJobs.reduce(
    (total, job) => total + job.bytesPerSec,
    0,
  );
  const etaValues = activeJobs
    .map((job) => job.etaMs)
    .filter((etaMs): etaMs is number => etaMs !== null);
  const etaMs =
    etaValues.length > 0
      ? Math.max(...etaValues)
      : (relevantJobs[0]?.etaMs ?? null);
  const updatedAt =
    relevantJobs
      .map((job) => job.updatedAt)
      .sort((left, right) => right.localeCompare(left))[0] ?? null;
  const errors = relevantJobs.flatMap((job) => (job.error ? [job.error] : []));
  return {
    state,
    receivedBytes,
    totalBytes,
    percent:
      totalBytes > 0
        ? Math.max(
            0,
            Math.min(100, Math.round((receivedBytes / totalBytes) * 1000) / 10),
          )
        : null,
    bytesPerSec,
    etaMs,
    updatedAt,
    errors,
  };
}

function slotReadiness(
  slot: TextGenerationSlot,
  assignments: ModelAssignments,
  installed: Map<string, InstalledModel>,
  catalog: Map<string, CatalogModel>,
  catalogList: CatalogModel[],
  downloads: Map<string, DownloadJob>,
  active: ActiveModelState,
): LocalInferenceSlotReadiness {
  const assignedModelId = assignments[slot] ?? null;
  if (!assignedModelId) {
    return {
      slot,
      assigned: false,
      assignedModelId: null,
      displayName: null,
      primaryDownloaded: false,
      downloaded: false,
      active: false,
      ready: false,
      state: "unassigned",
      requiredModelIds: [],
      missingModelIds: [],
      installedBytes: 0,
      expectedBytes: 0,
      download: {
        state: "missing",
        receivedBytes: 0,
        totalBytes: 0,
        percent: null,
        bytesPerSec: 0,
        etaMs: null,
        updatedAt: null,
        errors: [],
      },
      errors: [],
    };
  }

  const ids = requiredModelIds(assignedModelId, catalog);
  const missingModelIds = ids.filter((id) => !installed.has(id));
  const primaryDownloaded = installed.has(assignedModelId);
  const downloaded = missingModelIds.length === 0;
  const activeReady =
    active.modelId === assignedModelId && active.status === "ready";
  const model = catalog.get(assignedModelId);
  const jobs = ids.flatMap((id) => {
    const job = downloads.get(id);
    return job ? [job] : [];
  });
  const download = statusFromJobs(jobs, missingModelIds);
  const activeError =
    active.modelId === assignedModelId &&
    active.status === "error" &&
    active.error
      ? [active.error]
      : [];
  const errors = [...download.errors, ...activeError];
  const hasActiveJob = jobs.some(
    (job) => job.state === "queued" || job.state === "downloading",
  );
  const terminalFailure = jobs.find(
    (job) => job.state === "failed" || job.state === "cancelled",
  );

  return {
    slot,
    assigned: true,
    assignedModelId,
    displayName:
      model?.displayName ?? installed.get(assignedModelId)?.displayName ?? null,
    primaryDownloaded,
    downloaded,
    active: activeReady,
    ready: downloaded && activeReady,
    state: terminalFailure
      ? terminalFailure.state === "failed"
        ? "failed"
        : "cancelled"
      : hasActiveJob
        ? "downloading"
        : activeReady
          ? "active"
          : downloaded
            ? "downloaded"
            : "missing",
    requiredModelIds: ids,
    missingModelIds,
    installedBytes: ids.reduce(
      (total, id) => total + (installed.get(id)?.sizeBytes ?? 0),
      0,
    ),
    expectedBytes: model ? catalogDownloadSizeBytes(model, catalogList) : 0,
    download,
    errors,
  };
}

export function buildTextGenerationReadiness(input: {
  assignments: ModelAssignments;
  installed: InstalledModel[];
  active: ActiveModelState;
  downloads: DownloadJob[];
  catalog?: CatalogModel[];
}): LocalInferenceReadiness {
  const catalogList = input.catalog ?? MODEL_CATALOG;
  const catalog = catalogById(catalogList);
  const installed = installedById(input.installed);
  const downloads = latestJobByModel(input.downloads);
  return {
    updatedAt: new Date().toISOString(),
    slots: {
      TEXT_SMALL: slotReadiness(
        "TEXT_SMALL",
        input.assignments,
        installed,
        catalog,
        catalogList,
        downloads,
        input.active,
      ),
      TEXT_LARGE: slotReadiness(
        "TEXT_LARGE",
        input.assignments,
        installed,
        catalog,
        catalogList,
        downloads,
        input.active,
      ),
    },
  };
}
