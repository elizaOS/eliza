import { once } from "node:events";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createGzip } from "node:zlib";
import { type IAgentRuntime, ModelType, Service } from "@elizaos/core";

type TrajectoryStatus = "active" | "completed" | "error" | "timeout";

// ============================================================================
// Types for the full TrajectoryLoggerApi (compatible with trajectory-routes.ts)
// ============================================================================

interface TrajectoryListOptions {
  limit?: number;
  offset?: number;
  source?: string;
  status?: TrajectoryStatus;
  startDate?: string;
  endDate?: string;
  search?: string;
  scenarioId?: string;
  batchId?: string;
  isTrainingData?: boolean;
}

interface TrajectoryListItem {
  id: string;
  agentId: string;
  source: string;
  status: TrajectoryStatus;
  startTime: number;
  endTime: number | null;
  durationMs: number | null;
  stepCount: number;
  llmCallCount: number;
  providerAccessCount: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

interface TrajectoryListResult {
  trajectories: TrajectoryListItem[];
  total: number;
  offset: number;
  limit: number;
}

interface TrajectoryStep {
  stepId?: string;
  timestamp: number;
  llmCalls?: Array<{
    callId?: string;
    timestamp?: number;
    model?: string;
    systemPrompt?: string;
    userPrompt?: string;
    response?: string;
    temperature?: number;
    maxTokens?: number;
    purpose?: string;
    actionType?: string;
    latencyMs?: number;
    promptTokens?: number;
    completionTokens?: number;
  }>;
  providerAccesses?: Array<{
    providerId?: string;
    providerName?: string;
    purpose?: string;
    data?: Record<string, unknown>;
    query?: Record<string, unknown>;
    timestamp?: number;
  }>;
}

interface Trajectory {
  trajectoryId: string;
  agentId: string;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  steps?: TrajectoryStep[];
  metrics?: { finalStatus?: string };
  metadata?: Record<string, unknown>;
  stepsJson?: string;
}

type TrajectoryExportFormat = "json" | "csv" | "art";

interface TrajectoryExportOptions {
  format: TrajectoryExportFormat;
  includePrompts?: boolean;
  trajectoryIds?: string[];
  startDate?: string;
  endDate?: string;
  scenarioId?: string;
  batchId?: string;
}

interface TrajectoryExportResult {
  filename: string;
  data: string | Uint8Array;
  mimeType: string;
}

type RuntimeDb = {
  execute: (query: { queryChunks: object[] }) => Promise<unknown>;
};

type TrajectoryLoggerLike = {
  listTrajectories?: unknown;
  getTrajectoryDetail?: unknown;
  isEnabled?: () => boolean;
  setEnabled?: (enabled: boolean) => void;
  logLlmCall?: (params: Record<string, unknown>) => void;
  logProviderAccess?: (params: Record<string, unknown>) => void;
  getLlmCallLogs?: () => readonly unknown[];
  getProviderAccessLogs?: () => readonly unknown[];
  llmCalls?: unknown[];
  providerAccess?: unknown[];
};

type PersistedLlmCall = {
  callId: string;
  timestamp: number;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  response: string;
  temperature: number;
  maxTokens: number;
  purpose: string;
  actionType: string;
  latencyMs: number;
  promptTokens?: number;
  completionTokens?: number;
};

type PersistedProviderAccess = {
  providerId: string;
  providerName: string;
  timestamp: number;
  data: Record<string, unknown>;
  query?: Record<string, unknown>;
  purpose: string;
};

type PersistedStep = {
  stepId: string;
  stepNumber: number;
  timestamp: number;
  llmCalls: PersistedLlmCall[];
  providerAccesses: PersistedProviderAccess[];
};

type PersistedTrajectory = {
  id: string;
  source: string;
  status: TrajectoryStatus;
  startTime: number;
  endTime: number | null;
  steps: PersistedStep[];
  metadata: Record<string, unknown>;
  totalReward: number;
  createdAt: string;
  updatedAt: string;
};

type StartStepOptions = {
  runtime: IAgentRuntime;
  stepId: string;
  source?: string;
  metadata?: Record<string, unknown>;
};

type CompleteStepOptions = {
  runtime: IAgentRuntime;
  stepId: string;
  status?: TrajectoryStatus;
  source?: string;
  metadata?: Record<string, unknown>;
};

const initializedRuntimes = new WeakSet<object>();
const patchedLoggers = new WeakSet<object>();

const stepWriteQueues = new WeakMap<object, Map<string, Promise<void>>>();
const lastWritePromises = new WeakMap<object, Promise<void>>();

let cachedSqlRaw: ((query: string) => { queryChunks: object[] }) | null = null;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function toText(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return fallback;
  return String(value);
}

function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function toOptionalNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = toNumber(value, Number.NaN);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function toOptionalBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on", "enabled"].includes(normalized)) return true;
  if (["0", "false", "no", "off", "disabled"].includes(normalized))
    return false;
  return undefined;
}

function hasEvaluatorNamed(runtime: IAgentRuntime, name: string): boolean {
  const runtimeLike = runtime as unknown as {
    evaluators?: Array<{ name?: unknown }>;
  };
  const evaluators = runtimeLike.evaluators;
  if (!Array.isArray(evaluators)) return false;
  const target = name.trim().toUpperCase();
  return evaluators.some((evaluator) => {
    const evaluatorName =
      evaluator && typeof evaluator.name === "string"
        ? evaluator.name.trim().toUpperCase()
        : "";
    return evaluatorName === target;
  });
}

/** @internal Exported for testing. */
export function shouldRunObservationExtraction(
  runtime: IAgentRuntime,
): boolean {
  const runtimeAny = runtime as unknown as {
    getSetting?: (key: string) => unknown;
  };
  const explicitSetting = runtimeAny.getSetting?.(
    "TRAJECTORY_OBSERVATION_EXTRACTION",
  );
  const explicitValue = toOptionalBoolean(explicitSetting);
  if (explicitValue !== undefined) return explicitValue;

  // Reflection/relationship extraction already derives durable facts from chat.
  // Default to off in that mode to avoid duplicated extraction cost.
  if (
    hasEvaluatorNamed(runtime, "REFLECTION") ||
    hasEvaluatorNamed(runtime, "RELATIONSHIP_EXTRACTION")
  ) {
    return false;
  }
  return true;
}

function readRecordValue(
  record: Record<string, unknown>,
  keys: string[],
): unknown {
  for (const key of keys) {
    if (key in record) return record[key];
  }
  return undefined;
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

// ---------------------------------------------------------------------------
// Truncation helpers — cap large text fields to reduce storage/context bloat
// ---------------------------------------------------------------------------

const DEFAULT_TRUNCATE_LIMIT = 500;

/** @internal Exported for testing. */
export function truncateField(
  value: string,
  limit = DEFAULT_TRUNCATE_LIMIT,
): string {
  if (value.length <= limit * 2) return value;
  const removed = value.length - limit * 2;
  return `${value.slice(0, limit)}\n[...truncated ${removed} chars...]\n${value.slice(-limit)}`;
}

/** @internal Exported for testing. */
export function truncateRecord(
  obj: Record<string, unknown>,
  limit = DEFAULT_TRUNCATE_LIMIT,
): Record<string, unknown> {
  const serialized = JSON.stringify(obj);
  if (serialized.length <= limit * 2) return obj;
  return { _truncated: truncateField(serialized, limit) };
}

// ---------------------------------------------------------------------------
// Insight extraction — pull key decision markers from LLM responses at write
// time so the feedback loop can read them from metadata without loading full
// trajectory details.
// ---------------------------------------------------------------------------

/** @internal Exported for testing. */
export function extractInsightsFromResponse(
  response: string,
  purpose: string,
): string[] {
  const insights: string[] = [];
  const decisionPattern = /DECISION:\s*(.+?)(?:\n|$)/gi;
  let match: RegExpExecArray | null;
  match = decisionPattern.exec(response);
  while (match !== null) {
    insights.push(match[1].trim());
    match = decisionPattern.exec(response);
  }
  const keyDecisionPattern = /"keyDecision"\s*:\s*"([^"]+)"/g;
  match = keyDecisionPattern.exec(response);
  while (match !== null) {
    insights.push(match[1].trim());
    match = keyDecisionPattern.exec(response);
  }
  if (
    (purpose === "turn-complete" || purpose === "coordination") &&
    insights.length === 0
  ) {
    const reasoningMatch = response.match(/"reasoning"\s*:\s*"([^"]{20,200})"/);
    if (reasoningMatch) insights.push(reasoningMatch[1].trim());
  }
  return insights;
}

// ---------------------------------------------------------------------------
// Chat observation buffer — accumulates recent chat exchanges and flushes
// to a background LLM call for durable observation extraction.
// ---------------------------------------------------------------------------

interface BufferedExchange {
  userPrompt: string;
  response: string;
  trajectoryId: string;
  timestamp: number;
}

const OBSERVATION_BUFFER_THRESHOLD = 5;
const OBSERVATION_FLUSH_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

const observationBuffers = new WeakMap<object, BufferedExchange[]>();
const observationFlushTimers = new WeakMap<
  object,
  ReturnType<typeof setTimeout>
>();
const observationFlushInProgress = new WeakMap<object, boolean>();

const TRAJECTORY_ARCHIVE_DIRNAME = "trajectory-archive";

function getObservationBuffer(runtime: IAgentRuntime): BufferedExchange[] {
  const key = runtime as unknown as object;
  let buffer = observationBuffers.get(key);
  if (!buffer) {
    buffer = [];
    observationBuffers.set(key, buffer);
  }
  return buffer;
}

