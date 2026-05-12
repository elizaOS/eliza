import {
  type AgentRuntime,
  ChannelType,
  elizaLogger,
  type Memory,
  type Plugin,
  type RoleName,
  type RolesWorldMetadata,
  setEntityRole,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import type { BenchmarkContext, CapturedAction } from "./plugin";

export { coerceParams } from "./params";

export const DEFAULT_PORT = 3939;
export const DEFAULT_HOST = "127.0.0.1";
export const BENCHMARK_WORLD_ID = stringToUuid("eliza-benchmark-world");
export const BENCHMARK_MESSAGE_SERVER_ID = stringToUuid(
  "eliza-benchmark-message-server",
);

/**
 * Canonical OWNER entity for every benchmark world. We pin world.metadata
 * .ownership.ownerId to this id at world-creation time so anything that
 * resolves to `isCanonicalOwner` works without needing to set
 * `ELIZA_ADMIN_ENTITY_ID` in the env.
 *
 * Roles for additional users (admin/user/guest) are seeded per-session by
 * `seedBenchUserRole` below.
 */
export const BENCHMARK_OWNER_ENTITY_ID = stringToUuid("eliza-benchmark-owner");

const BENCH_ROLE_NAMES: readonly RoleName[] = [
  "OWNER",
  "ADMIN",
  "USER",
  "GUEST",
] as const;

export function normalizeBenchRoleName(raw: unknown): RoleName | null {
  if (typeof raw !== "string") return null;
  const upper = raw.trim().toUpperCase();
  switch (upper) {
    case "OWNER":
    case "ADMIN":
    case "USER":
    case "GUEST":
      return upper;
    // Tolerate the runner's lowercase `admin` / `member` vocabulary so we
    // don't have to keep both sides in lockstep.
    case "MEMBER":
      return "USER";
    default:
      return null;
  }
}

export function isBenchRoleName(value: unknown): value is RoleName {
  return (
    typeof value === "string" &&
    (BENCH_ROLE_NAMES as readonly string[]).includes(value)
  );
}

export interface BenchmarkSession {
  benchmark: string;
  taskId: string;
  roomId: UUID;
  relayRoomId: UUID;
  userEntityId: UUID;
}

export interface BenchmarkOutboxEntry {
  kind: "direct" | "room";
  targetId: string;
  text: string;
  source: string;
  ts: number;
}

/**
 * Per-LLM-call usage record captured from a MODEL_USED event during a turn.
 * Optional cachedTokens reflects provider-reported prompt-cache hits
 * (OpenAI-style `prompt_tokens_details.cached_tokens`,
 *  Anthropic-style `cache_read_input_tokens`,
 *  Cerebras-compat `prompt_tokens_details.cached_tokens`).
 */
export interface BenchmarkLlmCallUsage {
  modelType: string;
  provider?: string;
  source?: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens?: number;
}

/**
 * Aggregated usage for a single benchmark turn (sum across every LLM call
 * that fired between handleMessage start and finish). cacheHitRatio is
 * cachedTokens / promptTokens when promptTokens > 0, else 0.
 */
export interface BenchmarkTurnUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  cacheHitRatio: number;
  callCount: number;
  calls: BenchmarkLlmCallUsage[];
}

/**
 * Compact audit-log entry surfaced in the benchmark trajectory. Mirrors
 * `personality_audit_log` memory rows written by the PERSONALITY action.
 * Only the fields the scorer needs are pulled forward; raw memory bytes
 * are not propagated. Added in P0-7 so the `scope_global_vs_user` rubric
 * can grade real mutation attempts instead of guessing from response text.
 */
export interface BenchmarkPersonalityAuditEntry {
  action: string;
  scope: string;
  actorId: string;
  targetId: string;
  /** ISO timestamp; defaults to memory `createdAt` when missing. */
  timestamp: string;
}

