/**
 * Vast.ai training job + inference-stats persistence.
 *
 * Mirrors the in-memory + JSONL pattern used elsewhere in this app:
 * `TrainingService` keeps records in process memory, while we additionally
 * append every state transition to a JSONL log so jobs survive restarts.
 *
 * Storage layout (under `resolveStateDir()`):
 *   ~/.milady/training-vast/jobs.jsonl       — append-only job event log.
 *   ~/.milady/training-vast/logs/<id>.log    — per-job stdout/stderr tail.
 *
 * The inference-stats reader points at `~/.milady/inference-stats.jsonl`,
 * the path the inference side writes to (overridable via env).
 */

import { existsSync, promises as fs, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveStateDir } from "@elizaos/core";

export type VastJobStatus =
  | "queued"
  | "provisioning"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface VastJobRecord {
  job_id: string;
  run_name: string;
  registry_key: string;
  status: VastJobStatus;
  epochs: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  ended_at: string | null;
  vast_instance_id: string | null;
  exit_code: number | null;
  error: string | null;
}

export interface VastJobUpdate {
  status?: VastJobStatus;
  vast_instance_id?: string | null;
  exit_code?: number | null;
  error?: string | null;
  started_at?: string | null;
  ended_at?: string | null;
}

const VAST_DIR_NAME = "training-vast";
const JOBS_LOG_NAME = "jobs.jsonl";
const LOGS_SUBDIR = "logs";

function vastRoot(): string {
  return join(resolveStateDir(), VAST_DIR_NAME);
}

function jobsLogPath(): string {
  return join(vastRoot(), JOBS_LOG_NAME);
}

export function jobLogPath(jobId: string): string {
  return join(vastRoot(), LOGS_SUBDIR, `${jobId}.log`);
}

export function inferenceStatsPath(): string {
  const override = process.env.MILADY_INFERENCE_STATS_PATH;
  if (override?.trim()) return override.trim();
  return join(resolveStateDir(), "inference-stats.jsonl");
}

function ensureDir(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
}

/**
 * Append-only job store. The cache is the source of truth at runtime;
 * the JSONL file is the durability log we replay on first read.
 */
export class VastJobStore {
  private cache: Map<string, VastJobRecord> | null = null;
  private hydratePromise: Promise<void> | null = null;

  async list(): Promise<VastJobRecord[]> {
    const cache = await this.ensureHydrated();
    return Array.from(cache.values()).sort((a, b) =>
      b.created_at.localeCompare(a.created_at),
    );
  }

  async get(jobId: string): Promise<VastJobRecord | null> {
    const cache = await this.ensureHydrated();
    return cache.get(jobId) ?? null;
  }

  async insert(record: VastJobRecord): Promise<VastJobRecord> {
    const cache = await this.ensureHydrated();
    if (cache.has(record.job_id)) {
      throw new Error(`Job ${record.job_id} already exists`);
    }
    cache.set(record.job_id, record);
    await this.appendEvent(record);
    return record;
  }

  async update(jobId: string, patch: VastJobUpdate): Promise<VastJobRecord> {
    const cache = await this.ensureHydrated();
    const existing = cache.get(jobId);
    if (!existing) throw new Error(`Job ${jobId} not found`);
    const next: VastJobRecord = {
      ...existing,
      ...patch,
      vast_instance_id:
        patch.vast_instance_id !== undefined
          ? patch.vast_instance_id
          : existing.vast_instance_id,
      exit_code:
        patch.exit_code !== undefined ? patch.exit_code : existing.exit_code,
      error: patch.error !== undefined ? patch.error : existing.error,
      started_at:
        patch.started_at !== undefined ? patch.started_at : existing.started_at,
      ended_at:
        patch.ended_at !== undefined ? patch.ended_at : existing.ended_at,
      updated_at: new Date().toISOString(),
    };
    cache.set(jobId, next);
    await this.appendEvent(next);
    return next;
  }

  /** Test-only: drop in-memory cache so the next read re-hydrates from disk. */
  resetCacheForTests(): void {
    this.cache = null;
    this.hydratePromise = null;
  }