function resolvePreferredTrajectoryArchiveRoot(): string {
  const explicitWorkspace = process.env.MILADY_WORKSPACE_DIR?.trim();
  if (explicitWorkspace) return explicitWorkspace;

  const workspaceRoot = process.env.MILADY_WORKSPACE_ROOT?.trim();
  if (workspaceRoot) return workspaceRoot;

  return path.join(os.homedir(), ".milady", "workspace");
}

async function ensureArchiveDirectory(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

async function resolveTrajectoryArchiveDirectory(): Promise<string> {
  const preferred = path.join(
    resolvePreferredTrajectoryArchiveRoot(),
    TRAJECTORY_ARCHIVE_DIRNAME,
  );
  try {
    await ensureArchiveDirectory(preferred);
    return preferred;
  } catch {
    const fallback = path.join(
      process.env.TMPDIR || os.tmpdir(),
      "milady",
      TRAJECTORY_ARCHIVE_DIRNAME,
    );
    await ensureArchiveDirectory(fallback);
    return fallback;
  }
}

/** @internal Exported for testing. */
export function pushChatExchange(
  runtime: IAgentRuntime,
  exchange: BufferedExchange,
): void {
  const buffer = getObservationBuffer(runtime);
  buffer.push(exchange);

  const key = runtime as unknown as object;

  // Flush on threshold
  if (buffer.length >= OBSERVATION_BUFFER_THRESHOLD) {
    flushObservationBuffer(runtime).catch(() => {});
    return;
  }

  // Set/reset flush timer
  const existing = observationFlushTimers.get(key);
  if (existing) clearTimeout(existing);
  observationFlushTimers.set(
    key,
    setTimeout(() => {
      flushObservationBuffer(runtime).catch(() => {});
    }, OBSERVATION_FLUSH_INTERVAL_MS),
  );
}

const OBSERVATION_EXTRACTION_PROMPT = `You are analyzing recent conversation exchanges between a user and an AI assistant.
Extract any durable observations about the user that would be useful across future sessions.

Categories to look for:
- Preferences (tools, languages, workflows, communication style)
- Facts (role, location, projects they work on, tech stack)
- Standing instructions (things they always/never want)
- Patterns (recurring topics, how they like to work)

Return ONLY a JSON array of short observation strings (max 150 chars each).
If nothing meaningful is found, return an empty array [].
Do NOT include observations about the conversation itself, only about the user.

Recent exchanges:
`;

/** @internal Exported for testing. */
export async function flushObservationBuffer(
  runtime: IAgentRuntime,
): Promise<string[]> {
  const key = runtime as unknown as object;

  // Prevent concurrent flushes
  if (observationFlushInProgress.get(key)) return [];
  observationFlushInProgress.set(key, true);

  const buffer = getObservationBuffer(runtime);
  if (buffer.length === 0) {
    observationFlushInProgress.set(key, false);
    return [];
  }

  // Take the current buffer and reset
  const exchanges = buffer.splice(0, buffer.length);
  const timer = observationFlushTimers.get(key);
  if (timer) clearTimeout(timer);

  // Build the extraction prompt
  const exchangeText = exchanges
    .map(
      (e, i) =>
        `Exchange ${i + 1}:\nUser: ${e.userPrompt.slice(0, 500)}\nAssistant: ${e.response.slice(0, 500)}`,
    )
    .join("\n\n");

  const prompt = OBSERVATION_EXTRACTION_PROMPT + exchangeText;

  const runtimeAny = runtime as unknown as Record<string, unknown>;
  try {
    // Tag the call to prevent recursion — appendLlmCall skips observation
    // extraction when orchestratorCtx is set.
    runtimeAny.__orchestratorTrajectoryCtx = {
      source: "orchestrator",
      decisionType: "observation-extraction",
    };

    const result = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt,
      maxTokens: 512,
      temperature: 0,
    });

    // Parse the JSON response
    const jsonMatch = result.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) return [];

    const observations = parsed
      .filter((s: unknown) => typeof s === "string" && s.length > 0)
      .map((s: string) => s.slice(0, 150)) as string[];

    if (observations.length === 0) return [];

    // Write observations to the most recent trajectory in the batch
    const lastExchange = exchanges[exchanges.length - 1];
    const trajectory = await loadTrajectoryById(
      runtime,
      lastExchange.trajectoryId,
    );
    if (trajectory) {
      const meta = (trajectory.metadata ?? {}) as Record<string, unknown>;
      const existing = Array.isArray(meta.observations)
        ? (meta.observations as string[])
        : [];
      meta.observations = [...existing, ...observations].slice(-30);
      trajectory.metadata = meta;
      await saveTrajectory(runtime, trajectory);
    }

    return observations;
  } catch {
    // Non-critical — observations are best-effort
    return [];
  } finally {
    delete runtimeAny.__orchestratorTrajectoryCtx;
    observationFlushInProgress.set(key, false);
  }
}

function parseMetadata(value: unknown): Record<string, unknown> {
  const parsed = parseJsonValue(value);
  const record = asRecord(parsed);
  return record ?? {};
}

function parseSteps(value: unknown): PersistedStep[] {
  const parsed = parseJsonValue(value);
  if (Array.isArray(parsed)) {
    return parsed as PersistedStep[];
  }
  const record = asRecord(parsed);
  if (!record) return [];
  const nested = parseJsonValue(readRecordValue(record, ["steps"]));
  return Array.isArray(nested) ? (nested as PersistedStep[]) : [];
}

function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function sqlNumber(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "NULL";
  return String(value);
}

async function getSqlRaw(): Promise<
  (query: string) => { queryChunks: object[] }
> {
  if (cachedSqlRaw) return cachedSqlRaw;
  const drizzle = (await import("drizzle-orm")) as {
    sql: { raw: (query: string) => { queryChunks: object[] } };
  };
  cachedSqlRaw = drizzle.sql.raw;
  return cachedSqlRaw;
}

function getRuntimeDb(runtime: IAgentRuntime): RuntimeDb | null {
  const runtimeLike = runtime as unknown as {
    adapter?: {
      db?: RuntimeDb;
    };
    databaseAdapter?: {
      db?: RuntimeDb;
    };
  };
  const db = runtimeLike.adapter?.db || runtimeLike.databaseAdapter?.db;
  if (!db || typeof db.execute !== "function") return null;
  return db;
}

function hasRuntimeDb(runtime: IAgentRuntime): boolean {
  return Boolean(getRuntimeDb(runtime));
}

async function executeRawSql(
  runtime: IAgentRuntime,
  sqlText: string,
): Promise<unknown> {
  const db = getRuntimeDb(runtime);
  if (!db) {
    throw new Error("runtime database adapter unavailable");
  }
  const raw = await getSqlRaw();
  return db.execute(raw(sqlText));
}

/** @internal Exported for testing. */
export function extractRows(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  const record = asRecord(result);
  if (!record) return [];
  return Array.isArray(record.rows) ? record.rows : [];
}

/** @internal Exported for testing. */
export async function computeBySource(
  runtime: IAgentRuntime,
): Promise<Record<string, number>> {
  try {
    const result = await executeRawSql(
      runtime,
      "SELECT source, count(*) AS cnt FROM trajectories GROUP BY source",
    );
    const rows = extractRows(result);
    const bySource: Record<string, number> = {};
    for (const row of rows) {
      const r = asRecord(row);
      if (!r) continue;
      const src = typeof r.source === "string" ? r.source : "";
      if (src) bySource[src] = toNumber(r.cnt, 0);
    }
    return bySource;
  } catch {
    return {};
  }
}

function warnRuntime(
  runtime: IAgentRuntime,
  message: string,
  err?: unknown,
): void {
  const runtimeLike = runtime as unknown as {
    logger?: {
      warn?: (meta: Record<string, unknown>, message: string) => void;
    };
  };
  if (runtimeLike.logger?.warn) {
    runtimeLike.logger.warn(
      { err, src: "milady", subsystem: "trajectory-db" },
      message,
    );
  }
}

// Module version - changes on each hot reload, ensuring schema checks run
const SCHEMA_VERSION = Date.now();
const schemaVersions = new WeakMap<object, number>();