export interface BenchmarkTrajectoryStep {
  step: number;
  startedAt: number;
  finishedAt: number;
  inputText: string;
  promptText: string;
  context?: Record<string, unknown>;
  thought: string | null;
  responseText: string;
  actions: string[];
  params: Record<string, unknown>;
  /**
   * Optional usage roll-up for this turn. Added 2026 to support
   * cache-hit and token analysis. Older trajectory readers ignore it.
   */
  usage?: BenchmarkTurnUsage;
  /**
   * Personality-action audit entries observed during this turn. Empty when
   * no PERSONALITY mutation was recorded (most non-personality scenarios).
   * Added in P0-7 so the scope-discrimination rubric has a real signal.
   */
  personality_audit_log?: BenchmarkPersonalityAuditEntry[];
}

export interface CuaServiceLike {
  runTask(roomId: string, goal: string): Promise<unknown>;
  approveLatest(roomId: string): Promise<unknown>;
  cancelLatest(roomId: string): Promise<void>;
  screenshotBase64(): Promise<string>;
  getStatus(): Record<string, unknown>;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function envFlag(name: string): boolean {
  return parseBooleanValue(process.env[name]);
}

export function hasCuaConfig(): boolean {
  const hasLocal = Boolean(process.env.CUA_HOST?.trim());
  const hasCloud = Boolean(
    process.env.CUA_API_KEY?.trim() &&
      (process.env.CUA_SANDBOX_NAME?.trim() ||
        process.env.CUA_CONTAINER_NAME?.trim()),
  );
  return hasLocal || hasCloud;
}

export function parseBooleanValue(
  value: unknown,
  defaultValue = false,
): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  }
  return defaultValue;
}

export function compactCuaStep(
  step: unknown,
  includeScreenshots: boolean,
): Record<string, unknown> {
  if (!isRecord(step)) {
    return { step };
  }

  const screenshot =
    typeof step.screenshotAfterBase64 === "string"
      ? step.screenshotAfterBase64
      : undefined;
  const { screenshotAfterBase64: _omit, ...rest } = step;

  return includeScreenshots
    ? {
        ...rest,
        screenshotAfterBase64: screenshot,
        hasScreenshot: Boolean(screenshot),
      }
    : {
        ...rest,
        hasScreenshot: Boolean(screenshot),
      };
}

export function compactCuaResult(
  result: unknown,
  includeScreenshots: boolean,
): Record<string, unknown> {
  if (!isRecord(result)) {
    return { status: "unknown", raw: result };
  }

  const status = typeof result.status === "string" ? result.status : "unknown";

  if (status === "completed" || status === "failed") {
    const rawSteps = Array.isArray(result.steps) ? result.steps : [];
    return {
      ...result,
      steps: rawSteps.map((step) => compactCuaStep(step, includeScreenshots)),
    };
  }

  if (status === "paused_for_approval") {
    const pending = isRecord(result.pending) ? result.pending : {};
    const rawSteps = Array.isArray(pending.stepsSoFar)
      ? pending.stepsSoFar
      : [];
    const screenshotBefore =
      typeof pending.screenshotBeforeBase64 === "string"
        ? pending.screenshotBeforeBase64
        : undefined;
    const { screenshotBeforeBase64: _omit, ...pendingRest } = pending;

    return {
      ...result,
      pending: includeScreenshots
        ? {
            ...pendingRest,
            stepsSoFar: rawSteps.map((step) =>
              compactCuaStep(step, includeScreenshots),
            ),
            screenshotBeforeBase64: screenshotBefore,
            hasScreenshotBefore: Boolean(screenshotBefore),
          }
        : {
            ...pendingRest,
            stepsSoFar: rawSteps.map((step) =>
              compactCuaStep(step, includeScreenshots),
            ),
            hasScreenshotBefore: Boolean(screenshotBefore),
          },
    };
  }

  return { ...result };
}

export function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

export function toPlugin(candidate: unknown, source: string): Plugin {
  if (!candidate || typeof candidate !== "object") {
    throw new Error(`Plugin from ${source} was not an object`);
  }

  const pluginLike = candidate as { name?: unknown };
  if (typeof pluginLike.name !== "string" || pluginLike.name.length === 0) {
    throw new Error(`Plugin from ${source} was missing a valid name`);
  }

  return candidate as Plugin;
}

