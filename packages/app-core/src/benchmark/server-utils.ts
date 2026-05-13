import {
  type AgentRuntime,
  ChannelType,
  elizaLogger,
  type Plugin,
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
 * Fixed entity UUID used as the world ownership anchor for all benchmark
 * sessions. Any message whose `entityId` matches this is treated as the
 * canonical owner (OWNER role) by the role resolution path, which means
 * `hasRoleAccess(runtime, msg, "ADMIN")` returns true without requiring
 * an explicit `seedBenchUserRole` call.
 */
export const BENCHMARK_OWNER_ENTITY_ID: UUID = stringToUuid(
  "eliza-benchmark-owner-entity",
);

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
   * Native OpenAI-compatible projection of captured Eliza action calls.
   * Benchmark adapters consume this instead of re-parsing prose or planner
   * params, so a result labeled "Eliza" proves the runtime emitted a real
   * action/tool call.
   */
  toolCalls?: BenchmarkToolCall[];
  metadata?: BenchmarkTurnMetadata;
  nativeTrajectory?: unknown;
}

export interface BenchmarkToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface BenchmarkTurnMetadata {
  agent_label: "eliza";
  benchmark: string;
  task_id: string;
  room_id: UUID;
  relay_room_id: UUID;
  trajectory_step: number;
  trajectory_endpoint: string;
  diagnostics_endpoint: string;
  native_trajectory_step_id: string | null;
  model_provider: string | null;
  model_name: string | null;
  compaction_strategy: string | null;
  compaction_threshold_tokens: number | null;
  auto_compact: string | null;
  tool_schema_count: number;
  tool_names: string[];
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

  const benchmark =
    typeof params.context?.benchmark === "string"
      ? params.context.benchmark
      : undefined;
  if (benchmark === "action-calling") {
    segments.push(
      "This is an action-calling benchmark. Use the available benchmark tool through Eliza's normal native action/function-calling path. Do not serialize tool calls in prose, XML, markdown, or JSON text.",
    );
  } else {
    segments.push(
      "Respond using normal Eliza action output so actions/params can be executed and evaluated.",
    );
  }

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

export function capturedActionsToToolCalls(
  capturedActions: CapturedAction[],
): BenchmarkToolCall[] {
  const calls: BenchmarkToolCall[] = [];
  for (const action of capturedActions) {
    const name = capturedActionToolName(action);
    if (!name) continue;
    calls.push({
      id: `call_benchmark_${calls.length}`,
      type: "function",
      function: {
        name,
        arguments: stableJsonStringify(capturedActionArguments(action)),
      },
    });
  }
  return calls;
}

function capturedActionToolName(action: CapturedAction): string | null {
  if (typeof action.toolName === "string" && action.toolName.trim()) {
    return action.toolName.trim();
  }
  if (typeof action.command === "string" && action.command.trim()) {
    return action.command.trim();
  }
  if (typeof action.operation === "string" && action.operation.trim()) {
    return action.operation.trim();
  }
  const params = isRecord(action.params) ? action.params : undefined;
  const paramTool = params?.tool_name;
  if (typeof paramTool === "string" && paramTool.trim()) {
    return paramTool.trim();
  }
  const paramCommand = params?.command;
  if (typeof paramCommand === "string" && paramCommand.trim()) {
    return paramCommand.trim();
  }
  return null;
}

function capturedActionArguments(
  action: CapturedAction,
): Record<string, unknown> {
  if (isRecord(action.arguments)) {
    return action.arguments;
  }
  const params = isRecord(action.params) ? { ...action.params } : {};
  delete params.tool_name;
  delete params.command;
  return params;
}

function stableJsonStringify(value: Record<string, unknown>): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, sortJson(item)]),
  );
}

