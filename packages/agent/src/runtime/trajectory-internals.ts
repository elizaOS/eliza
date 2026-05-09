/**
 * Shared internal helpers for the trajectory persistence subsystem.
 *
 * This module contains types, utility functions, SQL helpers, schema management,
 * and observation extraction logic used across trajectory-storage, trajectory-query,
 * and trajectory-export modules. Not intended for direct external consumption.
 */

import { createHash } from "node:crypto";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createGzip } from "node:zlib";
import {
  logger as coreLogger,
  type IAgentRuntime,
  ModelType,
} from "@elizaos/core";
import { asRecord } from "@elizaos/shared";

export { asRecord };

import {
  TRAJECTORY_STEP_SCRIPT_MAX_CHARS,
  type TrajectoryLlmCall,
  type TrajectoryProviderAccess,
  type TrajectoryStatus,
  type TrajectoryStep,
  type TrajectoryStepKind,
} from "../types/trajectory.js";

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

export type RuntimeDb = {
  execute: (query: { queryChunks: object[] }) => Promise<unknown>;
};

export type TrajectoryLoggerLike = {
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

export type PersistedLlmCall = TrajectoryLlmCall & {
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
};

export type PersistedProviderAccess = TrajectoryProviderAccess & {
  providerId: string;
  providerName: string;
  timestamp: number;
  data: Record<string, unknown>;
  purpose: string;
};

export type PersistedStep = TrajectoryStep & {
  stepId: string;
  stepNumber: number;
  timestamp: number;
  llmCalls: PersistedLlmCall[];
  providerAccesses: PersistedProviderAccess[];
  /**
   * Optional discriminator. Legacy rows without this field are treated as
   * `"llm"` by readers.
   */
  kind?: TrajectoryStepKind;
  /** Step IDs of nested steps (used by `executeCode`). */
  childSteps?: string[];
  /** Inline script source for `executeCode` steps (capped). */
  script?: string;
  /** sha256 hex digest of the original script when it exceeded the cap. */
  scriptHash?: string;
  /** Skill names the step relied on (populated by Track C). */
  usedSkills?: string[];
};

export type PersistedTrajectory = {
  id: string;
  source: string;
  status: TrajectoryStatus;
  startTime: number;
  endTime: number | null;
  scenarioId?: string;
  batchId?: string;
  steps: PersistedStep[];
  metadata: Record<string, unknown>;
  totalReward: number;
  createdAt: string;
  updatedAt: string;
};

export type StartStepOptions = {
  runtime: IAgentRuntime;
  stepId: string;
  source?: string;
  metadata?: Record<string, unknown>;
};

export type CompleteStepOptions = {
  runtime: IAgentRuntime;
  stepId: string;
  status?: TrajectoryStatus;
  source?: string;
  metadata?: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

export const initializedRuntimes = new WeakSet<object>();
export const patchedLoggers = new WeakSet<object>();

export const stepWriteQueues = new WeakMap<
  object,
  Map<string, Promise<void>>
>();
export const lastWritePromises = new WeakMap<object, Promise<void>>();

let cachedSqlRaw: ((query: string) => { queryChunks: object[] }) | null = null;

// Module version - changes on each hot reload, ensuring schema checks run
const SCHEMA_VERSION = Date.now();
const schemaVersions = new WeakMap<object, number>();

export function toText(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return fallback;
  return String(value);
}

export function toOptionalText(value: unknown): string | undefined {
  const normalized = toText(value, "").trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export function toOptionalNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = toNumber(value, Number.NaN);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function toOptionalBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on", "enabled"].includes(normalized)) return true;
  if (["0", "false", "no", "off", "disabled"].includes(normalized))
    return false;
  return undefined;
}

export function normalizeTrajectoryTag(value: unknown): string {
  const raw = toText(value, "").trim();
  if (!raw) return "";
  return raw
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9:]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
}

function normalizeTrajectoryTagList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const normalized = normalizeTrajectoryTag(entry);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    tags.push(normalized);
  }
  return tags;
}

