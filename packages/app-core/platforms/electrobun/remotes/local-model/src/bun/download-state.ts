/** Implements Electrobun local-model remote download state ts boundaries for desktop app-core. */
import type {
  LocalModelDownloadJob,
  LocalModelDownloadState,
} from "./protocol.ts";

export class DownloadStateTracker {
  private readonly jobs = new Map<string, LocalModelDownloadJob>();

  merge(input: unknown): LocalModelDownloadJob[] {
    const jobs = normalizeDownloadJobs(input);
    for (const job of jobs) this.jobs.set(job.jobId, job);
    return this.snapshot();
  }

  upsert(input: unknown): LocalModelDownloadJob {
    const job = normalizeDownloadJob(input);
    this.jobs.set(job.jobId, job);
    return job;
  }

  cancel(modelId: string): { cancelled: boolean } {
    for (const job of this.jobs.values()) {
      if (job.modelId !== modelId) continue;
      this.jobs.set(job.jobId, {
        ...job,
        state: "cancelled",
        updatedAt: new Date().toISOString(),
      });
      return { cancelled: true };
    }
    return { cancelled: false };
  }

  snapshot(): LocalModelDownloadJob[] {
    return [...this.jobs.values()].sort((a, b) =>
      (a.startedAt ?? "").localeCompare(b.startedAt ?? ""),
    );
  }
}

export function normalizeDownloadJobs(value: unknown): LocalModelDownloadJob[] {
  if (Array.isArray(value))
    return value.map((item) => normalizeDownloadJob(item));
  if (isRecord(value) && Array.isArray(value.downloads)) {
    return value.downloads.map((item) => normalizeDownloadJob(item));
  }
  if (isRecord(value) && isRecord(value.job))
    return [normalizeDownloadJob(value.job)];
  return [];
}

export function normalizeDownloadJob(value: unknown): LocalModelDownloadJob {
  if (!isRecord(value)) {
    return {
      jobId: `unknown-${Date.now()}`,
      modelId: "unknown",
      state: "unknown",
      raw: value,
    };
  }
  const modelId =
    stringField(value, "modelId") ?? stringField(value, "id") ?? "unknown";
  const jobId = stringField(value, "jobId") ?? modelId;
  return {
    jobId,
    modelId,
    state: normalizeState(value.state),
    received: numberField(value, "received"),
    total: numberField(value, "total"),
    bytesPerSec: numberField(value, "bytesPerSec"),
    etaMs:
      typeof value.etaMs === "number" || value.etaMs === null
        ? value.etaMs
        : undefined,
    startedAt: stringField(value, "startedAt"),
    updatedAt: stringField(value, "updatedAt"),
    error: stringField(value, "error"),
    raw: value,
  };
}

function normalizeState(value: unknown): LocalModelDownloadState {
  switch (value) {
    case "queued":
    case "downloading":
    case "completed":
    case "failed":
    case "cancelled":
      return value;
    default:
      return "unknown";
  }
}

function stringField(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const field = value[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

function numberField(
  value: Record<string, unknown>,
  key: string,
): number | undefined {
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field)
    ? field
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