async function ensureTrajectoriesTable(
  runtime: IAgentRuntime,
): Promise<boolean> {
  const key = runtime as unknown as object;

  // Only skip if verified with current module version
  if (schemaVersions.get(key) === SCHEMA_VERSION) return true;

  try {
    // First, check if the table exists and has the correct schema
    // by attempting to select all required columns
    let needsRecreate = false;
    try {
      await executeRawSql(
        runtime,
        `SELECT trajectory_id, metadata, steps_json, archetype FROM trajectories LIMIT 1`,
      );
    } catch {
      // Table doesn't exist or is missing trajectory_id column
      // Try to drop and recreate
      needsRecreate = true;
      console.warn(
        "[trajectory-persistence] Trajectories table missing or has outdated schema, recreating...",
      );
      try {
        await executeRawSql(
          runtime,
          `DROP TABLE IF EXISTS trajectories CASCADE`,
        );
      } catch (dropErr) {
        console.warn(
          "[trajectory-persistence] Could not drop old table:",
          dropErr,
        );
      }
    }

    await executeRawSql(
      runtime,
      `CREATE TABLE IF NOT EXISTS trajectories (
        id TEXT PRIMARY KEY,
        trajectory_id TEXT,
        agent_id TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'runtime',
        status TEXT NOT NULL DEFAULT 'completed',
        start_time BIGINT NOT NULL,
        end_time BIGINT,
        duration_ms BIGINT,
        step_count INTEGER NOT NULL DEFAULT 0,
        llm_call_count INTEGER NOT NULL DEFAULT 0,
        provider_access_count INTEGER NOT NULL DEFAULT 0,
        total_prompt_tokens INTEGER NOT NULL DEFAULT 0,
        total_completion_tokens INTEGER NOT NULL DEFAULT 0,
        total_reward REAL NOT NULL DEFAULT 0,
        steps_json TEXT NOT NULL DEFAULT '[]',
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        episode_length INTEGER,
        ai_judge_reward REAL,
        ai_judge_reasoning TEXT,
        archetype TEXT
      )`,
    );

    // Archive table — lightweight summary rows that persist after TTL pruning
    // deletes the heavy steps_json data from the main table.
    await executeRawSql(
      runtime,
      `CREATE TABLE IF NOT EXISTS trajectory_archive (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'runtime',
        status TEXT NOT NULL DEFAULT 'completed',
        start_time BIGINT NOT NULL,
        end_time BIGINT,
        duration_ms BIGINT,
        step_count INTEGER NOT NULL DEFAULT 0,
        llm_call_count INTEGER NOT NULL DEFAULT 0,
        provider_access_count INTEGER NOT NULL DEFAULT 0,
        total_prompt_tokens INTEGER NOT NULL DEFAULT 0,
        total_completion_tokens INTEGER NOT NULL DEFAULT 0,
        total_reward REAL NOT NULL DEFAULT 0,
        metadata TEXT NOT NULL DEFAULT '{}',
        observations TEXT NOT NULL DEFAULT '[]',
        archive_blob_path TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT NOT NULL
      )`,
    );

    // Best-effort forward migration for existing archive tables.
    try {
      await executeRawSql(
        runtime,
        `ALTER TABLE trajectory_archive ADD COLUMN archive_blob_path TEXT`,
      );
    } catch {
      // ignore when column already exists
    }

    // Best-effort forward migration: add scenario_id column + index
    // (referenced by upstream elizaOS core or external plugins).
    try {
      await executeRawSql(
        runtime,
        `ALTER TABLE trajectories ADD COLUMN scenario_id TEXT`,
      );
    } catch {
      // ignore when column already exists
    }
    try {
      await executeRawSql(
        runtime,
        `CREATE INDEX IF NOT EXISTS idx_trajectories_scenario_id ON trajectories(scenario_id)`,
      );
    } catch {
      // ignore if index creation fails
    }

    if (needsRecreate) {
      console.warn(
        "[trajectory-persistence] Recreated trajectories table with updated schema",
      );
    }

    schemaVersions.set(key, SCHEMA_VERSION);
    initializedRuntimes.add(key);
    return true;
  } catch (err) {
    console.error(
      "[trajectory-persistence] ensureTrajectoriesTable error:",
      err,
    );
    return false;
  }
}

function normalizeStatus(
  value: unknown,
  fallback: TrajectoryStatus,
): TrajectoryStatus {
  const status = toText(value, "").toLowerCase();
  if (
    status === "active" ||
    status === "completed" ||
    status === "error" ||
    status === "timeout"
  ) {
    return status;
  }
  return fallback;
}

function normalizeStepId(value: unknown): string | null {
  const stepId = toText(value, "").trim();
  return stepId.length > 0 ? stepId : null;
}

function normalizeLlmCallPayload(
  args: unknown[],
): { stepId: string; params: Record<string, unknown> } | null {
  if (args.length === 0) return null;
  if (typeof args[0] === "string") {
    const stepId = normalizeStepId(args[0]);
    const details = asRecord(args[1]);
    if (!stepId || !details) return null;
    return {
      stepId,
      params: {
        ...details,
        stepId,
      },
    };
  }

  const params = asRecord(args[0]);
  if (!params) return null;
  const stepId = normalizeStepId(params.stepId);
  if (!stepId) return null;
  if (params.stepId === stepId) {
    return {
      stepId,
      params,
    };
  }
  return {
    stepId,
    params: {
      ...params,
      stepId,
    },
  };
}

function normalizeProviderAccessPayload(
  args: unknown[],
): { stepId: string; params: Record<string, unknown> } | null {
  if (args.length === 0) return null;
  if (typeof args[0] === "string") {
    const stepId = normalizeStepId(args[0]);
    const details = asRecord(args[1]);
    if (!stepId || !details) return null;
    return {
      stepId,
      params: {
        ...details,
        stepId,
      },
    };
  }

  const params = asRecord(args[0]);
  if (!params) return null;
  const stepId = normalizeStepId(params.stepId);
  if (!stepId) return null;
  if (params.stepId === stepId) {
    return {
      stepId,
      params,
    };
  }
  return {
    stepId,
    params: {
      ...params,
      stepId,
    },
  };
}

function isNumericVectorString(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === "[array]") return true;
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return false;
  const inner = trimmed.slice(1, -1).trim();
  if (!inner) return false;
  const parts = inner
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length < 8) return false;
  const sampleSize = Math.min(parts.length, 16);
  for (let i = 0; i < sampleSize; i += 1) {
    const numeric = Number(parts[i]);
    if (!Number.isFinite(numeric)) return false;
  }
  return true;
}

function shouldSuppressNoInputEmbeddingCall(
  params: Record<string, unknown>,
): boolean {
  const model = toText(params.model, "").toLowerCase();
  const actionType = toText(params.actionType, "").toLowerCase();
  const purpose = toText(params.purpose, "").toLowerCase();
  const isEmbedding =
    model.includes("embed") ||
    actionType.includes("embed") ||
    purpose.includes("embed");
  if (!isEmbedding) return false;
  const userPrompt = toText(params.userPrompt ?? params.input, "").trim();
  if (userPrompt.length > 0) return false;
  const response = toText(params.response, "");
  if (!response.trim()) return true;
  return isNumericVectorString(response);
}

function isLegacyTrajectoryLogger(logger: TrajectoryLoggerLike): boolean {
  return (
    typeof logger.listTrajectories === "function" &&
    typeof logger.getTrajectoryDetail === "function"
  );
}