const ORCHESTRATOR_STEP_TYPES = new Set([
  "coordination",
  "observation_extraction",
  "orchestrator",
  "turn_complete",
]);

export function inferTrajectoryLlmStepType(params: {
  stepType?: unknown;
  purpose?: unknown;
  actionType?: unknown;
  model?: unknown;
}): string {
  const existing = normalizeTrajectoryTag(params.stepType);
  if (existing) return existing;

  const purpose = normalizeTrajectoryTag(params.purpose);
  const actionType = normalizeTrajectoryTag(params.actionType);

  if (purpose === "should_respond") return "should_respond";
  if (
    purpose === "compose_state" ||
    purpose === "evaluation" ||
    purpose === "reasoning" ||
    purpose === "response" ||
    purpose === "observation_extraction" ||
    purpose === "turn_complete" ||
    purpose === "coordination"
  ) {
    return purpose;
  }
  if (actionType.startsWith("orchestrator_")) {
    return "orchestrator";
  }
  if (purpose === "action") return "action";
  if (purpose && purpose !== "other") return purpose;
  if (actionType) return actionType;
  return purpose;
}

export function inferTrajectoryLlmTags(params: {
  stepType?: unknown;
  purpose?: unknown;
  actionType?: unknown;
  model?: unknown;
  tags?: unknown;
}): string[] {
  const stepType = inferTrajectoryLlmStepType(params);
  const purpose = normalizeTrajectoryTag(params.purpose);
  const actionType = normalizeTrajectoryTag(params.actionType);
  const tags = normalizeTrajectoryTagList(params.tags);
  const seen = new Set<string>(tags);
  const push = (value: string): void => {
    const normalized = normalizeTrajectoryTag(value);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    tags.push(normalized);
  };

  push("llm");
  if (stepType) push(`step:${stepType}`);
  if (purpose) push(`purpose:${purpose}`);
  if (actionType) push(`action:${actionType}`);
  if (stepType === "should_respond") push("routing");
  if (stepType === "compose_state") push("context");
  if (
    ORCHESTRATOR_STEP_TYPES.has(stepType) ||
    actionType.startsWith("orchestrator_")
  ) {
    push("orchestrator");
  }

  return tags;
}

export function enrichTrajectoryLlmCall<T extends Record<string, unknown>>(
  call: T,
): T & { stepType?: string; tags?: string[] } {
  const stepType = inferTrajectoryLlmStepType({
    stepType: call.stepType,
    purpose: call.purpose,
    actionType: call.actionType,
    model: call.model,
  });
  const tags = inferTrajectoryLlmTags({
    stepType,
    purpose: call.purpose,
    actionType: call.actionType,
    model: call.model,
    tags: call.tags,
  });

  return {
    ...call,
    ...(stepType ? { stepType } : {}),
    ...(tags.length > 0 ? { tags } : {}),
  };
}

export function hasActionNamed(
  runtime: IAgentRuntime,
  name: string,
): boolean {
  const actions = runtime.actions;
  if (!Array.isArray(actions)) return false;
  const target = name.trim().toUpperCase();
  return actions.some((action) => {
    const actionName = action?.name?.trim().toUpperCase() ?? "";
    return actionName === target;
  });
}

export function readRecordValue(
  record: Record<string, unknown>,
  keys: string[],
): unknown {
  for (const key of keys) {
    if (key in record) return record[key];
  }
  return undefined;
}

export function parseJsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

const TRAJECTORY_SCENARIO_METADATA_KEYS = ["scenarioId", "scenario_id"];
const TRAJECTORY_BATCH_METADATA_KEYS = ["batchId", "batch_id"];

function readGroupingValue(
  metadata: Record<string, unknown>,
  keys: string[],
): string | undefined {
  return toOptionalText(readRecordValue(metadata, keys));
}