export function benchmarkTurnMetadata(params: {
  session: BenchmarkSession;
  step: number;
  context?: Record<string, unknown>;
  nativeTrajectoryStepId?: string;
}): BenchmarkTurnMetadata {
  const tools = Array.isArray(params.context?.tools)
    ? params.context.tools.filter(isRecord)
    : [];
  return {
    agent_label: "eliza",
    benchmark: params.session.benchmark,
    task_id: params.session.taskId,
    room_id: params.session.roomId,
    relay_room_id: params.session.relayRoomId,
    trajectory_step: params.step,
    trajectory_endpoint: `/api/benchmark/trajectory?benchmark=${encodeURIComponent(params.session.benchmark)}&task_id=${encodeURIComponent(params.session.taskId)}`,
    diagnostics_endpoint: `/api/benchmark/diagnostics?benchmark=${encodeURIComponent(params.session.benchmark)}&task_id=${encodeURIComponent(params.session.taskId)}`,
    native_trajectory_step_id: params.nativeTrajectoryStepId ?? null,
    model_provider:
      process.env.BENCHMARK_MODEL_PROVIDER ??
      process.env.ELIZA_PROVIDER ??
      null,
    model_name:
      process.env.BENCHMARK_MODEL_NAME ??
      process.env.CEREBRAS_MODEL ??
      process.env.LARGE_MODEL ??
      null,
    compaction_strategy: process.env.ELIZA_CONVERSATION_COMPACTOR ?? null,
    compaction_threshold_tokens:
      numberFromEnv("ELIZA_COMPACTION_THRESHOLD_TOKENS") ??
      numberFromEnv("MAX_CONVERSATION_TOKENS"),
    auto_compact: process.env.AUTO_COMPACT ?? null,
    tool_schema_count: tools.length,
    tool_names: tools.map(toolSchemaName).filter((name) => name.length > 0),
  };
}

function numberFromEnv(name: string): number | null {
  const raw = process.env[name]?.trim();
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function toolSchemaName(tool: Record<string, unknown>): string {
  const fn = isRecord(tool.function) ? tool.function : undefined;
  const raw = tool.name ?? fn?.name;
  return typeof raw === "string" ? raw : "";
}

export function sessionKey(session: BenchmarkSession): string {
  return `${session.benchmark}:${session.taskId}`;
}

export async function ensureBenchmarkSessionContext(
  runtime: AgentRuntime,
  session: BenchmarkSession,
): Promise<void> {
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

  // Backfill ownership.ownerId on pre-existing worlds that were created
  // before this field was introduced.
  const existingWorld = await runtime.getWorld(BENCHMARK_WORLD_ID);
  if (existingWorld) {
    const meta = (existingWorld.metadata ?? {}) as Record<string, unknown>;
    const ownership = meta.ownership as Record<string, unknown> | undefined;
    if (!ownership?.ownerId) {
      meta.ownership = {
        ...(ownership ?? {}),
        ownerId: BENCHMARK_OWNER_ENTITY_ID,
      };
      await runtime.updateWorld({
        ...existingWorld,
        metadata: meta,
      } as Parameters<typeof runtime.updateWorld>[0]);
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

// ---------------------------------------------------------------------------
// Bench-server role-seeding helpers (P0-7)
// ---------------------------------------------------------------------------

/** Canonical role names accepted by the bench server. */
export type BenchRoleName = "OWNER" | "ADMIN" | "USER" | "GUEST";

/**
 * Normalize a role token from the runner's vocabulary to one of the four
 * canonical BenchRoleName values. Returns null for unknown or missing values.
 *
 * The runner uses "member" as an alias for USER; case is not significant.
 */
export function normalizeBenchRoleName(value: unknown): BenchRoleName | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase();
  if (normalized === "OWNER") return "OWNER";
  if (normalized === "ADMIN") return "ADMIN";
  if (normalized === "USER" || normalized === "MEMBER") return "USER";
  if (normalized === "GUEST") return "GUEST";
  return null;
}

/**
 * Write a role for `entityId` directly into the bench world's
 * `metadata.roles` map. This bypasses the normal `setEntityRole` path
 * (which requires a Memory object) so the bench runner can pin identities
 * before any messages are sent.
 */
export async function seedBenchUserRole(
  runtime: AgentRuntime,
  _session: BenchmarkSession,
  entityId: UUID,
  role: BenchRoleName,
): Promise<void> {
  const world = await runtime.getWorld(BENCHMARK_WORLD_ID);
  if (!world) {
    throw new Error(
      "[bench] BENCHMARK_WORLD_ID world not found — call ensureBenchmarkSessionContext first",
    );
  }
  const meta = (world.metadata ?? {}) as Record<string, unknown>;
  const roles = (meta.roles ?? {}) as Record<string, string>;
  roles[entityId] = role;
  meta.roles = roles;
  await runtime.updateWorld({
    ...world,
    metadata: meta,
  } as Parameters<typeof runtime.updateWorld>[0]);
}

// ---------------------------------------------------------------------------
// Personality-store role-seeding helpers (P0-7 scope_global_vs_user)
// ---------------------------------------------------------------------------

/** Valid values for the `scopeMode` field in a RoleSeedPayload. */
export type ScopeSeedMode =
  | "global_wins"
  | "user_wins"
  | "conflict_explicit"
  | "conflict_implicit";

/** Payload accepted by `/api/benchmark/reset` for personality role seeding. */
export interface RoleSeedPayload {
  globalDirective?: string;
  userDirective?: string;
  scopeMode?: ScopeSeedMode;
  userId?: string;
  globalRoleId?: string;
}

const SCOPE_SEED_MODES: Set<string> = new Set([
  "global_wins",
  "user_wins",
  "conflict_explicit",
  "conflict_implicit",
]);

/** Type-guard for ScopeSeedMode values. */
export function isScopeSeedMode(value: unknown): value is ScopeSeedMode {
  return typeof value === "string" && SCOPE_SEED_MODES.has(value);
}

/**
 * Parse and validate a raw role-seed payload from the request body.
 * Returns undefined if the input is not an object or has no recognizable
 * fields; drops individual fields that fail type checks.
 */
export function parseRoleSeedPayload(
  raw: unknown,
): RoleSeedPayload | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }

  const obj = raw as Record<string, unknown>;
  const out: RoleSeedPayload = {};
  let hasField = false;

  if (typeof obj.globalDirective === "string") {
    out.globalDirective = obj.globalDirective;
    hasField = true;
  }
  if (typeof obj.userDirective === "string") {
    out.userDirective = obj.userDirective;
    hasField = true;
  }
  if (isScopeSeedMode(obj.scopeMode)) {
    out.scopeMode = obj.scopeMode;
    hasField = true;
  }
  if (typeof obj.userId === "string") {
    out.userId = obj.userId;
    hasField = true;
  }
  if (typeof obj.globalRoleId === "string") {
    out.globalRoleId = obj.globalRoleId;
    hasField = true;
  }

  return hasField ? out : undefined;
}

interface PersonalityStoreSlot {
  userId: string;
  agentId: string;
  verbosity: string | null;
  tone: string | null;
  formality: string | null;
  reply_gate: string | null;
  custom_directives: string[];
  updated_at: string;
  source: string;
}

interface PersonalityStoreLike {
  setSlot(slot: PersonalityStoreSlot): void;
  clear(): void;
}

function isPersonalityStore(value: unknown): value is PersonalityStoreLike {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as Record<string, unknown>).clear === "function" &&
    typeof (value as Record<string, unknown>).setSlot === "function"
  );
}

