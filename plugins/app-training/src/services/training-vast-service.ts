/**
 * Vast.ai training-job orchestration service.
 *
 * Owns:
 *   - Loading the model registry from `<trainingRoot>/scripts/dump_registry_json.py`
 *     (Python subprocess) and caching it in-memory with manual refresh.
 *   - Spawning `bash <trainingRoot>/scripts/train_vast.sh provision-and-train ...`
 *     for new jobs and recording state transitions in the JSONL job store.
 *   - Spawning `python <trainingRoot>/scripts/eval_checkpoint.py ...` for ad-hoc
 *     evals against an existing job's run directory.
 *   - Reading the inference-stats JSONL the inference side appends to
 *     (`~/.eliza/inference-stats.jsonl` by default).
 *
 * `trainingRoot` is the eliza-1 training package, resolved by default to
 * `eliza/packages/training/` (relative to this file's compiled location).
 *
 * Subprocess invariants:
 *   - Every shell-out uses `spawn` with an arg array. User-supplied values
 *     (registry_key, label) are validated against an explicit whitelist
 *     before they ever reach `spawn`. We never interpolate user input into
 *     shell strings.
 *   - The training root is locked at construction time and is the cwd for
 *     every spawn. Resolved once via the absolute path of this file.
 */

import { spawn } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "@elizaos/core";
import {
  aggregateInferenceStats,
  emptyInferenceStatsAggregate,
  type InferenceStatRow,
  type InferenceStatsAggregate,
  parseStatRow,
} from "./vast-inference-stats.js";
import {
  type InferenceEndpointRecord,
  inferenceStatsPath,
  readInferenceEndpoints,
  readJobLogTail,
  type VastJobRecord,
  VastJobStore,
  writeInferenceEndpoints,
} from "./vast-job-store.js";
import {
  runCapture,
  runDetachedToLog,
  VastServiceError,
} from "./vast-subprocess.js";

export { VastServiceError } from "./vast-subprocess.js";

export interface VastRegistryEntry {
  eliza_short_name: string;
  eliza_repo_id: string;
  gguf_repo_id: string;
  base_hf_id: string;
  tier: string;
  inference_max_context: number;
}

export type VastRegistry = Record<string, VastRegistryEntry>;

export interface CreateJobInput {
  registry_key: string;
  epochs: number;
  run_name?: string;
}

export interface EvalCheckpointInput {
  registry_key: string;
  checkpoint_dir: string;
  val_jsonl?: string;
  max_examples?: number;
}

export type { InferenceStatRow, InferenceStatsAggregate };

export interface RegistryListing {
  short_name: string;
  entry: VastRegistryEntry;
}

export interface CheckpointInfo {
  name: string;
  path: string;
  step: number | null;
  evaluated: boolean;
  eval_summary: Record<string, unknown> | null;
}

/**
 * Running cost snapshot for one Vast.ai job.
 *
 * Shape matches the JSON emitted by `scripts/lib/vast_budget.py snapshot
 * --json`. Mapped 1:1 to the React panel field-set so we don't need a
 * separate DTO.
 */
export interface VastJobBudget {
  job_id: string;
  instance_id: number | null;
  pipeline: string;
  run_name: string;
  gpu_name: string;
  num_gpus: number;
  gpu_sku: string;
  state: string;
  uptime_seconds: number;
  uptime_pretty: string;
  dph_total: number;
  total_so_far_usd: number;
  soft_cap_usd: number | null;
  hard_cap_usd: number | null;
  over_soft: boolean;
  over_hard: boolean;
  fetched_at: number;
}

export interface VastTrainingServiceOptions {
  /** Override the training package root used to locate `scripts/...`. */
  trainingRoot?: string;
  /** Override the python launcher used for the registry dump + eval. */
  pythonLauncher?: { command: string; preArgs: string[] };
  /** Optional injected store for test isolation. */
  store?: VastJobStore;
  /** Override the spawn factory for tests. */
  spawnImpl?: typeof spawn;
}

const DEFAULT_PYTHON: { command: string; preArgs: string[] } = {
  command: "uv",
  preArgs: ["run", "--quiet", "python"],
};

const HERE = fileURLToPath(import.meta.url);
const TRAINING_ROOT_DEFAULT = resolve(
  HERE,
  "..",
  "..",
  "..",
  "..",
  "..",
  "packages",
  "training",
);