export function resolveTrajectoryGrouping(
  metadata: Record<string, unknown> | undefined,
  fallback?: {
    scenarioId?: unknown;
    batchId?: unknown;
  },
): {
  scenarioId?: string;
  batchId?: string;
} {
  const record = metadata ?? {};
  const scenarioId =
    readGroupingValue(record, TRAJECTORY_SCENARIO_METADATA_KEYS) ??
    toOptionalText(fallback?.scenarioId);
  const batchId =
    readGroupingValue(record, TRAJECTORY_BATCH_METADATA_KEYS) ??
    toOptionalText(fallback?.batchId);
  return { scenarioId, batchId };
}

export function normalizeTrajectoryMetadata(
  metadata: Record<string, unknown> | undefined,
  fallback?: {
    scenarioId?: unknown;
    batchId?: unknown;
  },
): {
  metadata: Record<string, unknown>;
  scenarioId?: string;
  batchId?: string;
} {
  const normalizedMetadata = {
    ...(metadata ?? {}),
  };
  const { scenarioId, batchId } = resolveTrajectoryGrouping(
    normalizedMetadata,
    fallback,
  );

  if (scenarioId) {
    normalizedMetadata.scenarioId = scenarioId;
  } else {
    delete normalizedMetadata.scenarioId;
  }

  if (batchId) {
    normalizedMetadata.batchId = batchId;
  } else {
    delete normalizedMetadata.batchId;
  }

  return {
    metadata: normalizedMetadata,
    scenarioId,
    batchId,
  };
}

// ---------------------------------------------------------------------------
// Truncation helpers
// ---------------------------------------------------------------------------

const DEFAULT_TRUNCATE_LIMIT = 500;

export function truncateField(
  value: string,
  limit = DEFAULT_TRUNCATE_LIMIT,
): string {
  if (value.length <= limit * 2) return value;
  const removed = value.length - limit * 2;
  return `${value.slice(0, limit)}\n[...truncated ${removed} chars...]\n${value.slice(-limit)}`;
}

export function truncateRecord(
  obj: Record<string, unknown>,
  limit = DEFAULT_TRUNCATE_LIMIT,
): Record<string, unknown> {
  const serialized = JSON.stringify(obj);
  if (serialized.length <= limit * 2) return obj;
  return { _truncated: truncateField(serialized, limit) };
}

// ---------------------------------------------------------------------------
// Script capture helpers (used by executeCode trajectory steps)
// ---------------------------------------------------------------------------

/**
 * Cap a script source for inline persistence on a trajectory step. When the
 * source exceeds `TRAJECTORY_STEP_SCRIPT_MAX_CHARS`, returns a truncated
 * prefix together with the sha256 hex digest of the full source so callers
 * can store the digest alongside.
 */
export function capScriptForPersistence(script: string): {
  script: string;
  scriptHash?: string;
} {
  if (script.length <= TRAJECTORY_STEP_SCRIPT_MAX_CHARS) {
    return { script };
  }
  const scriptHash = createHash("sha256").update(script, "utf8").digest("hex");
  return {
    script: script.slice(0, TRAJECTORY_STEP_SCRIPT_MAX_CHARS),
    scriptHash,
  };
}

// ---------------------------------------------------------------------------
// Insight extraction
// ---------------------------------------------------------------------------

export function extractInsightsFromResponse(
  response: string,
  purpose: string,
): string[] {
  const insights: string[] = [];
  const safeResponse =
    response.length > 100_000 ? response.slice(0, 100_000) : response;
  const decisionPattern = /DECISION:[ \t]{0,1024}([^\n]{1,1024})/gi;
  let match: RegExpExecArray | null;
  match = decisionPattern.exec(safeResponse);
  while (match !== null) {
    const decision = match[1];
    if (decision) {
      insights.push(decision.trim());
    }
    match = decisionPattern.exec(safeResponse);
  }
  const keyDecisionPattern = /"keyDecision"\s{0,32}:\s{0,32}"([^"]{1,1024})"/g;
  match = keyDecisionPattern.exec(safeResponse);
  while (match !== null) {
    const keyDecision = match[1];
    if (keyDecision) {
      insights.push(keyDecision.trim());
    }
    match = keyDecisionPattern.exec(safeResponse);
  }
  if (
    (purpose === "turn-complete" || purpose === "coordination") &&
    insights.length === 0
  ) {
    const reasoningMatch = safeResponse.match(
      /"reasoning"\s{0,32}:\s{0,32}"([^"]{20,200})"/,
    );
    const reasoning = reasoningMatch?.[1];
    if (reasoning) insights.push(reasoning.trim());
  }
  return insights;
}