  private async ensureHydrated(): Promise<Map<string, VastJobRecord>> {
    if (this.cache) return this.cache;
    if (!this.hydratePromise) {
      this.hydratePromise = this.hydrate();
    }
    await this.hydratePromise;
    if (!this.cache) {
      throw new Error("VastJobStore failed to hydrate");
    }
    return this.cache;
  }

  private async hydrate(): Promise<void> {
    const cache = new Map<string, VastJobRecord>();
    const path = jobsLogPath();
    if (!existsSync(path)) {
      this.cache = cache;
      return;
    }
    const raw = await fs.readFile(path, "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parsed = parseJobRecord(trimmed);
      if (parsed) cache.set(parsed.job_id, parsed);
    }
    this.cache = cache;
  }

  private async appendEvent(record: VastJobRecord): Promise<void> {
    const path = jobsLogPath();
    ensureDir(dirname(path));
    await fs.appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
  }
}

function parseJobRecord(line: string): VastJobRecord | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (
    typeof obj.job_id !== "string" ||
    typeof obj.run_name !== "string" ||
    typeof obj.registry_key !== "string" ||
    typeof obj.status !== "string" ||
    typeof obj.epochs !== "number" ||
    typeof obj.created_at !== "string" ||
    typeof obj.updated_at !== "string"
  ) {
    return null;
  }
  return {
    job_id: obj.job_id,
    run_name: obj.run_name,
    registry_key: obj.registry_key,
    status: obj.status as VastJobStatus,
    epochs: obj.epochs,
    created_at: obj.created_at,
    updated_at: obj.updated_at,
    started_at: typeof obj.started_at === "string" ? obj.started_at : null,
    ended_at: typeof obj.ended_at === "string" ? obj.ended_at : null,
    vast_instance_id:
      typeof obj.vast_instance_id === "string" ? obj.vast_instance_id : null,
    exit_code: typeof obj.exit_code === "number" ? obj.exit_code : null,
    error: typeof obj.error === "string" ? obj.error : null,
  };
}

/** Read the tail of a job's stdout/stderr log file. Empty array if no log. */
export async function readJobLogTail(
  jobId: string,
  tailLines: number,
): Promise<string[]> {
  const path = jobLogPath(jobId);
  if (!existsSync(path)) return [];
  const raw = await fs.readFile(path, "utf8");
  const lines = raw.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  if (tailLines <= 0 || lines.length <= tailLines) return lines;
  return lines.slice(lines.length - tailLines);
}

/**
 * Append a chunk of subprocess output (stdout + stderr merged) to the
 * per-job log file, creating the directory as needed.
 */
export async function appendJobLog(
  jobId: string,
  chunk: string,
): Promise<void> {
  const path = jobLogPath(jobId);
  ensureDir(dirname(path));
  await fs.appendFile(path, chunk, "utf8");
}

/** Inference endpoint registry — single JSON file under the vast root. */
export interface InferenceEndpointRecord {
  id: string;
  label: string;
  base_url: string;
  registry_key: string;
  created_at: string;
}

const ENDPOINTS_FILE = "inference-endpoints.json";

function endpointsPath(): string {
  return join(vastRoot(), ENDPOINTS_FILE);
}

export async function readInferenceEndpoints(): Promise<
  InferenceEndpointRecord[]
> {
  const path = endpointsPath();
  if (!existsSync(path)) return [];
  const raw = await fs.readFile(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: InferenceEndpointRecord[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as Record<string, unknown>;
    if (
      typeof obj.id === "string" &&
      typeof obj.label === "string" &&
      typeof obj.base_url === "string" &&
      typeof obj.registry_key === "string" &&
      typeof obj.created_at === "string"
    ) {
      out.push({
        id: obj.id,
        label: obj.label,
        base_url: obj.base_url,
        registry_key: obj.registry_key,
        created_at: obj.created_at,
      });
    }
  }
  return out;
}

export async function writeInferenceEndpoints(
  endpoints: InferenceEndpointRecord[],
): Promise<void> {
  const path = endpointsPath();
  ensureDir(dirname(path));
  await fs.writeFile(path, `${JSON.stringify(endpoints, null, 2)}\n`, "utf8");
}