const RUN_NAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const LABEL_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Strict subset of the registry-key shape we accept from clients. The actual
 * authoritative whitelist is the registry dump itself; this is just a cheap
 * pre-filter that keeps obviously hostile values from ever reaching spawn.
 */
const REGISTRY_KEY_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export class VastTrainingService {
  private readonly store: VastJobStore;
  private readonly trainingRoot: string;
  private readonly python: { command: string; preArgs: string[] };
  private readonly spawnImpl: typeof spawn;
  private registryCache: VastRegistry | null = null;
  private registryLoadedAt: string | null = null;

  constructor(options: VastTrainingServiceOptions = {}) {
    this.store = options.store ?? new VastJobStore();
    this.trainingRoot = options.trainingRoot ?? TRAINING_ROOT_DEFAULT;
    this.python = options.pythonLauncher ?? DEFAULT_PYTHON;
    this.spawnImpl = options.spawnImpl ?? spawn;
  }

  // ── Registry ──────────────────────────────────────────────────────────

  async getRegistry(refresh = false): Promise<VastRegistry> {
    if (this.registryCache && !refresh) return this.registryCache;
    const dumpScript = join(
      this.trainingRoot,
      "scripts",
      "dump_registry_json.py",
    );
    if (!existsSync(dumpScript)) {
      throw new VastServiceError(
        `Registry dump script not found at ${dumpScript}`,
        503,
      );
    }
    const stdout = await this.runCapture(
      this.python.command,
      [...this.python.preArgs, dumpScript],
      { cwd: this.trainingRoot },
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch (err) {
      throw new VastServiceError(
        `Registry dump produced non-JSON output: ${err instanceof Error ? err.message : String(err)}`,
        500,
      );
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new VastServiceError(
        "Registry dump returned unexpected shape",
        500,
      );
    }
    const out: VastRegistry = {};
    for (const [key, value] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      const entry = narrowRegistryEntry(value);
      if (entry) out[key] = entry;
    }
    this.registryCache = out;
    this.registryLoadedAt = new Date().toISOString();
    return out;
  }

  async listRegistry(refresh = false): Promise<{
    loaded_at: string | null;
    entries: RegistryListing[];
  }> {
    const registry = await this.getRegistry(refresh);
    const entries = Object.entries(registry).map(([short_name, entry]) => ({
      short_name,
      entry,
    }));
    return { loaded_at: this.registryLoadedAt, entries };
  }

  async ensureRegistryKey(key: string): Promise<VastRegistryEntry> {
    if (!REGISTRY_KEY_PATTERN.test(key)) {
      throw new VastServiceError(
        "registry_key must match [A-Za-z0-9._-]{1,64}",
        400,
      );
    }
    const registry = await this.getRegistry(false);
    const entry = registry[key];
    if (!entry) {
      throw new VastServiceError(
        `Unknown registry_key '${key}'. Refresh /api/training/vast/models to update the cache.`,
        400,
      );
    }
    return entry;
  }

  // ── Jobs ──────────────────────────────────────────────────────────────

  async listJobs(): Promise<VastJobRecord[]> {
    return this.store.list();
  }

  async getJob(jobId: string): Promise<VastJobRecord | null> {
    return this.store.get(jobId);
  }

  async createJob(input: CreateJobInput): Promise<VastJobRecord> {
    await this.ensureRegistryKey(input.registry_key);
    if (
      !Number.isInteger(input.epochs) ||
      input.epochs < 1 ||
      input.epochs > 64
    ) {
      throw new VastServiceError(
        "epochs must be an integer between 1 and 64",
        400,
      );
    }
    if (
      input.run_name !== undefined &&
      !RUN_NAME_PATTERN.test(input.run_name)
    ) {
      throw new VastServiceError(
        "run_name must match [A-Za-z0-9._-]{1,64}",
        400,
      );
    }
    const job_id = makeJobId();
    const run_name = input.run_name ?? defaultRunName(input.registry_key);
    const now = new Date().toISOString();
    const record: VastJobRecord = {
      job_id,
      run_name,
      registry_key: input.registry_key,
      status: "queued",
      epochs: input.epochs,
      created_at: now,
      updated_at: now,
      started_at: null,
      ended_at: null,
      vast_instance_id: null,
      exit_code: null,
      error: null,
    };
    await this.store.insert(record);
    void this.dispatchJob(record);
    return record;
  }

  async cancelJob(jobId: string): Promise<VastJobRecord> {
    const job = await this.store.get(jobId);
    if (!job) throw new VastServiceError("Job not found", 404);
    if (job.status === "completed" || job.status === "failed") {
      throw new VastServiceError(
        `Cannot cancel job in terminal state '${job.status}'`,
        409,
      );
    }
    if (job.status === "cancelled") return job;
    return this.store.update(jobId, {
      status: "cancelled",
      ended_at: new Date().toISOString(),
    });
  }

  async readJobLog(jobId: string, tailLines: number): Promise<string[]> {
    const job = await this.store.get(jobId);
    if (!job) throw new VastServiceError("Job not found", 404);
    return readJobLogTail(jobId, tailLines);
  }

  async runEval(
    jobId: string,
    input: Partial<EvalCheckpointInput>,
  ): Promise<{
    job_id: string;
    exit_code: number;
    out_path: string;
    summary: Record<string, unknown> | null;
  }> {
    const job = await this.store.get(jobId);
    if (!job) throw new VastServiceError("Job not found", 404);
    const evalScript = join(this.trainingRoot, "scripts", "eval_checkpoint.py");
    if (!existsSync(evalScript)) {
      throw new VastServiceError(
        `eval_checkpoint.py not found at ${evalScript} — CheckpointSyncAgent has not landed it yet`,
        503,
      );
    }
    const checkpointDir =
      input.checkpoint_dir ??
      join(this.trainingRoot, "checkpoints", job.run_name, "final");
    if (!isSafeCheckpointPath(checkpointDir, this.trainingRoot)) {
      throw new VastServiceError(
        "checkpoint_dir must resolve under the training root",
        400,
      );
    }
    const valJsonl = input.val_jsonl ?? "data/smoke/val.jsonl";
    if (!isSafeRelativePath(valJsonl)) {
      throw new VastServiceError(
        "val_jsonl must be a relative path without traversal",
        400,
      );
    }
    const maxExamples = input.max_examples ?? 50;
    if (
      !Number.isInteger(maxExamples) ||
      maxExamples < 1 ||
      maxExamples > 5000
    ) {
      throw new VastServiceError(
        "max_examples must be an integer between 1 and 5000",
        400,
      );
    }
    const outPath = join(
      this.trainingRoot,
      "checkpoints",
      job.run_name,
      `eval-${Date.now()}.json`,
    );
    const args = [
      ...this.python.preArgs,
      evalScript,
      "--checkpoint",
      checkpointDir,
      "--registry-key",
      job.registry_key,
      "--val-jsonl",
      valJsonl,
      "--max-examples",
      String(maxExamples),
      "--out",
      outPath,
    ];
    const exitCode = await this.runDetachedToLog(
      jobId,
      this.python.command,
      args,
      this.trainingRoot,
    );
    let summary: Record<string, unknown> | null = null;
    if (existsSync(outPath)) {
      try {
        const raw = await fs.readFile(outPath, "utf8");
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          summary = parsed as Record<string, unknown>;
        }
      } catch (err) {
        logger.warn(
          `[VastTrainingService] failed to read eval output ${outPath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return { job_id: jobId, exit_code: exitCode, out_path: outPath, summary };
  }

  // ── Checkpoints ───────────────────────────────────────────────────────

  async listCheckpointsForRegistryKey(
    registryKey: string,
  ): Promise<CheckpointInfo[]> {
    await this.ensureRegistryKey(registryKey);
    const checkpointsRoot = join(this.trainingRoot, "checkpoints");
    if (!existsSync(checkpointsRoot)) return [];
    const out: CheckpointInfo[] = [];
    const runDirs = await fs.readdir(checkpointsRoot, { withFileTypes: true });
    for (const runDir of runDirs) {
      if (!runDir.isDirectory()) continue;
      if (!runDir.name.startsWith(registryKey.replace(/\./g, "-"))) continue;
      const runPath = join(checkpointsRoot, runDir.name);
      const status = join(runPath, "STATUS.md");
      if (existsSync(status)) {
        try {
          const body = await fs.readFile(status, "utf8");
          if (body.includes("FAILED RUN")) continue;
        } catch {
          continue;
        }
      }
      const ckptEntries = await fs.readdir(runPath, { withFileTypes: true });
      for (const ckpt of ckptEntries) {
        if (!ckpt.isDirectory()) continue;
        if (!/^checkpoint-\d+$|^final$/.test(ckpt.name)) continue;
        const ckptPath = join(runPath, ckpt.name);
        const stepMatch = /^checkpoint-(\d+)$/.exec(ckpt.name);
        const evalDoneFile = join(ckptPath, "_eval.json");
        let evalSummary: Record<string, unknown> | null = null;
        const evaluated = existsSync(evalDoneFile);
        if (evaluated) {
          try {
            const raw = await fs.readFile(evalDoneFile, "utf8");
            const parsed: unknown = JSON.parse(raw);
            if (
              parsed &&
              typeof parsed === "object" &&
              !Array.isArray(parsed)
            ) {
              evalSummary = parsed as Record<string, unknown>;
            }
          } catch {
            evalSummary = null;
          }
        }
        out.push({
          name: `${runDir.name}/${ckpt.name}`,
          path: ckptPath,
          step: stepMatch ? Number(stepMatch[1]) : null,
          evaluated,
          eval_summary: evalSummary,
        });
      }
    }
    out.sort((a, b) => (b.step ?? -1) - (a.step ?? -1));
    return out;
  }

  // ── Inference endpoints ───────────────────────────────────────────────

  async listInferenceEndpoints(): Promise<InferenceEndpointRecord[]> {
    return readInferenceEndpoints();
  }

  async createInferenceEndpoint(input: {
    label: string;
    base_url: string;
    registry_key: string;
  }): Promise<InferenceEndpointRecord> {
    if (!LABEL_PATTERN.test(input.label)) {
      throw new VastServiceError("label must match [A-Za-z0-9._-]{1,64}", 400);
    }
    let url: URL;
    try {
      url = new URL(input.base_url);
    } catch {
      throw new VastServiceError("base_url must be a valid URL", 400);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new VastServiceError("base_url must use http:// or https://", 400);
    }
    await this.ensureRegistryKey(input.registry_key);
    const endpoints = await readInferenceEndpoints();
    if (endpoints.some((e) => e.label === input.label)) {
      throw new VastServiceError(
        `Inference endpoint with label '${input.label}' already exists`,
        409,
      );
    }
    const record: InferenceEndpointRecord = {
      id: `ep_${makeShortId()}`,
      label: input.label,
      base_url: input.base_url,
      registry_key: input.registry_key,
      created_at: new Date().toISOString(),
    };
    endpoints.push(record);
    await writeInferenceEndpoints(endpoints);
    return record;
  }

  async deleteInferenceEndpoint(id: string): Promise<boolean> {
    const endpoints = await readInferenceEndpoints();
    const next = endpoints.filter((e) => e.id !== id);
    if (next.length === endpoints.length) return false;
    await writeInferenceEndpoints(next);
    return true;
  }

  /**
   * Read a per-job budget snapshot via `scripts.lib.vast_budget snapshot
   * --json`. Returns `null` when the job has no provisioned instance
   * yet (the UI shows a "not provisioned" placeholder in that case).
   *
   * The python module is the single source of truth — it both renders
   * the watcher's status line and answers this endpoint, so the UI and
   * the watcher never disagree about the budget state.
   */
  async getJobBudget(jobId: string): Promise<VastJobBudget | null> {
    const job = await this.store.get(jobId);
    if (!job) throw new VastServiceError("Job not found", 404);
    const instanceIdRaw = job.vast_instance_id;
    if (!instanceIdRaw) return null;
    const instanceId = Number(instanceIdRaw);
    if (!Number.isFinite(instanceId) || instanceId <= 0) return null;
    const dumpScript = "-m";
    let stdout: string;
    try {
      stdout = await this.runCapture(
        this.python.command,
        [
          ...this.python.preArgs,
          dumpScript,
          "scripts.lib.vast_budget",
          "snapshot",
          String(instanceId),
          "--pipeline",
          job.registry_key,
          "--run-name",
          job.run_name,
          "--json",
        ],
        { cwd: this.trainingRoot },
      );
    } catch (err) {
      // Treat any backend error (vastai unreachable, instance destroyed)
      // as "snapshot unavailable" — the UI shows a stale-data marker
      // rather than failing the whole panel.
      logger.warn(
        `[VastTrainingService] budget snapshot failed for ${jobId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
    const trimmed = stdout.trim();
    if (!trimmed) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return null;
    }
    return narrowBudgetSnapshot(parsed, jobId);
  }

  async getInferenceStats(
    label: string | null,
    lastMinutes: number,
  ): Promise<InferenceStatsAggregate> {
    if (
      !Number.isFinite(lastMinutes) ||
      lastMinutes <= 0 ||
      lastMinutes > 24 * 60
    ) {
      throw new VastServiceError(
        "last_minutes must be a positive number ≤ 1440",
        400,
      );
    }
    if (label !== null && !LABEL_PATTERN.test(label)) {
      throw new VastServiceError("label must match [A-Za-z0-9._-]{1,64}", 400);
    }
    const path = inferenceStatsPath();
    if (!existsSync(path)) {
      return emptyInferenceStatsAggregate(label, lastMinutes);
    }
    const cutoffMs = Date.now() - lastMinutes * 60_000;
    const raw = await fs.readFile(path, "utf8");
    const samples: InferenceStatRow[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const row = parseStatRow(trimmed);
      if (!row) continue;
      if (label !== null && row.label !== label) continue;
      const ts = Date.parse(row.ts);
      if (!Number.isFinite(ts) || ts < cutoffMs) continue;
      samples.push(row);
    }
    return aggregateInferenceStats(samples, label, lastMinutes);
  }

  // ── Internals ─────────────────────────────────────────────────────────

  private async dispatchJob(record: VastJobRecord): Promise<void> {
    const trainScript = join(this.trainingRoot, "scripts", "train_vast.sh");
    if (!existsSync(trainScript)) {
      logger.error(
        `[VastTrainingService] train_vast.sh not found at ${trainScript}`,
      );
      await this.store.update(record.job_id, {
        status: "failed",
        ended_at: new Date().toISOString(),
        error: "train_vast.sh not found",
      });
      return;
    }
    await this.store.update(record.job_id, {
      status: "provisioning",
      started_at: new Date().toISOString(),
    });
    const args = [
      trainScript,
      "provision-and-train",
      "--registry-key",
      record.registry_key,
      "--epochs",
      String(record.epochs),
    ];
    try {
      const exitCode = await this.runDetachedToLog(
        record.job_id,
        "bash",
        args,
        this.trainingRoot,
        {
          RUN_NAME: record.run_name,
        },
      );
      const instanceId = await this.discoverInstanceIdForRun(record);
      if (exitCode === 0) {
        await this.store.update(record.job_id, {
          status: "completed",
          ended_at: new Date().toISOString(),
          exit_code: exitCode,
          vast_instance_id: instanceId,
        });
      } else {
        await this.store.update(record.job_id, {
          status: "failed",
          ended_at: new Date().toISOString(),
          exit_code: exitCode,
          vast_instance_id: instanceId,
          error: `train_vast.sh exited with code ${exitCode}`,
        });
      }
    } catch (err) {
      logger.error(
        `[VastTrainingService] dispatch failure for ${record.job_id}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
      );
      await this.store.update(record.job_id, {
        status: "failed",
        ended_at: new Date().toISOString(),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async discoverInstanceIdForRun(
    record: VastJobRecord,
  ): Promise<string | null> {
    const stateFile = join(
      this.trainingRoot,
      ".eliza",
      "vast-state",
      `${record.run_name}.json`,
    );
    if (existsSync(stateFile)) {
      try {
        const raw = await fs.readFile(stateFile, "utf8");
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
          const obj = parsed as Record<string, unknown>;
          const id = obj.instance_id ?? obj.vast_instance_id;
          if (typeof id === "string" && id.trim()) return id.trim();
          if (typeof id === "number") return String(id);
        }
      } catch (err) {
        logger.warn(
          `[VastTrainingService] could not parse vast-state file ${stateFile}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    const logTail = await readJobLogTail(record.job_id, 200);
    for (const line of logTail) {
      const match = /ELIZA_VAST_INSTANCE_ID=([A-Za-z0-9_-]+)/.exec(line);
      if (match) return match[1];
    }
    return null;
  }

  private runCapture(
    command: string,
    args: string[],
    options: { cwd: string },
  ): Promise<string> {
    return runCapture(this.spawnImpl, command, args, options);
  }

  private runDetachedToLog(
    jobId: string,
    command: string,
    args: string[],
    cwd: string,
    extraEnv: NodeJS.ProcessEnv = {},
  ): Promise<number> {
    return runDetachedToLog(
      this.spawnImpl,
      jobId,
      command,
      args,
      cwd,
      extraEnv,
    );
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

function defaultRunName(registryKey: string): string {
  return `${registryKey.replace(/\./g, "-")}-apollo`;
}

function makeJobId(): string {
  return `vjob_${makeShortId()}`;
}

function makeShortId(): string {
  // 12 base36 chars from crypto-quality randomness.
  const buf = new Uint8Array(8);
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(buf);
  } else {
    for (let i = 0; i < buf.length; i += 1)
      buf[i] = Math.floor(Math.random() * 256);
  }
  let n = 0n;
  for (const byte of buf) n = (n << 8n) | BigInt(byte);
  return n.toString(36).padStart(12, "0").slice(0, 12);
}

function narrowRegistryEntry(value: unknown): VastRegistryEntry | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  if (
    typeof obj.eliza_short_name === "string" &&
    typeof obj.eliza_repo_id === "string" &&
    typeof obj.gguf_repo_id === "string" &&
    typeof obj.base_hf_id === "string" &&
    typeof obj.tier === "string" &&
    typeof obj.inference_max_context === "number"
  ) {
    return {
      eliza_short_name: obj.eliza_short_name,
      eliza_repo_id: obj.eliza_repo_id,
      gguf_repo_id: obj.gguf_repo_id,
      base_hf_id: obj.base_hf_id,
      tier: obj.tier,
      inference_max_context: obj.inference_max_context,
    };
  }
  return null;
}

function narrowBudgetSnapshot(
  raw: unknown,
  jobId: string,
): VastJobBudget | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const num = (k: string): number | null => {
    const v = obj[k];
    if (typeof v !== "number" || !Number.isFinite(v)) return null;
    return v;
  };
  const str = (k: string): string | null => {
    const v = obj[k];
    return typeof v === "string" ? v : null;
  };
  const bool = (k: string): boolean | null => {
    const v = obj[k];
    return typeof v === "boolean" ? v : null;
  };
  const instanceId = num("instance_id");
  const pipeline = str("pipeline");
  const runName = str("run_name");
  const gpuName = str("gpu_name");
  const gpuSku = str("gpu_sku");
  const state = str("state");
  const uptime = num("uptime_seconds");
  const uptimePretty = str("uptime_pretty");
  const dph = num("dph_total");
  const total = num("total_so_far_usd");
  const fetchedAt = num("fetched_at");
  const numGpus = num("num_gpus");
  const overSoft = bool("over_soft");
  const overHard = bool("over_hard");
  if (
    instanceId === null ||
    !pipeline ||
    runName === null ||
    !gpuName ||
    !gpuSku ||
    !state ||
    uptime === null ||
    !uptimePretty ||
    dph === null ||
    total === null ||
    fetchedAt === null ||
    numGpus === null ||
    overSoft === null ||
    overHard === null
  ) {
    return null;
  }
  // Caps may legitimately be null when ELIZA_VAST_MAX_USD is unset.
  const softRaw = obj.soft_cap_usd;
  const hardRaw = obj.hard_cap_usd;
  const soft =
    typeof softRaw === "number" && Number.isFinite(softRaw) ? softRaw : null;
  const hard =
    typeof hardRaw === "number" && Number.isFinite(hardRaw) ? hardRaw : null;
  return {
    job_id: jobId,
    instance_id: instanceId,
    pipeline,
    run_name: runName,
    gpu_name: gpuName,
    num_gpus: numGpus,
    gpu_sku: gpuSku,
    state,
    uptime_seconds: uptime,
    uptime_pretty: uptimePretty,
    dph_total: dph,
    total_so_far_usd: total,
    soft_cap_usd: soft,
    hard_cap_usd: hard,
    over_soft: overSoft,
    over_hard: overHard,
    fetched_at: fetchedAt,
  };
}

function isSafeRelativePath(p: string): boolean {
  if (typeof p !== "string" || !p.trim()) return false;
  if (p.startsWith("/") || p.includes("..")) return false;
  return true;
}

function isSafeCheckpointPath(
  checkpointDir: string,
  trainingRoot: string,
): boolean {
  if (typeof checkpointDir !== "string" || !checkpointDir.trim()) return false;
  const root = resolve(trainingRoot);
  const resolved = resolve(checkpointDir);
  return resolved === root || resolved.startsWith(`${root}/`);
}