export function resolvePort(): number {
  const raw = process.env.ELIZA_BENCH_PORT;
  if (!raw) return DEFAULT_PORT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 65535) {
    elizaLogger.warn(
      `[bench] Invalid ELIZA_BENCH_PORT="${raw}"; using ${DEFAULT_PORT}`,
    );
    return DEFAULT_PORT;
  }
  return Math.floor(parsed);
}

export function resolveHost(): string {
  const raw = process.env.ELIZA_BENCH_HOST?.trim();
  if (!raw) return DEFAULT_HOST;

  if (raw !== "127.0.0.1" && raw !== "::1" && raw !== "localhost") {
    elizaLogger.warn(
      `[bench] Ignoring non-loopback ELIZA_BENCH_HOST="${raw}"; using ${DEFAULT_HOST}`,
    );
    return DEFAULT_HOST;
  }

  return raw;
}

export function extractRecord(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

export function extractTaskId(
  context: Record<string, unknown> | undefined,
): string {
  const bySnake = context?.task_id;
  if (typeof bySnake === "string" && bySnake.trim()) return bySnake.trim();
  const byCamel = context?.taskId;
  if (typeof byCamel === "string" && byCamel.trim()) return byCamel.trim();
  const byScenario = context?.scenario_id;
  if (typeof byScenario === "string" && byScenario.trim()) {
    return byScenario.trim();
  }
  return "default-task";
}

export function extractBenchmarkName(
  context: Record<string, unknown> | undefined,
): string {
  const benchmark = context?.benchmark;
  if (typeof benchmark === "string" && benchmark.trim()) {
    return benchmark.trim();
  }
  return "unknown";
}

export function composeBenchmarkPrompt(params: {
  text: string;
  context?: Record<string, unknown>;
  image?: unknown;
}): string {
  const segments: string[] = [params.text.trim()];

  if (params.context && Object.keys(params.context).length > 0) {
    segments.push(
      [
        "BENCHMARK CONTEXT (authoritative):",
        JSON.stringify(params.context, null, 2),
      ].join("\n"),
    );
  }

  if (params.image !== undefined) {
    segments.push(
      ["IMAGE PAYLOAD:", JSON.stringify(params.image, null, 2)].join("\n"),
    );
  }

  segments.push(
    "Respond using normal Eliza action output so actions/params can be executed and evaluated.",
  );

  return segments.join("\n\n");
}

export function coerceActions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

export function normalizeBenchmarkContext(
  session: BenchmarkSession,
  context: Record<string, unknown> | undefined,
): BenchmarkContext {
  const normalized: Record<string, unknown> = {
    ...(context ?? {}),
    benchmark: session.benchmark,
    taskId: session.taskId,
  };

  if (
    !Array.isArray(normalized.actionSpace) &&
    Array.isArray(normalized.action_space)
  ) {
    normalized.actionSpace = normalized.action_space;
  }
  if (
    !Array.isArray(normalized.actionSpace) &&
    Array.isArray(normalized.available_actions)
  ) {
    normalized.actionSpace = normalized.available_actions;
  }

  if (normalized.task_id === undefined) {
    normalized.task_id = session.taskId;
  }

  return normalized as BenchmarkContext;
}

export function capturedActionToParams(
  capturedAction: CapturedAction | null,
): Record<string, unknown> {
  if (!capturedAction) return {};

  const benchmarkParams: Record<string, unknown> = {};
  if (capturedAction.params) {
    Object.assign(benchmarkParams, capturedAction.params);
  }
  if (capturedAction.command) benchmarkParams.command = capturedAction.command;
  if (capturedAction.toolName)
    benchmarkParams.tool_name = capturedAction.toolName;
  if (capturedAction.arguments)
    benchmarkParams.arguments = capturedAction.arguments;
  if (capturedAction.operation)
    benchmarkParams.operation = capturedAction.operation;
  if (capturedAction.elementId)
    benchmarkParams.element_id = capturedAction.elementId;
  if (capturedAction.value) benchmarkParams.value = capturedAction.value;

  if (Object.keys(benchmarkParams).length === 0) {
    return {};
  }

  return { BENCHMARK_ACTION: benchmarkParams };
}

export function sessionKey(session: BenchmarkSession): string {
  return `${session.benchmark}:${session.taskId}`;
}

export async function ensureBenchmarkSessionContext(
  runtime: AgentRuntime,
  session: BenchmarkSession,
): Promise<void> {
  // Pin world ownership to a canonical bench-owner entity so the role-resolver
  // has a real OWNER. Without this, every benchmark sender resolves to GUEST
  // (see `core/roles.ts:resolveCanonicalOwnerId` + `isCanonicalOwner`) and
  // ADMIN-gated actions like PERSONALITY (global scope) deny universally.
  await runtime.ensureWorldExists({
    id: BENCHMARK_WORLD_ID,
    name: "Eliza Benchmark World",
    agentId: runtime.agentId,
    messageServerId: BENCHMARK_MESSAGE_SERVER_ID,
    metadata: {
      type: "benchmark",
      description: "World used for benchmark sessions",
      ownership: { ownerId: BENCHMARK_OWNER_ENTITY_ID },
      extra: {
        benchmark: session.benchmark,
      },
    },
  });

  // `ensureWorldExists` is create-if-missing. If a previous bench session
  // created the world without ownership (older runtimes, hot reload, etc.),
  // backfill the canonical owner so role resolution stays correct.
  const existingWorld = await runtime.getWorld(BENCHMARK_WORLD_ID);
  if (existingWorld) {
    const existingMetadata = (existingWorld.metadata ??
      {}) as RolesWorldMetadata;
    if (existingMetadata.ownership?.ownerId !== BENCHMARK_OWNER_ENTITY_ID) {
      (existingWorld as { metadata: RolesWorldMetadata }).metadata = {
        ...existingMetadata,
        ownership: { ownerId: BENCHMARK_OWNER_ENTITY_ID },
      };
      await runtime.updateWorld(
        existingWorld as Parameters<AgentRuntime["updateWorld"]>[0],
      );
    }
  }

  await runtime.ensureRoomExists({
    id: session.roomId,
    name: `benchmark:${session.taskId}`,
    source: "benchmark",
    type: ChannelType.API,
    channelId: `bench-${session.taskId}`,
    messageServerId: BENCHMARK_MESSAGE_SERVER_ID,
    worldId: BENCHMARK_WORLD_ID,
    metadata: {
      benchmark: session.benchmark,
      taskId: session.taskId,
    },
  });

  await runtime.ensureRoomExists({
    id: session.relayRoomId,
    name: "relay-room",
    source: "benchmark",
    type: ChannelType.API,
    channelId: `relay-${session.taskId}`,
    messageServerId: BENCHMARK_MESSAGE_SERVER_ID,
    worldId: BENCHMARK_WORLD_ID,
    metadata: {
      benchmark: session.benchmark,
      taskId: session.taskId,
      role: "relay-room",
    },
  });

  await runtime.ensureConnection({
    entityId: session.userEntityId,
    roomId: session.roomId,
    worldId: BENCHMARK_WORLD_ID,
    userName: "Benchmark User",
    source: "benchmark",
    channelId: `bench-${session.taskId}`,
    type: ChannelType.API,
    messageServerId: BENCHMARK_MESSAGE_SERVER_ID,
    metadata: {
      benchmark: session.benchmark,
      taskId: session.taskId,
      role: "benchmark-room",
    },
  });
  await runtime.ensureParticipantInRoom(runtime.agentId, session.relayRoomId);
}

/**
 * Pin a runtime role for the given entity in the bench world. Used by
 * `/api/benchmark/message` so scenarios that need an admin or non-admin
 * sender can drive the role-gate deterministically. Without this, every
 * bench entity resolves to GUEST and PERSONALITY-style ADMIN-gated ops
 * deny universally — the `scope_global_vs_user` bucket cannot discriminate.
 *
 * The caller passes the same entityId it places on outbound bench Memories;
 * the bench server normalizes that id to a UUID via `stringToUuid` so any
 * scenario-defined string ("admin", "user-1", etc.) maps stably.
 *
 * Idempotent. When `role === "GUEST"` the entry is dropped from
 * `world.metadata.roles` (so the resolver falls back to GUEST anyway).
 */
export async function seedBenchUserRole(
  runtime: AgentRuntime,
  session: BenchmarkSession,
  entityId: UUID,
  role: RoleName,
): Promise<void> {
  // Make sure the entity participates in the bench room before assigning
  // a role — the role-resolver looks up the entity's metadata via
  // `runtime.getEntityById`, which the connection step creates.
  await runtime.ensureConnection({
    entityId,
    roomId: session.roomId,
    worldId: BENCHMARK_WORLD_ID,
    userName: `bench-entity-${entityId.slice(0, 8)}`,
    source: "benchmark",
    channelId: `bench-${session.taskId}`,
    type: ChannelType.API,
    messageServerId: BENCHMARK_MESSAGE_SERVER_ID,
    metadata: {
      benchmark: session.benchmark,
      taskId: session.taskId,
      role: "benchmark-room",
    },
  });

  // setEntityRole resolves the world via the message's roomId, so build the
  // smallest Memory shape that satisfies the resolver.
  const seedMessage: Memory = {
    id: stringToUuid(`bench-role-seed:${entityId}:${session.taskId}`),
    entityId,
    agentId: runtime.agentId,
    roomId: session.roomId,
    content: { text: "", source: "benchmark" },
    createdAt: Date.now(),
  };
  await setEntityRole(runtime, seedMessage, entityId, role, "manual");
}

/**
 * Pull personality audit-log memories written by the PERSONALITY action
 * during the latest turn(s) and project them to the compact trajectory
 * shape. Used by `/api/benchmark/message` so judges can grade real
 * mutation attempts (especially deny verdicts in `scope_global_vs_user`).
 *
 * Returns at most `limit` entries newest-first. Entries written before
 * `sinceMs` are excluded — callers pass the turn's `startedAt` so the
 * trajectory step only shows audit entries from this turn.
 *
 * Audit entries are written to `roomId` (the bench session room) by the
 * runtime PERSONALITY action; see `personality.ts:recordAuditMemory`.
 */
export async function collectPersonalityAuditLog(
  runtime: AgentRuntime,
  roomId: UUID,
  sinceMs: number,
  limit = 16,
): Promise<BenchmarkPersonalityAuditEntry[]> {
  const memories = await runtime.getMemories({
    roomId,
    tableName: "personality_audit_log",
    count: limit,
    start: sinceMs,
  });
  if (!Array.isArray(memories) || memories.length === 0) return [];
  const entries: BenchmarkPersonalityAuditEntry[] = [];
  for (const memory of memories) {
    const meta = (memory.metadata ?? {}) as Record<string, unknown>;
    const action = typeof meta.action === "string" ? meta.action : "";
    const scope =
      typeof meta.personalityScope === "string" ? meta.personalityScope : "";
    if (!action || !scope) continue;
    const targetId = typeof meta.targetId === "string" ? meta.targetId : "";
    const actorId =
      typeof meta.actorId === "string"
        ? meta.actorId
        : typeof memory.entityId === "string"
          ? memory.entityId
          : "";
    const timestampSource =
      typeof meta.timestamp === "number" && Number.isFinite(meta.timestamp)
        ? meta.timestamp
        : typeof memory.createdAt === "number" &&
            Number.isFinite(memory.createdAt)
          ? memory.createdAt
          : Date.now();
    entries.push({
      action,
      scope,
      actorId,
      targetId,
      timestamp: new Date(timestampSource).toISOString(),
    });
  }
  return entries;
}

// ─────────────────────────────────────────────────────────────────────────
// Role-seeding payload for /api/benchmark/reset.
//
// The personality `scope_global_vs_user` bucket needs the bench server to
// pin per-entity roles + seed PersonalityStore slots BEFORE the runner
// drives any user turns. Without this, the runtime's role-gate refuses
// every ADMIN-required op and the discriminating "global vs user" check
// can't be exercised. See
// docs/audits/lifeops-2026-05-11/SYNTHESIS-IMPLEMENTATION-PLAN.md P0-7.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Personality scope mode that the bench server seeds before scenario turns.
 *
 * - `global_wins`: a global directive is set; per-user directive is empty or
 *   subordinate. The agent must apply the global setting everywhere.
 * - `user_wins`: a per-user directive is set; global directive is empty or
 *   subordinate. The agent must respect the user override.
 * - `conflict_explicit`: BOTH global and user directives are set and the
 *   user-tagged actor is admin/owner — explicit override allowed.
 * - `conflict_implicit`: BOTH directives are set but the user-tagged actor
 *   is a non-admin — the agent must refuse a regular-user attempt to flip
 *   the global directive and offer a per-user alternative.
 */
export type ScopeSeedMode =
  | "global_wins"
  | "user_wins"
  | "conflict_explicit"
  | "conflict_implicit";

/**
 * Optional structured payload accepted by `POST /api/benchmark/reset`.
 *
 * Every field is optional. When `globalDirective` / `userDirective` are
 * provided, the bench server writes them into the runtime's PersonalityStore
 * BEFORE accepting the first benchmark message. When `userId` /
 * `globalRoleId` are provided, the bench server pins those entities to
 * USER and ADMIN roles respectively via `setEntityRole` so the runtime's
 * role gate (`hasRoleAccess`) returns the correct verdict on
 * personality-mutation actions.
 *
 * Back-compat: scenarios that don't send a `roles` block see no behavior
 * change. The PersonalityStore is always `.clear()`-ed on reset regardless
 * (synthesis P1-14) to prevent slot bleed across scenarios.
 */
export interface RoleSeedPayload {
  /** Single directive that should apply to every user in this benchmark. */
  globalDirective?: string;
  /** Directive that should apply ONLY to `userId`. */
  userDirective?: string;
  /** Which side wins in this scenario — judge uses this to grade. */
  scopeMode?: ScopeSeedMode;
  /** Entity id of the non-admin user driving the conversation. */
  userId?: string;
  /** Entity id that should be marked ADMIN for this benchmark. */
  globalRoleId?: string;
}

/**
 * Minimal structural shape of the runtime PersonalityStore service that
 * the bench-server role-seeding helper consumes. Declared inline so this
 * file does not depend on a non-public path of `@elizaos/core`. The
 * concrete service lives in
 * `packages/core/src/features/advanced-capabilities/personality/services/personality-store.ts`.
 */
interface BenchPersonalityStore {
  setSlot(slot: {
    userId: string;
    agentId: UUID;
    verbosity: string | null;
    tone: string | null;
    formality: string | null;
    reply_gate: string | null;
    custom_directives: string[];
    updated_at: string;
    source: "user" | "admin" | "agent_inferred";
  }): void;
  clear(): void;
}

const PERSONALITY_STORE_SERVICE = "PERSONALITY_STORE";
/** Mirror of `GLOBAL_PERSONALITY_SCOPE` from the runtime personality module. */
const PERSONALITY_GLOBAL_SCOPE = "global";

function getBenchPersonalityStore(
  runtime: AgentRuntime,
): BenchPersonalityStore | null {
  const service = (
    runtime as unknown as {
      getService: (name: string) => unknown;
    }
  ).getService(PERSONALITY_STORE_SERVICE);
  if (!service || typeof service !== "object") return null;
  const candidate = service as Partial<BenchPersonalityStore>;
  if (
    typeof candidate.setSlot !== "function" ||
    typeof candidate.clear !== "function"
  ) {
    return null;
  }
  return candidate as BenchPersonalityStore;
}

export function isScopeSeedMode(value: unknown): value is ScopeSeedMode {
  return (
    value === "global_wins" ||
    value === "user_wins" ||
    value === "conflict_explicit" ||
    value === "conflict_implicit"
  );
}

export function parseRoleSeedPayload(
  value: unknown,
): RoleSeedPayload | undefined {
  if (!isRecord(value)) return undefined;
  const out: RoleSeedPayload = {};
  if (typeof value.globalDirective === "string" && value.globalDirective) {
    out.globalDirective = value.globalDirective;
  }
  if (typeof value.userDirective === "string" && value.userDirective) {
    out.userDirective = value.userDirective;
  }
  if (isScopeSeedMode(value.scopeMode)) {
    out.scopeMode = value.scopeMode;
  }
  if (typeof value.userId === "string" && value.userId) {
    out.userId = value.userId;
  }
  if (typeof value.globalRoleId === "string" && value.globalRoleId) {
    out.globalRoleId = value.globalRoleId;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

/**
 * Always-clear the in-memory PersonalityStore so stale slots do not bleed
 * across benchmark scenarios sharing one runtime process (synthesis P1-14).
 * Returns true when the store was cleared; false when the runtime did not
 * load advanced capabilities (no-op).
 */
export function clearPersonalityStateOnReset(runtime: AgentRuntime): boolean {
  const store = getBenchPersonalityStore(runtime);
  if (!store) return false;
  store.clear();
  return true;
}

/**
 * Apply a role-seed payload to the bench runtime. Throws when the runtime
 * does not have the PersonalityStore service loaded but the payload had
 * something concrete to apply — callers should surface that as a 4xx since
 * the scenario asked for a guarantee the server can't provide.
 */
export function applyRoleSeedPayload(
  runtime: AgentRuntime,
  payload: RoleSeedPayload,
): {
  appliedGlobalDirective: boolean;
  appliedUserDirective: boolean;
  scopeMode: ScopeSeedMode | null;
} {
  const hasDirective = Boolean(
    payload.globalDirective || payload.userDirective,
  );
  if (!hasDirective) {
    return {
      appliedGlobalDirective: false,
      appliedUserDirective: false,
      scopeMode: payload.scopeMode ?? null,
    };
  }

  const store = getBenchPersonalityStore(runtime);
  if (!store) {
    throw new Error(
      "PersonalityStore service unavailable — bench server must load advanced capabilities (ADVANCED_CAPABILITIES=true) to accept role-seeding directives",
    );
  }

  const agentId = runtime.agentId;
  const now = new Date().toISOString();
  let appliedGlobalDirective = false;
  let appliedUserDirective = false;

  if (payload.globalDirective) {
    store.setSlot({
      userId: PERSONALITY_GLOBAL_SCOPE,
      agentId,
      verbosity: null,
      tone: null,
      formality: null,
      reply_gate: null,
      custom_directives: [payload.globalDirective],
      updated_at: now,
      source: "admin",
    });
    appliedGlobalDirective = true;
  }

  if (payload.userDirective && payload.userId) {
    store.setSlot({
      userId: payload.userId,
      agentId,
      verbosity: null,
      tone: null,
      formality: null,
      reply_gate: null,
      custom_directives: [payload.userDirective],
      updated_at: now,
      source: "user",
    });
    appliedUserDirective = true;
  }

  return {
    appliedGlobalDirective,
    appliedUserDirective,
    scopeMode: payload.scopeMode ?? null,
  };
}

export function createSession(
  taskId: string,
  benchmark: string,
): BenchmarkSession {
  const normalizedTaskId = taskId.trim() || "default-task";
  const normalizedBenchmark = benchmark.trim() || "unknown";
  const seed = `${normalizedBenchmark}:${normalizedTaskId}:${Date.now()}:${Math.random()}`;

  return {
    benchmark: normalizedBenchmark,
    taskId: normalizedTaskId,
    roomId: stringToUuid(`benchmark-room:${seed}`),
    relayRoomId: stringToUuid(`benchmark-relay:${seed}`),
    userEntityId: stringToUuid(`benchmark-user:${seed}`),
  };
}