// ---------------------------------------------------------------------------
// Observation extraction
// ---------------------------------------------------------------------------

export function shouldRunObservationExtraction(
  runtime: IAgentRuntime,
): boolean {
  const explicitSetting = runtime.getSetting(
    "TRAJECTORY_OBSERVATION_EXTRACTION",
  );
  const explicitValue = toOptionalBoolean(explicitSetting);
  if (explicitValue !== undefined) return explicitValue;

  if (
    hasActionNamed(runtime, "REFLECTION") ||
    hasActionNamed(runtime, "RELATIONSHIP_EXTRACTION")
  ) {
    return false;
  }
  return true;
}

export interface BufferedExchange {
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

export const TRAJECTORY_ARCHIVE_DIRNAME = "trajectory-archive";

function getObservationBuffer(runtime: IAgentRuntime): BufferedExchange[] {
  const key = runtime as object;
  let buffer = observationBuffers.get(key);
  if (!buffer) {
    buffer = [];
    observationBuffers.set(key, buffer);
  }
  return buffer;
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

export function pushChatExchange(
  runtime: IAgentRuntime,
  exchange: BufferedExchange,
): void {
  const buffer = getObservationBuffer(runtime);
  buffer.push(exchange);

  const key = runtime as object;

  // Flush on threshold
  if (buffer.length >= OBSERVATION_BUFFER_THRESHOLD) {
    flushObservationBuffer(runtime).catch((err) => {
      coreLogger.warn(`[trajectory] Observation buffer flush failed: ${err}`);
    });
    return;
  }

  // Set/reset flush timer
  const existing = observationFlushTimers.get(key);
  if (existing) clearTimeout(existing);
  observationFlushTimers.set(
    key,
    setTimeout(() => {
      flushObservationBuffer(runtime).catch((err) => {
        coreLogger.warn(`[trajectory] Observation buffer flush failed: ${err}`);
      });
    }, OBSERVATION_FLUSH_INTERVAL_MS),
  );
}

export async function flushObservationBuffer(
  runtime: IAgentRuntime,
): Promise<string[]> {
  const key = runtime as object;

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

  const runtimeRecord = runtime as unknown as Record<string, unknown>;
  try {
    // Tag the call to prevent recursion
    runtimeRecord.__orchestratorTrajectoryCtx = {
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
    if (!lastExchange) {
      return observations;
    }
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
    delete runtimeRecord.__orchestratorTrajectoryCtx;
    observationFlushInProgress.set(key, false);
  }
}

// ---------------------------------------------------------------------------
// SQL helpers
// ---------------------------------------------------------------------------

export function parseMetadata(value: unknown): Record<string, unknown> {
  const parsed = parseJsonValue(value);
  const record = asRecord(parsed);
  return record ?? {};
}

export function parseSteps(value: unknown): PersistedStep[] {
  const parsed = parseJsonValue(value);
  if (Array.isArray(parsed)) {
    return parsed as PersistedStep[];
  }
  const record = asRecord(parsed);
  if (!record) return [];
  const nested = parseJsonValue(readRecordValue(record, ["steps"]));
  return Array.isArray(nested) ? (nested as PersistedStep[]) : [];
}

export function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function sqlNumber(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "NULL";
  return String(value);
}

export async function getSqlRaw(): Promise<
  (query: string) => { queryChunks: object[] }
> {
  if (cachedSqlRaw) return cachedSqlRaw;
  const drizzle = (await import("drizzle-orm")) as {
    sql: { raw: (query: string) => { queryChunks: object[] } };
  };
  cachedSqlRaw = drizzle.sql.raw;
  return cachedSqlRaw;
}

export function getRuntimeDb(runtime: IAgentRuntime): RuntimeDb | null {
  const adapterDb = runtime.adapter?.db as RuntimeDb | undefined;
  // Legacy runtimes may expose `databaseAdapter` instead of `adapter`
  const fallbackDb = (
    runtime as unknown as { databaseAdapter?: { db?: RuntimeDb } }
  ).databaseAdapter?.db;
  const db = adapterDb || fallbackDb;
  if (!db || typeof db.execute !== "function") return null;
  return db;
}

export function hasRuntimeDb(runtime: IAgentRuntime): boolean {
  return Boolean(getRuntimeDb(runtime));
}

export async function executeRawSql(
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

export function extractRows(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  const record = asRecord(result);
  if (!record) return [];
  return Array.isArray(record.rows) ? record.rows : [];
}

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

export function warnRuntime(
  runtime: IAgentRuntime,
  message: string,
  err?: unknown,
): void {
  if (runtime.logger?.warn) {
    runtime.logger.warn(
      { err, src: "eliza", subsystem: "trajectory-db" },
      message,
    );
  }
}

// ---------------------------------------------------------------------------
// Schema management
// ---------------------------------------------------------------------------

export async function ensureTrajectoriesTable(
  runtime: IAgentRuntime,
): Promise<boolean> {
  const key = runtime as object;

  // Only skip if verified with current module version
  if (schemaVersions.get(key) === SCHEMA_VERSION) return true;

  try {
    // First, check if the table exists and has the correct schema
    // by attempting to select all required columns
    let needsRecreate = false;
    try {
      await executeRawSql(runtime, `SELECT id FROM trajectories LIMIT 1`);
      // Table exists — try to add any missing columns via ALTER TABLE
      // instead of dropping and losing all data.
      const optionalColumns = [
        { name: "trajectory_id", def: "TEXT" },
        { name: "metadata", def: "TEXT NOT NULL DEFAULT '{}'" },
        { name: "steps_json", def: "TEXT NOT NULL DEFAULT '[]'" },
        { name: "scenario_id", def: "TEXT" },
        { name: "batch_id", def: "TEXT" },
        { name: "archetype", def: "TEXT" },
        { name: "episode_length", def: "INTEGER" },
        { name: "ai_judge_reward", def: "REAL" },
        { name: "ai_judge_reasoning", def: "TEXT" },
      ];
      for (const col of optionalColumns) {
        try {
          await executeRawSql(
            runtime,
            `ALTER TABLE trajectories ADD COLUMN ${col.name} ${col.def}`,
          );
        } catch {
          // Column already exists — expected
        }
      }
    } catch {
      // Table doesn't exist at all — create fresh (no data loss)
      needsRecreate = true;
      console.warn(
        "[trajectory-persistence] Trajectories table does not exist, creating...",
      );
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
        scenario_id TEXT,
        batch_id TEXT,
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

    // Archive table
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
        scenario_id TEXT,
        batch_id TEXT,
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

    // Best-effort forward migration for grouping columns.
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
    try {
      await executeRawSql(
        runtime,
        `ALTER TABLE trajectories ADD COLUMN batch_id TEXT`,
      );
    } catch {
      // ignore when column already exists
    }
    try {
      await executeRawSql(
        runtime,
        `CREATE INDEX IF NOT EXISTS idx_trajectories_batch_id ON trajectories(batch_id)`,
      );
    } catch {
      // ignore if index creation fails
    }
    try {
      await executeRawSql(
        runtime,
        `ALTER TABLE trajectory_archive ADD COLUMN scenario_id TEXT`,
      );
    } catch {
      // ignore when column already exists
    }
    try {
      await executeRawSql(
        runtime,
        `ALTER TABLE trajectory_archive ADD COLUMN batch_id TEXT`,
      );
    } catch {
      // ignore when column already exists
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

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

export function normalizeStatus(
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

export function normalizeStepId(value: unknown): string | null {
  const stepId = toText(value, "").trim();
  return stepId.length > 0 ? stepId : null;
}

export function normalizeLlmCallPayload(
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

export function normalizeProviderAccessPayload(
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

export function isNumericVectorString(value: string): boolean {
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

export function shouldSuppressNoInputEmbeddingCall(
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

export function isLegacyTrajectoryLogger(
  logger: TrajectoryLoggerLike,
): boolean {
  return (
    typeof logger.listTrajectories === "function" &&
    typeof logger.getTrajectoryDetail === "function"
  );
}

export async function resolveTrajectoryLogger(
  runtime: IAgentRuntime,
): Promise<TrajectoryLoggerLike | null> {
  const candidates: TrajectoryLoggerLike[] = [];
  const seen = new Set<unknown>();
  const push = (candidate: unknown): void => {
    if (!candidate || typeof candidate !== "object" || seen.has(candidate))
      return;
    seen.add(candidate);
    candidates.push(candidate as TrajectoryLoggerLike);
  };

  const byType = runtime.getServicesByType("trajectories");
  if (Array.isArray(byType)) {
    for (const item of byType) push(item);
  } else {
    push(byType);
  }
  push(runtime.getService("trajectories"));

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

// ---------------------------------------------------------------------------
// Trajectory data helpers
// ---------------------------------------------------------------------------

export function enqueueStepWrite(
  runtime: IAgentRuntime,
  stepId: string,
  work: () => Promise<void>,
): Promise<void> {
  const runtimeKey = runtime as object;
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

export function createBaseTrajectory(
  stepId: string,
  now: number,
  source?: string,
  metadata?: Record<string, unknown>,
): PersistedTrajectory {
  const normalizedSource = source?.trim() || "runtime";
  const createdAt = new Date(now).toISOString();
  const normalizedMetadata = normalizeTrajectoryMetadata(metadata);
  return {
    id: stepId,
    source: normalizedSource,
    status: "active",
    startTime: now,
    endTime: null,
    scenarioId: normalizedMetadata.scenarioId,
    batchId: normalizedMetadata.batchId,
    steps: [
      {
        stepId,
        stepNumber: 0,
        timestamp: now,
        llmCalls: [],
        providerAccesses: [],
      },
    ],
    metadata: normalizedMetadata.metadata,
    totalReward: 0,
    createdAt,
    updatedAt: createdAt,
  };
}

export function ensureStep(
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

export function mergeMetadata(
  existing: Record<string, unknown>,
  incoming?: Record<string, unknown>,
): Record<string, unknown> {
  if (!incoming) return existing;
  const merged: Record<string, unknown> = { ...existing };
  for (const [key, value] of Object.entries(incoming)) {
    if (value !== undefined) merged[key] = value;
  }
  return normalizeTrajectoryMetadata(merged).metadata;
}

export function collectTrajectoryTimestamps(
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

export function summarizeTrajectory(trajectory: PersistedTrajectory): {
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

export function parsePersistedTrajectoryRow(
  row: Record<string, unknown>,
  fallbackId: string,
): PersistedTrajectory {
  const startTime = toNumber(
    readRecordValue(row, ["start_time", "startTime"]),
    Date.now(),
  );
  const endTime =
    toOptionalNumber(readRecordValue(row, ["end_time", "endTime"])) ?? null;
  const steps = parseSteps(
    readRecordValue(row, ["steps_json", "stepsJson", "steps"]),
  );
  const normalizedMetadata = normalizeTrajectoryMetadata(
    parseMetadata(
      readRecordValue(row, [
        "metadata_json",
        "metadataJson",
        "metadata",
        "meta",
      ]),
    ),
    {
      scenarioId: readRecordValue(row, ["scenario_id", "scenarioId"]),
      batchId: readRecordValue(row, ["batch_id", "batchId"]),
    },
  );

  return {
    id: toText(
      readRecordValue(row, ["id", "trajectory_id", "trajectoryId"]),
      fallbackId,
    ),
    source: toText(readRecordValue(row, ["source"]), "runtime"),
    status: normalizeStatus(readRecordValue(row, ["status"]), "completed"),
    startTime,
    endTime,
    scenarioId: normalizedMetadata.scenarioId,
    batchId: normalizedMetadata.batchId,
    steps,
    metadata: normalizedMetadata.metadata,
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
}

// ---------------------------------------------------------------------------
// Core load/save (used by both storage and query modules)
// ---------------------------------------------------------------------------

export async function loadTrajectoryById(
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
    return parsePersistedTrajectoryRow(row, stepId);
  } catch {
    return null;
  }
}

export async function loadTrajectoryByStepId(
  runtime: IAgentRuntime,
  stepId: string,
): Promise<PersistedTrajectory | null> {
  const direct = await loadTrajectoryById(runtime, stepId);
  if (direct) {
    return direct;
  }

  const normalizedStepId = stepId.trim();
  if (!normalizedStepId) {
    return null;
  }

  const stepPattern = sqlQuote(`%"stepId":"${normalizedStepId}"%`);
  try {
    const result = await executeRawSql(
      runtime,
      `SELECT * FROM trajectories
       WHERE COALESCE(steps_json, '') LIKE ${stepPattern}
       ORDER BY updated_at DESC, created_at DESC
       LIMIT 1`,
    );
    const rows = extractRows(result);
    if (rows.length === 0) return null;
    const row = asRecord(rows[0]);
    if (!row) return null;
    return parsePersistedTrajectoryRow(row, normalizedStepId);
  } catch {
    return null;
  }
}

export async function saveTrajectory(
  runtime: IAgentRuntime,
  trajectory: PersistedTrajectory,
): Promise<boolean> {
  const normalizedMetadata = normalizeTrajectoryMetadata(trajectory.metadata, {
    scenarioId: trajectory.scenarioId,
    batchId: trajectory.batchId,
  });
  trajectory.metadata = normalizedMetadata.metadata;
  trajectory.scenarioId = normalizedMetadata.scenarioId;
  trajectory.batchId = normalizedMetadata.batchId;

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
  const serializedSteps = sqlQuote(JSON.stringify(trajectory.steps));
  const serializedMetadata = sqlQuote(JSON.stringify(trajectory.metadata));
  const serializedCompatMetrics = sqlQuote(
    JSON.stringify({
      episodeLength: trajectory.steps.length,
      finalStatus: trajectory.status,
      llmCallCount: summary.llmCallCount,
      providerAccessCount: summary.providerAccessCount,
      totalPromptTokens: summary.totalPromptTokens,
      totalCompletionTokens: summary.totalCompletionTokens,
    }),
  );

  const sql = `INSERT INTO trajectories (
      id,
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
      scenario_id,
      batch_id,
      steps_json,
      metadata,
      created_at,
      updated_at,
      episode_length
    ) VALUES (
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
      ${trajectory.scenarioId ? sqlQuote(trajectory.scenarioId) : "NULL"},
      ${trajectory.batchId ? sqlQuote(trajectory.batchId) : "NULL"},
      ${serializedSteps},
      ${serializedMetadata},
      ${sqlQuote(createdAt)},
      ${sqlQuote(updatedAt)},
      ${sqlNumber(trajectory.steps.length)}
    )
    ON CONFLICT (id) DO UPDATE SET
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
      scenario_id = EXCLUDED.scenario_id,
      batch_id = EXCLUDED.batch_id,
      steps_json = EXCLUDED.steps_json,
      metadata = EXCLUDED.metadata,
      created_at = EXCLUDED.created_at,
      updated_at = EXCLUDED.updated_at,
      episode_length = EXCLUDED.episode_length`;

  const compatSql = `INSERT INTO trajectories (
      id,
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
      scenario_id,
      batch_id,
      steps_json,
      metadata_json,
      metrics_json,
      created_at,
      updated_at
    ) VALUES (
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
      ${trajectory.scenarioId ? sqlQuote(trajectory.scenarioId) : "NULL"},
      ${trajectory.batchId ? sqlQuote(trajectory.batchId) : "NULL"},
      ${serializedSteps},
      ${serializedMetadata},
      ${serializedCompatMetrics},
      ${sqlQuote(createdAt)},
      ${sqlQuote(updatedAt)}
    )
    ON CONFLICT (id) DO UPDATE SET
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
      scenario_id = EXCLUDED.scenario_id,
      batch_id = EXCLUDED.batch_id,
      steps_json = EXCLUDED.steps_json,
      metadata_json = EXCLUDED.metadata_json,
      metrics_json = EXCLUDED.metrics_json,
      created_at = EXCLUDED.created_at,
      updated_at = EXCLUDED.updated_at`;

  try {
    await executeRawSql(runtime, sql);
    return true;
  } catch (err) {
    try {
      await executeRawSql(runtime, compatSql);
      return true;
    } catch (compatErr) {
      console.error("[trajectory-persistence] saveTrajectory error:", {
        modern: err instanceof Error ? err.message : String(err),
        compat:
          compatErr instanceof Error ? compatErr.message : String(compatErr),
      });
      return false;
    }
  }
}

/**
 * Read orchestrator trajectory context from the runtime, if set.
 */
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
  const ctx = (runtime as unknown as Record<string, unknown>)
    .__orchestratorTrajectoryCtx;
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

// ---------------------------------------------------------------------------
// Archive helpers
// ---------------------------------------------------------------------------

export function resolvePreferredTrajectoryArchiveRoot(): string {
  const explicitWorkspace = process.env.ELIZA_WORKSPACE_DIR?.trim();
  if (explicitWorkspace) return explicitWorkspace;

  const workspaceRoot = process.env.ELIZA_WORKSPACE_ROOT?.trim();
  if (workspaceRoot) return workspaceRoot;

  return path.join(os.homedir(), ".eliza", "workspace");
}

export async function ensureArchiveDirectory(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export async function resolveTrajectoryArchiveDirectory(): Promise<string> {
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
      "eliza",
      TRAJECTORY_ARCHIVE_DIRNAME,
    );
    await ensureArchiveDirectory(fallback);
    return fallback;
  }
}

export function toArchiveSafeTimestamp(isoTimestamp: string): string {
  return isoTimestamp.replace(/[:.]/g, "-");
}

export function stringifyArchiveRow(row: Record<string, unknown>): string {
  return JSON.stringify(row, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value,
  );
}

export async function writeCompressedJsonlRows(
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

/**
 * Trajectory persistence is unconditionally on. The only paths that disable it:
 *
 *   1. `NODE_ENV === "test"` — keeps the test runner free of background DB writes.
 *   2. `ELIZA_DISABLE_TRAJECTORY_LOGGING=1` — explicit operator opt-out.
 *
 * We deliberately stopped honoring the legacy `ENABLE_TRAJECTORIES`,
 * `ELIZA_TRAJECTORY_LOGGING`, `TRAJECTORY_LOGGING_ENABLED`, and
 * `ELIZA_CLOUD_PROVISIONED` knobs: each represented a different historical
 * attempt to gate persistence, and shipping multiple opt-in paths produced
 * silent gaps where debugging and training data went missing. One opt-out,
 * otherwise on.
 */
export function shouldEnableTrajectoryLoggingByDefault(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.NODE_ENV === "test") return false;
  if (env.ELIZA_DISABLE_TRAJECTORY_LOGGING === "1") return false;
  return true;
}