function resolveTrajectoryLogger(
  runtime: IAgentRuntime,
): TrajectoryLoggerLike | null {
  const runtimeLike = runtime as unknown as {
    getServicesByType?: (serviceType: string) => unknown;
    getService?: (serviceType: string) => unknown;
  };

  const candidates: TrajectoryLoggerLike[] = [];
  const seen = new Set<unknown>();
  const push = (candidate: unknown): void => {
    if (!candidate || typeof candidate !== "object" || seen.has(candidate))
      return;
    seen.add(candidate);
    candidates.push(candidate as TrajectoryLoggerLike);
  };

  if (typeof runtimeLike.getServicesByType === "function") {
    const byType = runtimeLike.getServicesByType("trajectory_logger");
    if (Array.isArray(byType)) {
      for (const item of byType) push(item);
    } else {
      push(byType);
    }
  }
  if (typeof runtimeLike.getService === "function") {
    push(runtimeLike.getService("trajectory_logger"));
  }

  if (candidates.length === 0) return null;

  let best: TrajectoryLoggerLike | null = null;
  let bestScore = -1;
  for (const candidate of candidates) {
    let score = 0;
    if (isLegacyTrajectoryLogger(candidate)) score += 100;
    if (typeof candidate.logLlmCall === "function") score += 10;
    if (typeof candidate.logProviderAccess === "function") score += 10;
    if (typeof candidate.getLlmCallLogs === "function") score += 2;
    if (typeof candidate.getProviderAccessLogs === "function") score += 2;
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  return best;
}

function enqueueStepWrite(
  runtime: IAgentRuntime,
  stepId: string,
  work: () => Promise<void>,
): Promise<void> {
  const runtimeKey = runtime as unknown as object;
  let perStep = stepWriteQueues.get(runtimeKey);
  if (!perStep) {
    perStep = new Map<string, Promise<void>>();
    stepWriteQueues.set(runtimeKey, perStep);
  }

  const previous = perStep.get(stepId) ?? Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(work)
    .catch((err: unknown) => {
      warnRuntime(
        runtime,
        "Failed to write trajectory update to database",
        err,
      );
    })
    .finally(() => {
      const latest = perStep?.get(stepId);
      if (latest === current) {
        perStep?.delete(stepId);
      }
    });

  perStep.set(stepId, current);
  return current;
}

function createBaseTrajectory(
  stepId: string,
  now: number,
  source?: string,
  metadata?: Record<string, unknown>,
): PersistedTrajectory {
  const normalizedSource = source?.trim() || "runtime";
  const createdAt = new Date(now).toISOString();
  return {
    id: stepId,
    source: normalizedSource,
    status: "active",
    startTime: now,
    endTime: null,
    steps: [
      {
        stepId,
        stepNumber: 0,
        timestamp: now,
        llmCalls: [],
        providerAccesses: [],
      },
    ],
    metadata: {
      ...(metadata ?? {}),
    },
    totalReward: 0,
    createdAt,
    updatedAt: createdAt,
  };
}

function ensureStep(
  trajectory: PersistedTrajectory,
  stepId: string,
  now: number,
): PersistedStep {
  let step = trajectory.steps.find((item) => item.stepId === stepId);
  if (!step) {
    step = {
      stepId,
      stepNumber: trajectory.steps.length,
      timestamp: now,
      llmCalls: [],
      providerAccesses: [],
    };
    trajectory.steps.push(step);
  }
  return step;
}

function mergeMetadata(
  existing: Record<string, unknown>,
  incoming?: Record<string, unknown>,
): Record<string, unknown> {
  if (!incoming) return existing;
  const merged: Record<string, unknown> = { ...existing };
  for (const [key, value] of Object.entries(incoming)) {
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

function collectTrajectoryTimestamps(
  trajectory: PersistedTrajectory,
): number[] {
  const timestamps: number[] = [trajectory.startTime];
  for (const step of trajectory.steps) {
    timestamps.push(step.timestamp);
    for (const call of step.llmCalls) {
      timestamps.push(call.timestamp);
    }
    for (const access of step.providerAccesses) {
      timestamps.push(access.timestamp);
    }
  }
  return timestamps.filter((value) => Number.isFinite(value));
}

function summarizeTrajectory(trajectory: PersistedTrajectory): {
  startTime: number;
  endTime: number;
  llmCallCount: number;
  providerAccessCount: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
} {
  const timestamps = collectTrajectoryTimestamps(trajectory);
  const startTime =
    timestamps.length > 0 ? Math.min(...timestamps) : Date.now();
  const endTime = timestamps.length > 0 ? Math.max(...timestamps) : startTime;

  let llmCallCount = 0;
  let providerAccessCount = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;

  for (const step of trajectory.steps) {
    llmCallCount += step.llmCalls.length;
    providerAccessCount += step.providerAccesses.length;
    for (const call of step.llmCalls) {
      totalPromptTokens += call.promptTokens ?? 0;
      totalCompletionTokens += call.completionTokens ?? 0;
    }
  }

  return {
    startTime,
    endTime,
    llmCallCount,
    providerAccessCount,
    totalPromptTokens,
    totalCompletionTokens,
  };
}

async function loadTrajectoryById(
  runtime: IAgentRuntime,
  stepId: string,
): Promise<PersistedTrajectory | null> {
  const safeId = sqlQuote(stepId);
  try {
    const result = await executeRawSql(
      runtime,
      `SELECT * FROM trajectories WHERE id = ${safeId} LIMIT 1`,
    );
    const rows = extractRows(result);
    if (rows.length === 0) return null;
    const row = asRecord(rows[0]);
    if (!row) return null;

    const startTime = toNumber(
      readRecordValue(row, ["start_time", "startTime"]),
      Date.now(),
    );
    const endTime =
      toOptionalNumber(readRecordValue(row, ["end_time", "endTime"])) ?? null;
    const steps = parseSteps(
      readRecordValue(row, ["steps_json", "stepsJson", "steps"]),
    );

    return {
      id: toText(
        readRecordValue(row, ["id", "trajectory_id", "trajectoryId"]),
        stepId,
      ),
      source: toText(readRecordValue(row, ["source"]), "runtime"),
      status: normalizeStatus(readRecordValue(row, ["status"]), "completed"),
      startTime,
      endTime,
      steps,
      metadata: parseMetadata(readRecordValue(row, ["metadata", "meta"])),
      totalReward: toNumber(
        readRecordValue(row, ["total_reward", "totalReward"]),
        0,
      ),
      createdAt: toText(
        readRecordValue(row, ["created_at", "createdAt"]),
        new Date(startTime).toISOString(),
      ),
      updatedAt: toText(
        readRecordValue(row, ["updated_at", "updatedAt"]),
        new Date(endTime ?? startTime).toISOString(),
      ),
    };
  } catch {
    return null;
  }
}

async function saveTrajectory(
  runtime: IAgentRuntime,
  trajectory: PersistedTrajectory,
): Promise<boolean> {
  const summary = summarizeTrajectory(trajectory);
  const isActive = trajectory.status === "active";
  const endTime = isActive ? null : (trajectory.endTime ?? summary.endTime);
  const durationMs =
    typeof endTime === "number"
      ? Math.max(0, endTime - summary.startTime)
      : null;
  const createdAt =
    trajectory.createdAt || new Date(summary.startTime).toISOString();
  const updatedAt =
    trajectory.updatedAt || new Date(endTime ?? summary.endTime).toISOString();

  const sql = `INSERT INTO trajectories (
      id,
      trajectory_id,
      agent_id,
      source,
      status,
      start_time,
      end_time,
      duration_ms,
      step_count,
      llm_call_count,
      provider_access_count,
      total_prompt_tokens,
      total_completion_tokens,
      total_reward,
      steps_json,
      metadata,
      created_at,
      updated_at,
      episode_length
    ) VALUES (
      ${sqlQuote(trajectory.id)},
      ${sqlQuote(trajectory.id)},
      ${sqlQuote(runtime.agentId)},
      ${sqlQuote(trajectory.source)},
      ${sqlQuote(trajectory.status)},
      ${sqlNumber(summary.startTime)},
      ${sqlNumber(endTime)},
      ${sqlNumber(durationMs)},
      ${sqlNumber(trajectory.steps.length)},
      ${sqlNumber(summary.llmCallCount)},
      ${sqlNumber(summary.providerAccessCount)},
      ${sqlNumber(summary.totalPromptTokens)},
      ${sqlNumber(summary.totalCompletionTokens)},
      ${sqlNumber(trajectory.totalReward)},
      ${sqlQuote(JSON.stringify(trajectory.steps))},
      ${sqlQuote(JSON.stringify(trajectory.metadata))},
      ${sqlQuote(createdAt)},
      ${sqlQuote(updatedAt)},
      ${sqlNumber(trajectory.steps.length)}
    )
    ON CONFLICT (id) DO UPDATE SET
      trajectory_id = EXCLUDED.trajectory_id,
      agent_id = EXCLUDED.agent_id,
      source = EXCLUDED.source,
      status = EXCLUDED.status,
      start_time = EXCLUDED.start_time,
      end_time = EXCLUDED.end_time,
      duration_ms = EXCLUDED.duration_ms,
      step_count = EXCLUDED.step_count,
      llm_call_count = EXCLUDED.llm_call_count,
      provider_access_count = EXCLUDED.provider_access_count,
      total_prompt_tokens = EXCLUDED.total_prompt_tokens,
      total_completion_tokens = EXCLUDED.total_completion_tokens,
      total_reward = EXCLUDED.total_reward,
      steps_json = EXCLUDED.steps_json,
      metadata = EXCLUDED.metadata,
      created_at = EXCLUDED.created_at,
      updated_at = EXCLUDED.updated_at,
      episode_length = EXCLUDED.episode_length`;

  try {
    await executeRawSql(runtime, sql);
    return true;
  } catch (err) {
    console.error("[trajectory-persistence] saveTrajectory error:", err);
    return false;
  }
}

/**
 * Read orchestrator trajectory context from the runtime, if set.
 * The coding agent orchestrator plugin sets `__orchestratorTrajectoryCtx` on
 * the runtime around `useModel()` calls so we can tag them here.
 */
/** @internal Exported for testing. */
export function readOrchestratorTrajectoryContext(runtime: unknown):
  | {
      source: "orchestrator";
      decisionType: string;
      sessionId?: string;
      taskLabel?: string;
      repo?: string;
      workdir?: string;
      originalTask?: string;
    }
  | undefined {
  if (!runtime || typeof runtime !== "object") return undefined;
  const ctx = (runtime as Record<string, unknown>).__orchestratorTrajectoryCtx;
  if (!ctx || typeof ctx !== "object") return undefined;
  const candidate = ctx as Record<string, unknown>;
  if (
    candidate.source !== "orchestrator" ||
    typeof candidate.decisionType !== "string"
  )
    return undefined;
  return candidate as {
    source: "orchestrator";
    decisionType: string;
    sessionId?: string;
    taskLabel?: string;
    repo?: string;
    workdir?: string;
    originalTask?: string;
  };
}

async function appendLlmCall(
  runtime: IAgentRuntime,
  stepId: string,
  params: Record<string, unknown>,
): Promise<void> {
  if (shouldSuppressNoInputEmbeddingCall(params)) return;

  const now = toNumber(params.timestamp, Date.now());
  const trajectory =
    (await loadTrajectoryById(runtime, stepId)) ??
    createBaseTrajectory(stepId, now);

  trajectory.source = trajectory.source || "runtime";
  trajectory.status =
    trajectory.status === "active" ? "active" : trajectory.status;

  // Check for orchestrator trajectory context set by the coding agent plugin.
  // When present, it overrides the generic "action" / "runtime.useModel" defaults
  // so orchestrator LLM calls are identifiable in the trajectories viewer.
  const orchestratorCtx = readOrchestratorTrajectoryContext(runtime);

  // Extract insights from the full response and persist them into metadata
  // so the feedback loop can read summaries without loading full details.
  const fullResponse = toText(params.response, "");
  const purpose =
    orchestratorCtx?.decisionType ?? toText(params.purpose, "action");
  const insights = extractInsightsFromResponse(fullResponse, purpose);

  const step = ensureStep(trajectory, stepId, now);
  const call: PersistedLlmCall = {
    callId: toText(params.callId, `${stepId}-call-${step.llmCalls.length + 1}`),
    timestamp: now,
    model: toText(params.model, "unknown"),
    // Keep full prompts/responses for training data fidelity.
    systemPrompt: toText(params.systemPrompt, ""),
    userPrompt: toText(params.userPrompt ?? params.input, ""),
    response: fullResponse,
    temperature: toNumber(params.temperature, 0),
    maxTokens: toNumber(params.maxTokens, 0),
    purpose,
    actionType: orchestratorCtx
      ? "orchestrator.useModel"
      : toText(params.actionType, "runtime.useModel"),
    latencyMs: toNumber(params.latencyMs, 0),
  };

  const promptTokens = toOptionalNumber(params.promptTokens);
  const completionTokens = toOptionalNumber(params.completionTokens);
  if (promptTokens !== undefined) call.promptTokens = promptTokens;
  if (completionTokens !== undefined) call.completionTokens = completionTokens;

  step.llmCalls.push(call);
  trajectory.startTime = Math.min(trajectory.startTime, now);
  trajectory.endTime = Math.max(trajectory.endTime ?? now, now);
  trajectory.updatedAt = new Date(now).toISOString();

  // Store extracted insights in metadata for lightweight querying
  if (insights.length > 0) {
    const meta = (trajectory.metadata ?? {}) as Record<string, unknown>;
    const existing = Array.isArray(meta.insights)
      ? (meta.insights as string[])
      : [];
    meta.insights = [...existing, ...insights].slice(-20);
    trajectory.metadata = meta;
  }

  // Buffer chat exchanges for background LLM observation extraction.
  // The buffer flushes after 5 messages or 10 minutes, whichever comes first.
  if (
    !orchestratorCtx &&
    trajectory.source === "chat" &&
    shouldRunObservationExtraction(runtime)
  ) {
    pushChatExchange(runtime, {
      userPrompt: toText(params.userPrompt ?? params.input, ""),
      response: fullResponse,
      trajectoryId: trajectory.id,
      timestamp: now,
    });
  }

  // Merge orchestrator metadata into trajectory metadata for filtering/display
  if (orchestratorCtx) {
    trajectory.source = "orchestrator";
    const meta = (trajectory.metadata ?? {}) as Record<string, unknown>;
    meta.orchestrator = {
      decisionType: orchestratorCtx.decisionType,
      ...(orchestratorCtx.sessionId && {
        sessionId: orchestratorCtx.sessionId,
      }),
      ...(orchestratorCtx.taskLabel && {
        taskLabel: orchestratorCtx.taskLabel,
      }),
      ...(orchestratorCtx.repo && {
        repo: orchestratorCtx.repo,
      }),
      ...(orchestratorCtx.workdir && {
        workdir: orchestratorCtx.workdir,
      }),
      ...(orchestratorCtx.originalTask && {
        originalTask: orchestratorCtx.originalTask,
      }),
    };
    trajectory.metadata = meta;
  }

  await saveTrajectory(runtime, trajectory);
}

async function appendProviderAccess(
  runtime: IAgentRuntime,
  stepId: string,
  params: Record<string, unknown>,
): Promise<void> {
  const now = toNumber(params.timestamp, Date.now());
  const trajectory =
    (await loadTrajectoryById(runtime, stepId)) ??
    createBaseTrajectory(stepId, now);

  trajectory.source = trajectory.source || "runtime";
  trajectory.status =
    trajectory.status === "active" ? "active" : trajectory.status;

  const step = ensureStep(trajectory, stepId, now);
  const access: PersistedProviderAccess = {
    providerId: toText(
      params.providerId,
      `${stepId}-provider-${step.providerAccesses.length + 1}`,
    ),
    providerName: toText(params.providerName, "unknown"),
    timestamp: now,
    data: truncateRecord(asRecord(params.data) ?? {}),
    query: (() => {
      const queryRecord = asRecord(params.query);
      return queryRecord ? truncateRecord(queryRecord) : undefined;
    })(),
    purpose: toText(params.purpose, "provider"),
  };

  step.providerAccesses.push(access);
  trajectory.startTime = Math.min(trajectory.startTime, now);
  trajectory.endTime = Math.max(trajectory.endTime ?? now, now);
  trajectory.updatedAt = new Date(now).toISOString();

  await saveTrajectory(runtime, trajectory);
}

export function installDatabaseTrajectoryLogger(runtime: IAgentRuntime): void {
  if (!hasRuntimeDb(runtime)) {
    console.warn(
      "[trajectory-persistence] installDatabaseTrajectoryLogger: no database adapter found on runtime",
    );
    return;
  }

  const logger = resolveTrajectoryLogger(runtime);
  if (!logger) {
    console.warn(
      "[trajectory-persistence] installDatabaseTrajectoryLogger: no logger found to patch",
    );
    return;
  }
  console.warn(
    "[trajectory-persistence] installDatabaseTrajectoryLogger: patched logger!",
  );

  const loggerObject = logger as unknown as object;
  if (patchedLoggers.has(loggerObject)) return;

  const shouldEnableByDefault = shouldEnableTrajectoryLoggingByDefault();
  const isEnabled =
    typeof logger.isEnabled === "function"
      ? logger.isEnabled()
      : shouldEnableByDefault;
  if (
    typeof logger.setEnabled === "function" &&
    isEnabled !== shouldEnableByDefault
  ) {
    try {
      logger.setEnabled(shouldEnableByDefault);
    } catch {
      // Ignore logger enable failures and continue.
    }
  }

  if (Array.isArray(logger.llmCalls)) {
    logger.llmCalls.splice(0, logger.llmCalls.length);
  }
  if (Array.isArray(logger.providerAccess)) {
    logger.providerAccess.splice(0, logger.providerAccess.length);
  }

  type VariadicLoggerCall = (...args: unknown[]) => unknown;
  const originalLogLlmCall =
    typeof logger.logLlmCall === "function"
      ? ((logger.logLlmCall as unknown as VariadicLoggerCall).bind(
          logger,
        ) as VariadicLoggerCall)
      : null;
  const originalLogProviderAccess =
    typeof logger.logProviderAccess === "function"
      ? ((logger.logProviderAccess as unknown as VariadicLoggerCall).bind(
          logger,
        ) as VariadicLoggerCall)
      : null;

  logger.logLlmCall = ((...args: unknown[]) => {
    if (originalLogLlmCall) {
      try {
        originalLogLlmCall(...args);
      } catch (err) {
        warnRuntime(runtime, "Trajectory logger logLlmCall threw", err);
      }
    }

    const normalized = normalizeLlmCallPayload(args);
    if (!normalized) return;

    const writePromise = enqueueStepWrite(
      runtime,
      normalized.stepId,
      async () => {
        const tableReady = await ensureTrajectoriesTable(runtime);
        if (!tableReady) return;
        await appendLlmCall(runtime, normalized.stepId, normalized.params);
      },
    );
    const runtimeKey = runtime as unknown as object;
    lastWritePromises.set(runtimeKey, writePromise);
  }) as unknown as (params: Record<string, unknown>) => void;

  logger.logProviderAccess = ((...args: unknown[]) => {
    if (originalLogProviderAccess) {
      try {
        originalLogProviderAccess(...args);
      } catch (err) {
        warnRuntime(runtime, "Trajectory logger logProviderAccess threw", err);
      }
    }

    const normalized = normalizeProviderAccessPayload(args);
    if (!normalized) return;

    const writePromise = enqueueStepWrite(
      runtime,
      normalized.stepId,
      async () => {
        const tableReady = await ensureTrajectoriesTable(runtime);
        if (!tableReady) return;
        await appendProviderAccess(
          runtime,
          normalized.stepId,
          normalized.params,
        );
      },
    );
    const runtimeKey = runtime as unknown as object;
    lastWritePromises.set(runtimeKey, writePromise);
  }) as unknown as (params: Record<string, unknown>) => void;

  logger.getLlmCallLogs = () => [];
  logger.getProviderAccessLogs = () => [];

  // Add startTrajectory, startStep, endTrajectory methods expected by plugin-trajectory-logger
  // and query methods for API endpoints
  const loggerAny = logger as unknown as {
    startTrajectory?: (
      stepIdOrAgentId: string,
      options?: {
        agentId?: string;
        roomId?: string;
        entityId?: string;
        source?: string;
        metadata?: Record<string, unknown>;
      },
    ) => Promise<string>;
    startStep?: (trajectoryId: string) => string;
    endTrajectory?: (
      stepIdOrTrajectoryId: string,
      status?: string,
    ) => Promise<void>;
    listTrajectories?: (
      options?: TrajectoryListOptions,
    ) => Promise<TrajectoryListResult>;
    getTrajectoryDetail?: (trajectoryId: string) => Promise<Trajectory | null>;
    getStats?: () => Promise<unknown>;
  };

  loggerAny.startTrajectory = async (
    stepIdOrAgentId: string,
    options?: {
      agentId?: string;
      roomId?: string;
      entityId?: string;
      source?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<string> => {
    const isLegacySignature = typeof options?.agentId === "string";
    const stepId = isLegacySignature
      ? stepIdOrAgentId
      : `step-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const writePromise = enqueueStepWrite(runtime, stepId, async () => {
      const tableReady = await ensureTrajectoriesTable(runtime);
      if (!tableReady) return;

      await startTrajectoryStepInDatabase({
        runtime,
        stepId,
        source: options?.source ?? "chat",
        metadata: options?.metadata,
      });
    });

    const runtimeKey = runtime as unknown as object;
    lastWritePromises.set(runtimeKey, writePromise);

    return stepId;
  };

  loggerAny.startStep = (_trajectoryId: string): string => {
    return `step-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  };

  loggerAny.endTrajectory = async (
    stepIdOrTrajectoryId: string,
    status = "completed",
  ): Promise<void> => {
    const writePromise = enqueueStepWrite(
      runtime,
      stepIdOrTrajectoryId,
      async () => {
        const tableReady = await ensureTrajectoriesTable(runtime);
        if (!tableReady) return;

        await completeTrajectoryStepInDatabase({
          runtime,
          stepId: stepIdOrTrajectoryId,
          status: status as TrajectoryStatus,
        });
      },
    );

    const runtimeKey = runtime as unknown as object;
    lastWritePromises.set(runtimeKey, writePromise);
  };

  // Add query methods for API endpoints
  loggerAny.listTrajectories = async (
    options: TrajectoryListOptions = {},
  ): Promise<TrajectoryListResult> => {
    if (!hasRuntimeDb(runtime)) {
      return { trajectories: [], total: 0, offset: 0, limit: 50 };
    }

    const tableReady = await ensureTrajectoriesTable(runtime);
    if (!tableReady) {
      return { trajectories: [], total: 0, offset: 0, limit: 50 };
    }

    const limit = Math.min(500, Math.max(1, options.limit ?? 50));
    const offset = Math.max(0, options.offset ?? 0);

    const whereClauses: string[] = [];
    if (options.source) {
      whereClauses.push(`source = ${sqlQuote(options.source)}`);
    }
    if (options.status) {
      whereClauses.push(`status = ${sqlQuote(options.status)}`);
    }
    if (options.startDate) {
      const startTime = new Date(options.startDate).getTime();
      if (Number.isFinite(startTime)) {
        whereClauses.push(`start_time >= ${startTime}`);
      }
    }
    if (options.endDate) {
      const endTime = new Date(options.endDate).getTime();
      if (Number.isFinite(endTime)) {
        whereClauses.push(`start_time <= ${endTime}`);
      }
    }
    if (options.search) {
      const searchPattern = `%${options.search.replace(/[%_]/g, "\\$&")}%`;
      whereClauses.push(`id LIKE ${sqlQuote(searchPattern)}`);
    }

    const whereClause =
      whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

    try {
      const countResult = await executeRawSql(
        runtime,
        `SELECT count(*) AS total FROM trajectories ${whereClause}`,
      );
      const countRow = asRecord(extractRows(countResult)[0]);
      const total = toNumber(countRow?.total, 0);

      const result = await executeRawSql(
        runtime,
        `SELECT * FROM trajectories ${whereClause} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`,
      );

      const rows = extractRows(result);
      const trajectories: TrajectoryListItem[] = rows
        .map((row) => {
          const r = asRecord(row);
          if (!r) return null;
          return {
            id: toText(r.id ?? r.trajectory_id, ""),
            agentId: toText(r.agent_id, runtime.agentId),
            source: toText(r.source, "runtime"),
            status: normalizeStatus(r.status, "completed"),
            startTime: toNumber(r.start_time, Date.now()),
            endTime: toOptionalNumber(r.end_time) ?? null,
            durationMs: toOptionalNumber(r.duration_ms) ?? null,
            stepCount: toNumber(r.step_count, 0),
            llmCallCount: toNumber(r.llm_call_count, 0),
            providerAccessCount: toNumber(r.provider_access_count, 0),
            totalPromptTokens: toNumber(r.total_prompt_tokens, 0),
            totalCompletionTokens: toNumber(r.total_completion_tokens, 0),
            createdAt: toText(
              r.created_at,
              new Date(toNumber(r.start_time, Date.now())).toISOString(),
            ),
            metadata: parseMetadata(r.metadata),
          };
        })
        .filter(Boolean) as TrajectoryListItem[];

      return { trajectories, total, offset, limit };
    } catch (err) {
      console.error("[trajectory-persistence] listTrajectories error:", err);
      return { trajectories: [], total: 0, offset, limit };
    }
  };

  loggerAny.getTrajectoryDetail = async (
    trajectoryId: string,
  ): Promise<Trajectory | null> => {
    if (!hasRuntimeDb(runtime)) return null;

    const tableReady = await ensureTrajectoriesTable(runtime);
    if (!tableReady) return null;

    const persisted = await loadTrajectoryById(runtime, trajectoryId);
    if (!persisted) return null;

    return {
      trajectoryId: persisted.id,
      agentId: runtime.agentId,
      startTime: persisted.startTime,
      endTime: persisted.endTime ?? undefined,
      durationMs: persisted.endTime
        ? persisted.endTime - persisted.startTime
        : undefined,
      steps: persisted.steps.map((step) => ({
        stepId: step.stepId,
        timestamp: step.timestamp,
        llmCalls: step.llmCalls,
        providerAccesses: step.providerAccesses,
      })),
      metrics: { finalStatus: persisted.status },
      metadata: persisted.metadata,
      stepsJson: JSON.stringify(persisted.steps),
    };
  };

  loggerAny.getStats = async (): Promise<unknown> => {
    if (!hasRuntimeDb(runtime)) {
      return { total: 0, byStatus: {}, bySource: {} };
    }

    const tableReady = await ensureTrajectoriesTable(runtime);
    if (!tableReady) {
      return { total: 0, byStatus: {}, bySource: {} };
    }

    try {
      const countResult = await executeRawSql(
        runtime,
        "SELECT count(*) AS total FROM trajectories",
      );
      const countRow = asRecord(extractRows(countResult)[0]);
      const total = toNumber(countRow?.total, 0);

      const bySource = await computeBySource(runtime);

      return {
        total,
        enabled: true,
        byStatus: {},
        bySource,
      };
    } catch {
      return { total: 0, byStatus: {}, bySource: {} };
    }
  };

  patchedLoggers.add(loggerObject);

  void ensureTrajectoriesTable(runtime);
}

export async function startTrajectoryStepInDatabase({
  runtime,
  stepId,
  source,
  metadata,
}: StartStepOptions): Promise<boolean> {
  if (!hasRuntimeDb(runtime)) return false;
  const normalizedStepId = normalizeStepId(stepId);
  if (!normalizedStepId) return false;

  const tableReady = await ensureTrajectoriesTable(runtime);
  if (!tableReady) return false;

  await enqueueStepWrite(runtime, normalizedStepId, async () => {
    const now = Date.now();
    const trajectory =
      (await loadTrajectoryById(runtime, normalizedStepId)) ??
      createBaseTrajectory(normalizedStepId, now, source, metadata);

    trajectory.source = source?.trim() || trajectory.source || "runtime";
    trajectory.status = "active";
    trajectory.metadata = mergeMetadata(trajectory.metadata, metadata);
    trajectory.startTime = Math.min(trajectory.startTime, now);
    trajectory.endTime = null;
    ensureStep(trajectory, normalizedStepId, now);
    trajectory.updatedAt = new Date(now).toISOString();

    await saveTrajectory(runtime, trajectory);
  });

  return true;
}

export async function completeTrajectoryStepInDatabase({
  runtime,
  stepId,
  status = "completed",
  source,
  metadata,
}: CompleteStepOptions): Promise<boolean> {
  if (!hasRuntimeDb(runtime)) return false;
  const normalizedStepId = normalizeStepId(stepId);
  if (!normalizedStepId) return false;

  const tableReady = await ensureTrajectoriesTable(runtime);
  if (!tableReady) return false;

  await enqueueStepWrite(runtime, normalizedStepId, async () => {
    const now = Date.now();
    const trajectory =
      (await loadTrajectoryById(runtime, normalizedStepId)) ??
      createBaseTrajectory(normalizedStepId, now, source, metadata);

    trajectory.source = source?.trim() || trajectory.source || "runtime";
    trajectory.status = normalizeStatus(status, "completed");
    trajectory.metadata = mergeMetadata(trajectory.metadata, metadata);
    trajectory.endTime = Math.max(trajectory.endTime ?? now, now);
    trajectory.startTime = Math.min(trajectory.startTime, now);
    ensureStep(trajectory, normalizedStepId, now);
    trajectory.updatedAt = new Date(now).toISOString();

    await saveTrajectory(runtime, trajectory);
  });

  return true;
}

export async function loadPersistedTrajectoryRows(
  runtime: IAgentRuntime,
  maxRows = 5000,
): Promise<Record<string, unknown>[] | null> {
  if (!hasRuntimeDb(runtime)) return null;
  const tableReady = await ensureTrajectoriesTable(runtime);
  if (!tableReady) return [];

  const safeLimit = Math.max(1, Math.min(10000, Math.trunc(maxRows)));
  try {
    const result = await executeRawSql(
      runtime,
      `SELECT * FROM trajectories ORDER BY created_at DESC LIMIT ${safeLimit}`,
    );
    const rows = extractRows(result);
    return rows
      .map((row) => asRecord(row))
      .filter((row): row is Record<string, unknown> => Boolean(row));
  } catch {
    return null;
  }
}

export async function deletePersistedTrajectoryRows(
  runtime: IAgentRuntime,
  trajectoryIds: string[],
): Promise<number | null> {
  if (!hasRuntimeDb(runtime)) return null;
  const tableReady = await ensureTrajectoriesTable(runtime);
  if (!tableReady) return 0;

  const normalized = trajectoryIds
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  if (normalized.length === 0) return 0;

  const values = normalized.map((id) => sqlQuote(id)).join(", ");
  try {
    const result = await executeRawSql(
      runtime,
      `DELETE FROM trajectories WHERE id IN (${values}) RETURNING id`,
    );
    return extractRows(result).length;
  } catch {
    try {
      await executeRawSql(
        runtime,
        `DELETE FROM trajectories WHERE id IN (${values})`,
      );
      return normalized.length;
    } catch {
      return null;
    }
  }
}

export async function clearPersistedTrajectoryRows(
  runtime: IAgentRuntime,
): Promise<number | null> {
  if (!hasRuntimeDb(runtime)) return null;
  const tableReady = await ensureTrajectoriesTable(runtime);
  if (!tableReady) return 0;

  try {
    const countResult = await executeRawSql(
      runtime,
      "SELECT count(*) AS total FROM trajectories",
    );
    const countRow = asRecord(extractRows(countResult)[0]);
    const total = toNumber(countRow?.total, 0);
    await executeRawSql(runtime, "DELETE FROM trajectories");
    return total;
  } catch {
    return null;
  }
}

function toArchiveSafeTimestamp(isoTimestamp: string): string {
  return isoTimestamp.replace(/[:.]/g, "-");
}

function stringifyArchiveRow(row: Record<string, unknown>): string {
  return JSON.stringify(row, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value,
  );
}

async function writeCompressedJsonlRows(
  archivePath: string,
  rows: Record<string, unknown>[],
): Promise<void> {
  const gzipStream = createGzip({ level: 9 });
  const outStream = createWriteStream(archivePath);
  gzipStream.pipe(outStream);

  for (const row of rows) {
    if (!gzipStream.write(`${stringifyArchiveRow(row)}\n`, "utf8")) {
      await once(gzipStream, "drain");
    }
  }

  gzipStream.end();
  await once(outStream, "finish");
}

async function exportRawTrajectoriesToCompressedArchive(
  runtime: IAgentRuntime,
  cutoff: string,
  archivedAt: string,
): Promise<{ archivePath: string; rowCount: number }> {
  const rawRowsResult = await executeRawSql(
    runtime,
    `SELECT
      id, trajectory_id, agent_id, source, status, start_time, end_time,
      duration_ms, step_count, llm_call_count, provider_access_count,
      total_prompt_tokens, total_completion_tokens, total_reward, steps_json,
      metadata, created_at, updated_at, episode_length, ai_judge_reward,
      ai_judge_reasoning, archetype
    FROM trajectories
    WHERE created_at < ${sqlQuote(cutoff)}`,
  );
  const rawRows = extractRows(rawRowsResult)
    .map((row) => asRecord(row))
    .filter(Boolean) as Record<string, unknown>[];

  if (rawRows.length === 0) {
    return { archivePath: "", rowCount: 0 };
  }

  const archiveDir = await resolveTrajectoryArchiveDirectory();
  const archiveName = `trajectories-before-${toArchiveSafeTimestamp(cutoff)}-archived-${toArchiveSafeTimestamp(archivedAt)}.jsonl.gz`;
  const archivePath = path.join(archiveDir, archiveName);
  await writeCompressedJsonlRows(archivePath, rawRows);

  return { archivePath, rowCount: rawRows.length };
}

/**
 * Archive and then delete trajectories older than `maxAgeDays`.
 * Summary rows (without steps_json) are copied to `trajectory_archive`
 * before the heavy raw data is removed. Returns the number of rows
 * pruned, or null if the DB is unavailable.
 */
export async function pruneOldTrajectories(
  runtime: IAgentRuntime,
  maxAgeDays = 30,
): Promise<number | null> {
  if (!hasRuntimeDb(runtime)) return null;
  const tableReady = await ensureTrajectoriesTable(runtime);
  if (!tableReady) return 0;

  const cutoff = new Date(
    Date.now() - maxAgeDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  const archivedAt = new Date().toISOString();

  try {
    // Step 1: Persist full training rows to compressed local archive.
    // If this fails, abort pruning to avoid data loss.
    let archivePath = "";
    try {
      const archived = await exportRawTrajectoriesToCompressedArchive(
        runtime,
        cutoff,
        archivedAt,
      );
      archivePath = archived.archivePath;
      if (archived.rowCount > 0 && !archivePath) {
        return 0;
      }
    } catch (err) {
      console.warn(
        "[trajectory-persistence] Could not write compressed trajectory archive, skipping prune",
        err,
      );
      return null;
    }

    // Step 2: Copy summary rows to archive table (idempotent).
    // This must succeed before deletion to preserve the summary index contract.
    let summaryArchived = false;
    try {
      await executeRawSql(
        runtime,
        `INSERT OR IGNORE INTO trajectory_archive (
          id, agent_id, source, status, start_time, end_time, duration_ms,
          step_count, llm_call_count, provider_access_count,
          total_prompt_tokens, total_completion_tokens, total_reward,
          metadata, observations, archive_blob_path, created_at, updated_at, archived_at
        )
        SELECT
          id, agent_id, source, status, start_time, end_time, duration_ms,
          step_count, llm_call_count, provider_access_count,
          total_prompt_tokens, total_completion_tokens, total_reward,
          metadata,
          COALESCE(json_extract(metadata, '$.observations'), '[]'),
          ${sqlQuote(archivePath)},
          created_at, updated_at,
          ${sqlQuote(archivedAt)}
        FROM trajectories
        WHERE created_at < ${sqlQuote(cutoff)}`,
      );
      summaryArchived = true;
    } catch {
      // PostgreSQL uses ON CONFLICT DO NOTHING instead of INSERT OR IGNORE
      try {
        await executeRawSql(
          runtime,
          `INSERT INTO trajectory_archive (
            id, agent_id, source, status, start_time, end_time, duration_ms,
            step_count, llm_call_count, provider_access_count,
            total_prompt_tokens, total_completion_tokens, total_reward,
            metadata, observations, archive_blob_path, created_at, updated_at, archived_at
          )
          SELECT
            id, agent_id, source, status, start_time, end_time, duration_ms,
            step_count, llm_call_count, provider_access_count,
            total_prompt_tokens, total_completion_tokens, total_reward,
            metadata,
            COALESCE(metadata::json->>'observations', '[]'),
            ${sqlQuote(archivePath)},
            created_at, updated_at,
            ${sqlQuote(archivedAt)}
          FROM trajectories
          WHERE created_at < ${sqlQuote(cutoff)}
          ON CONFLICT (id) DO NOTHING`,
        );
        summaryArchived = true;
      } catch {
        console.warn(
          "[trajectory-persistence] Could not write summary trajectory archive rows",
        );
      }
    }

    if (!summaryArchived) {
      console.warn(
        "[trajectory-persistence] Summary archive insert failed, skipping prune delete",
      );
      return null;
    }

    // Step 3: Delete the archived rows from the main table.
    const countResult = await executeRawSql(
      runtime,
      `SELECT count(*) AS total FROM trajectories WHERE created_at < ${sqlQuote(cutoff)}`,
    );
    const countRow = asRecord(extractRows(countResult)[0]);
    const count = toNumber(countRow?.total, 0);
    if (count > 0) {
      await executeRawSql(
        runtime,
        `DELETE FROM trajectories WHERE created_at < ${sqlQuote(cutoff)}`,
      );
    }
    return count;
  } catch {
    return null;
  }
}

/**
 * Wait for all pending trajectory writes to complete.
 * Useful for tests to ensure writes are flushed before assertions.
 */
export async function flushTrajectoryWrites(
  runtime: IAgentRuntime,
): Promise<void> {
  const runtimeKey = runtime as unknown as object;
  const perStep = stepWriteQueues.get(runtimeKey);
  if (perStep) {
    const pending = Array.from(perStep.values());
    if (pending.length > 0) {
      await Promise.all(pending);
    }
  }
  const lastWrite = lastWritePromises.get(runtimeKey);
  if (lastWrite) {
    await lastWrite;
  }
}

// ============================================================================
// DatabaseTrajectoryLogger - Full implementation for trajectory-routes.ts
// ============================================================================

/**
 * Database-backed trajectory logger service that implements the full API
 * expected by trajectory-routes.ts. This service reads from and writes to
 * the database for trajectory persistence.
 */
export class DatabaseTrajectoryLogger extends Service {
  static serviceType = "trajectory_logger";
  capabilityDescription =
    "Database-backed trajectory logging service for LLM call persistence";

  private enabled = shouldEnableTrajectoryLoggingByDefault();

  /**
   * Static start method required by @elizaos/core runtime.
   */
  static async start(runtime: IAgentRuntime): Promise<Service> {
    const service = new DatabaseTrajectoryLogger(runtime);
    await service.initialize();
    return service;
  }

  async initialize(): Promise<void> {
    if (hasRuntimeDb(this.runtime)) {
      await ensureTrajectoriesTable(this.runtime);
      // Fire-and-forget TTL pruning on startup
      pruneOldTrajectories(this.runtime, 30)
        .then((count) => {
          if (count && count > 0) {
            console.warn(
              `[trajectory-persistence] Pruned ${count} trajectories older than 30 days`,
            );
          }
        })
        .catch(() => {
          /* non-critical */
        });
    }
  }

  async stop(): Promise<void> {
    await flushTrajectoryWrites(this.runtime);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /**
   * Start a new trajectory for tracking LLM interactions.
   * Supports both legacy (stepId, {agentId}) and new (agentId, options) signatures.
   */
  async startTrajectory(
    stepIdOrAgentId: string,
    options?: {
      agentId?: string;
      roomId?: string;
      entityId?: string;
      source?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<string> {
    if (!this.enabled) return stepIdOrAgentId;

    const isLegacySignature = typeof options?.agentId === "string";
    const stepId = isLegacySignature
      ? stepIdOrAgentId
      : `step-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Initialize trajectory in database
    const writePromise = enqueueStepWrite(this.runtime, stepId, async () => {
      const tableReady = await ensureTrajectoriesTable(this.runtime);
      if (!tableReady) return;

      await startTrajectoryStepInDatabase({
        runtime: this.runtime,
        stepId,
        source: options?.source ?? "chat",
        metadata: options?.metadata,
      });
    });

    const runtimeKey = this.runtime as unknown as object;
    lastWritePromises.set(runtimeKey, writePromise);

    return stepId;
  }

  /**
   * Start a new step within an existing trajectory.
   */
  startStep(_trajectoryId: string): string {
    const stepId = `step-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    // For database logger, steps are independent - we just return the new stepId
    return stepId;
  }

  /**
   * End a trajectory and mark it with the given status.
   */
  async endTrajectory(
    stepIdOrTrajectoryId: string,
    status: TrajectoryStatus = "completed",
  ): Promise<void> {
    if (!this.enabled) return;

    const writePromise = enqueueStepWrite(
      this.runtime,
      stepIdOrTrajectoryId,
      async () => {
        const tableReady = await ensureTrajectoriesTable(this.runtime);
        if (!tableReady) return;

        await completeTrajectoryStepInDatabase({
          runtime: this.runtime,
          stepId: stepIdOrTrajectoryId,
          status,
        });
      },
    );

    const runtimeKey = this.runtime as unknown as object;
    lastWritePromises.set(runtimeKey, writePromise);
  }

  logLlmCall(params: Record<string, unknown>): void {
    if (!this.enabled) return;
    const normalized = normalizeLlmCallPayload([params]);
    if (!normalized) return;

    const writePromise = enqueueStepWrite(
      this.runtime,
      normalized.stepId,
      async () => {
        const tableReady = await ensureTrajectoriesTable(this.runtime);
        if (!tableReady) return;
        await appendLlmCall(this.runtime, normalized.stepId, normalized.params);
      },
    );
    const runtimeKey = this.runtime as unknown as object;
    lastWritePromises.set(runtimeKey, writePromise);
  }

  logProviderAccess(params: Record<string, unknown>): void {
    if (!this.enabled) return;
    const normalized = normalizeProviderAccessPayload([params]);
    if (!normalized) return;

    const writePromise = enqueueStepWrite(
      this.runtime,
      normalized.stepId,
      async () => {
        const tableReady = await ensureTrajectoriesTable(this.runtime);
        if (!tableReady) return;
        await appendProviderAccess(
          this.runtime,
          normalized.stepId,
          normalized.params,
        );
      },
    );
    const runtimeKey = this.runtime as unknown as object;
    lastWritePromises.set(runtimeKey, writePromise);
  }

  getLlmCallLogs(): readonly unknown[] {
    return [];
  }

  getProviderAccessLogs(): readonly unknown[] {
    return [];
  }

  async listTrajectories(
    options: TrajectoryListOptions,
  ): Promise<TrajectoryListResult> {
    if (!hasRuntimeDb(this.runtime)) {
      return { trajectories: [], total: 0, offset: 0, limit: 50 };
    }

    const tableReady = await ensureTrajectoriesTable(this.runtime);
    if (!tableReady) {
      return { trajectories: [], total: 0, offset: 0, limit: 50 };
    }

    const limit = Math.min(500, Math.max(1, options.limit ?? 50));
    const offset = Math.max(0, options.offset ?? 0);

    // Build WHERE clause
    const whereClauses: string[] = [];
    if (options.source) {
      whereClauses.push(`source = ${sqlQuote(options.source)}`);
    }
    if (options.status) {
      whereClauses.push(`status = ${sqlQuote(options.status)}`);
    }
    if (options.startDate) {
      const startTime = new Date(options.startDate).getTime();
      if (Number.isFinite(startTime)) {
        whereClauses.push(`start_time >= ${startTime}`);
      }
    }
    if (options.endDate) {
      const endTime = new Date(options.endDate).getTime();
      if (Number.isFinite(endTime)) {
        whereClauses.push(`start_time <= ${endTime}`);
      }
    }
    if (options.search) {
      const searchPattern = `%${options.search.replace(/[%_]/g, "\\$&")}%`;
      whereClauses.push(`id LIKE ${sqlQuote(searchPattern)}`);
    }

    const whereClause =
      whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

    try {
      // Get total count
      const countResult = await executeRawSql(
        this.runtime,
        `SELECT count(*) AS total FROM trajectories ${whereClause}`,
      );
      const countRow = asRecord(extractRows(countResult)[0]);
      const total = toNumber(countRow?.total, 0);

      // Get rows
      const result = await executeRawSql(
        this.runtime,
        `SELECT * FROM trajectories ${whereClause} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`,
      );

      const rows = extractRows(result);
      const trajectories: TrajectoryListItem[] = rows
        .map((row) => {
          const r = asRecord(row);
          if (!r) return null;
          return {
            id: toText(r.id ?? r.trajectory_id, ""),
            agentId: toText(r.agent_id, this.runtime.agentId),
            source: toText(r.source, "runtime"),
            status: normalizeStatus(r.status, "completed"),
            startTime: toNumber(r.start_time, Date.now()),
            endTime: toOptionalNumber(r.end_time) ?? null,
            durationMs: toOptionalNumber(r.duration_ms) ?? null,
            stepCount: toNumber(r.step_count, 0),
            llmCallCount: toNumber(r.llm_call_count, 0),
            providerAccessCount: toNumber(r.provider_access_count, 0),
            totalPromptTokens: toNumber(r.total_prompt_tokens, 0),
            totalCompletionTokens: toNumber(r.total_completion_tokens, 0),
            createdAt: toText(
              r.created_at,
              new Date(toNumber(r.start_time, Date.now())).toISOString(),
            ),
            metadata: parseMetadata(r.metadata),
          };
        })
        .filter(Boolean) as TrajectoryListItem[];

      return { trajectories, total, offset, limit };
    } catch (err) {
      console.error("[DatabaseTrajectoryLogger] listTrajectories error:", err);
      return { trajectories: [], total: 0, offset, limit };
    }
  }

  async getTrajectoryDetail(trajectoryId: string): Promise<Trajectory | null> {
    if (!hasRuntimeDb(this.runtime)) return null;

    const tableReady = await ensureTrajectoriesTable(this.runtime);
    if (!tableReady) return null;

    const persisted = await loadTrajectoryById(this.runtime, trajectoryId);
    if (!persisted) return null;

    return {
      trajectoryId: persisted.id,
      agentId: this.runtime.agentId,
      startTime: persisted.startTime,
      endTime: persisted.endTime ?? undefined,
      durationMs: persisted.endTime
        ? persisted.endTime - persisted.startTime
        : undefined,
      steps: persisted.steps.map((step) => ({
        stepId: step.stepId,
        timestamp: step.timestamp,
        llmCalls: step.llmCalls,
        providerAccesses: step.providerAccesses,
      })),
      metrics: { finalStatus: persisted.status },
      metadata: persisted.metadata,
      stepsJson: JSON.stringify(persisted.steps),
    };
  }

  async getStats(): Promise<unknown> {
    if (!hasRuntimeDb(this.runtime)) {
      return { total: 0, byStatus: {}, bySource: {} };
    }

    const tableReady = await ensureTrajectoriesTable(this.runtime);
    if (!tableReady) {
      return { total: 0, byStatus: {}, bySource: {} };
    }

    try {
      const countResult = await executeRawSql(
        this.runtime,
        "SELECT count(*) AS total FROM trajectories",
      );
      const countRow = asRecord(extractRows(countResult)[0]);
      const total = toNumber(countRow?.total, 0);

      const bySource = await computeBySource(this.runtime);

      return {
        total,
        enabled: this.enabled,
        byStatus: {},
        bySource,
      };
    } catch {
      return { total: 0, byStatus: {}, bySource: {} };
    }
  }

  async deleteTrajectories(trajectoryIds: string[]): Promise<number> {
    const result = await deletePersistedTrajectoryRows(
      this.runtime,
      trajectoryIds,
    );
    return result ?? 0;
  }

  async clearAllTrajectories(): Promise<number> {
    const result = await clearPersistedTrajectoryRows(this.runtime);
    return result ?? 0;
  }

  async exportTrajectories(
    options: TrajectoryExportOptions,
  ): Promise<TrajectoryExportResult> {
    const listResult = await this.listTrajectories({
      limit: 10000,
      startDate: options.startDate,
      endDate: options.endDate,
    });

    let ids = listResult.trajectories.map((t) => t.id);
    if (options.trajectoryIds && options.trajectoryIds.length > 0) {
      const idSet = new Set(options.trajectoryIds);
      ids = ids.filter((id) => idSet.has(id));
    }

    const trajectories: Trajectory[] = [];
    for (const id of ids) {
      const detail = await this.getTrajectoryDetail(id);
      if (detail) trajectories.push(detail);
    }

    if (options.format === "json") {
      return {
        filename: `trajectories-${Date.now()}.json`,
        data: JSON.stringify(trajectories, null, 2),
        mimeType: "application/json",
      };
    }

    if (options.format === "csv") {
      const rows = [
        "id,agentId,startTime,endTime,status,llmCallCount,promptTokens,completionTokens",
      ];
      for (const t of trajectories) {
        const llmCount = t.steps?.reduce(
          (sum, s) => sum + (s.llmCalls?.length ?? 0),
          0,
        );
        const promptTokens = t.steps?.reduce(
          (sum, s) =>
            sum +
            (s.llmCalls?.reduce((s2, c) => s2 + (c.promptTokens ?? 0), 0) ?? 0),
          0,
        );
        const completionTokens = t.steps?.reduce(
          (sum, s) =>
            sum +
            (s.llmCalls?.reduce((s2, c) => s2 + (c.completionTokens ?? 0), 0) ??
              0),
          0,
        );
        rows.push(
          `${t.trajectoryId},${t.agentId},${t.startTime},${t.endTime ?? ""},${t.metrics?.finalStatus ?? ""},${llmCount ?? 0},${promptTokens ?? 0},${completionTokens ?? 0}`,
        );
      }
      return {
        filename: `trajectories-${Date.now()}.csv`,
        data: rows.join("\n"),
        mimeType: "text/csv",
      };
    }

    // Default to JSON for 'art' format
    return {
      filename: `trajectories-${Date.now()}.json`,
      data: JSON.stringify(trajectories, null, 2),
      mimeType: "application/json",
    };
  }
}

/**
 * Create and register a database-backed trajectory logger service on the runtime.
 * This replaces any existing trajectory_logger service with one that persists to the database.
 */
export function createDatabaseTrajectoryLogger(
  runtime: IAgentRuntime,
): DatabaseTrajectoryLogger {
  const logger = new DatabaseTrajectoryLogger(runtime);
  return logger;
}

export function shouldEnableTrajectoryLoggingByDefault(): boolean {
  return process.env.NODE_ENV !== "production";
}