/**
 * Call `clear()` on the runtime's PersonalityStore service if one is
 * registered. Returns true when the store was found and cleared, false when
 * no store is available (no-op, not an error).
 */
export function clearPersonalityStateOnReset(
  runtime: Pick<AgentRuntime, "getService">,
): boolean {
  const store = runtime.getService("PERSONALITY_STORE");
  if (!isPersonalityStore(store)) return false;
  store.clear();
  return true;
}

export interface ApplyRoleSeedResult {
  appliedGlobalDirective: boolean;
  appliedUserDirective: boolean;
  scopeMode: ScopeSeedMode | undefined;
}

/**
 * Apply a parsed RoleSeedPayload to the runtime's PersonalityStore.
 *
 * Throws when the payload carries a directive but the runtime has no
 * PersonalityStore service — the bench runner must install one before
 * calling this function for personality scope tests.
 */
export function applyRoleSeedPayload(
  runtime: Pick<AgentRuntime, "agentId" | "getService">,
  payload: RoleSeedPayload,
): ApplyRoleSeedResult {
  const result: ApplyRoleSeedResult = {
    appliedGlobalDirective: false,
    appliedUserDirective: false,
    scopeMode: payload.scopeMode,
  };

  const hasDirective = !!(payload.globalDirective || payload.userDirective);
  if (!hasDirective) {
    return result;
  }

  const store = runtime.getService("PERSONALITY_STORE");
  if (!isPersonalityStore(store)) {
    throw new Error(
      "[bench] PersonalityStore service unavailable — cannot apply role-seed directives. " +
        "Register a PersonalityStore service in the runtime before bench reset.",
    );
  }

  const now = new Date().toISOString();

  if (payload.globalDirective) {
    store.setSlot({
      userId: "global",
      agentId: runtime.agentId,
      verbosity: null,
      tone: null,
      formality: null,
      reply_gate: null,
      custom_directives: [payload.globalDirective],
      updated_at: now,
      source: "admin",
    });
    result.appliedGlobalDirective = true;
  }

  if (payload.userDirective && payload.userId) {
    store.setSlot({
      userId: payload.userId,
      agentId: runtime.agentId,
      verbosity: null,
      tone: null,
      formality: null,
      reply_gate: null,
      custom_directives: [payload.userDirective],
      updated_at: now,
      source: "user",
    });
    result.appliedUserDirective = true;
  }

  return result;
}
