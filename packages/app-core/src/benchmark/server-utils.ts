import {
  type AgentRuntime,
  ChannelType,
  elizaLogger,
  type Plugin,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import type { BenchmarkContext, CapturedAction } from "./plugin";

export const DEFAULT_PORT = 3939;
export const DEFAULT_HOST = "127.0.0.1";
export const BENCHMARK_WORLD_ID = stringToUuid("eliza-benchmark-world");
export const BENCHMARK_MESSAGE_SERVER_ID = stringToUuid(
  "eliza-benchmark-message-server",
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

export function coerceParams(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }

  return {};
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
  await runtime.ensureWorldExists({
    id: BENCHMARK_WORLD_ID,
    name: "Eliza Benchmark World",
    agentId: runtime.agentId,
    messageServerId: BENCHMARK_MESSAGE_SERVER_ID,
    metadata: {
      type: "benchmark",
      description: "World used for benchmark sessions",
      extra: {
        benchmark: session.benchmark,
      },
    },
  });

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
