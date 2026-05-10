// Agent Console — observable elizaOS AgentRuntime with a live dashboard.
// Spins up a real @elizaos/core AgentRuntime, wires plugin-openai (Cerebras-aware),
// wraps useModel and subscribes to EventType.* so the UI sees every stage,
// every prompt, every action, every evaluator, every model token.

import { join, resolve } from "node:path";
import { scanRepoActions, type ActionScanSort } from "./action-scanner";
import {
  AgentRuntime,
  ChannelType,
  EventType,
  type ActionEventPayload,
  type Character,
  type ContextDefinition,
  type EvaluatorEventPayload,
  type EventPayloadMap,
  type GenerateTextParams,
  type IAgentRuntime,
  type MessagePayload,
  type ModelParamsMap,
  type ModelEventPayload,
  type ModelResultMap,
  type Plugin,
  type PromptSegment,
  type TokenUsage,
  type ToolDefinition,
  type RunEventPayload,
  type UUID,
  createCharacter,
  createMessageMemory,
  stringToUuid,
} from "@elizaos/core";
import { openaiPlugin } from "@elizaos/plugin-openai";
import { plugin as sqlPlugin } from "@elizaos/plugin-sql";
import localEmbeddingPlugin from "@elizaos/plugin-local-embedding";
import { v4 as uuidv4 } from "uuid";

// ---------- provider detection ----------

type ProviderConfig = {
  name: string;
  envKey: string;
  baseUrl: string;
  defaultLarge: string;
  defaultSmall: string;
};

const PROVIDERS: ProviderConfig[] = [
  {
    name: "cerebras",
    envKey: "CEREBRAS_API_KEY",
    baseUrl: "https://api.cerebras.ai/v1",
    defaultLarge: "gpt-oss-120b",
    defaultSmall: "gpt-oss-120b",
  },
  {
    name: "groq",
    envKey: "GROQ_API_KEY",
    baseUrl: "https://api.groq.com/openai/v1",
    defaultLarge: "openai/gpt-oss-120b",
    defaultSmall: "openai/gpt-oss-120b",
  },
  {
    name: "openrouter",
    envKey: "OPENROUTER_API_KEY",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultLarge: "openai/gpt-4o-mini",
    defaultSmall: "openai/gpt-4o-mini",
  },
  {
    name: "openai",
    envKey: "OPENAI_API_KEY",
    baseUrl: "https://api.openai.com/v1",
    defaultLarge: "gpt-4o-mini",
    defaultSmall: "gpt-4o-mini",
  },
];

function detectProvider(): (ProviderConfig & { apiKey: string }) | null {
  for (const p of PROVIDERS) {
    const key = process.env[p.envKey];
    if (key && key.trim().length > 0) return { ...p, apiKey: key.trim() };
  }
  return null;
}

const provider = detectProvider();
if (!provider) {
  console.error("\n  ✗ No API key found. Set one of:");
  for (const p of PROVIDERS) console.error(`     - ${p.envKey}`);
  process.exit(1);
}

// Inject the env vars plugin-openai expects so its Cerebras auto-detect kicks in.
process.env.OPENAI_BASE_URL = provider.baseUrl;
if (!process.env.OPENAI_API_KEY) process.env.OPENAI_API_KEY = provider.apiKey;
if (provider.name === "cerebras") process.env.MILADY_PROVIDER = "cerebras";
if (!process.env.OPENAI_LARGE_MODEL)
  process.env.OPENAI_LARGE_MODEL = process.env.AGENT_MODEL || provider.defaultLarge;
if (!process.env.OPENAI_SMALL_MODEL)
  process.env.OPENAI_SMALL_MODEL = provider.defaultSmall;
// Cerebras has no embedding endpoint; force local embedding regardless.
process.env.OPENAI_EMBEDDING_DISABLED = "true";

// ---------- SSE bus ----------

type ConsoleEvent = Record<string, unknown> & { t?: number };
type Subscriber = (event: ConsoleEvent & { t: number }) => void;
const subscribers = new Set<Subscriber>();
function broadcast(event: ConsoleEvent) {
  const payload = { ...event, t: event.t ?? Date.now() };
  for (const sub of subscribers) {
    try {
      sub(payload);
    } catch {
      subscribers.delete(sub);
    }
  }
}

// ---------- trajectory state ----------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringifyContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const TRAJECTORY_COLORS = [
  "#ff8a8a", "#ffb573", "#ffe76e", "#9ce67c",
  "#8ec5ff", "#a896ff", "#d896ff",
];

let currentTrajectoryId: string | null = null;
let currentTrajectoryColor = TRAJECTORY_COLORS[0];
let currentTrajectoryFinalText: string | null = null;

type TrajectoryStats = {
  modelCalls: number;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  errors: number;
  prefixHashes: Set<string>;
};
let currentStats: TrajectoryStats = {
  modelCalls: 0,
  promptTokens: 0,
  completionTokens: 0,
  cacheReadTokens: 0,
  errors: 0,
  prefixHashes: new Set(),
};

function newTrajectory(): { id: string; color: string } {
  const id = Math.random().toString(36).slice(2, 10);
  const color = TRAJECTORY_COLORS[Math.floor(Math.random() * TRAJECTORY_COLORS.length)];
  currentTrajectoryId = id;
  currentTrajectoryColor = color;
  currentTrajectoryFinalText = "";
  currentStats = {
    modelCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
    cacheReadTokens: 0,
    errors: 0,
    prefixHashes: new Set(),
  };
  return { id, color };
}

function tag(extra: Record<string, unknown> = {}) {
  return { trajectoryId: currentTrajectoryId, color: currentTrajectoryColor, ...extra };
}

// ---------- runtime construction ----------

// Operator entity. We mark it as the canonical OWNER via ELIZA_ADMIN_ENTITY_ID
// so the role gate on contexts (knowledge, files, code, terminal, admin, …)
// passes. Without this, every console message would be treated as GUEST and
// only `simple` + `general` would route — leaving 14+ tool-bearing contexts
// unreachable.
const OPERATOR_ENTITY_ID = stringToUuid("agent-console-user") as UUID;

const character: Character = createCharacter({
  name: "Eliza",
  bio: "An observable AI assistant running inside the agent console.",
  system:
    "You are Eliza, a helpful AI assistant. The operator can see every stage of your reasoning in real time. Be concise.",
  secrets: {
    OPENAI_API_KEY: provider.apiKey,
    OPENAI_BASE_URL: provider.baseUrl,
    OPENAI_LARGE_MODEL: process.env.OPENAI_LARGE_MODEL,
    OPENAI_SMALL_MODEL: process.env.OPENAI_SMALL_MODEL,
    CEREBRAS_API_KEY: provider.name === "cerebras" ? provider.apiKey : "",
    MILADY_PROVIDER: provider.name === "cerebras" ? "cerebras" : "",
    ELIZA_ADMIN_ENTITY_ID: OPERATOR_ENTITY_ID,
  },
});

const runtime: IAgentRuntime = new AgentRuntime({
  character,
  plugins: [
    sqlPlugin,
    localEmbeddingPlugin,
    openaiPlugin,
  ],
  logLevel: "warn",
});

// ---------- wrap useModel ----------

type SegmentView = {
  role: string;
  label?: string;
  content: string;
  bytes: number;
  stable?: boolean;
};

function messagesToSegmentViews(messages: unknown): SegmentView[] {
  if (!Array.isArray(messages)) return [];
  return messages.map((message) => {
    const record = isRecord(message) ? message : {};
    const role = String(record.role ?? "user");
    const content = stringifyContent(record.content);
    return { role, content, bytes: content.length };
  });
}

function promptSegmentsToSegmentViews(segments: unknown): SegmentView[] {
  if (!Array.isArray(segments)) return [];
  return segments.map((segment) => {
    const record = isRecord(segment) ? segment : {};
    const content = typeof record.content === "string" ? record.content : "";
    return {
      role: record.label === "system" ? "system" : "segment",
      label: typeof record.label === "string" ? record.label : undefined,
      content,
      bytes: content.length,
      stable: record.stable === true,
    };
  });
}

function toolsToSummary(tools: unknown): { name: string; description?: string }[] {
  if (!Array.isArray(tools)) return [];
  return tools.map((tool) => {
    const record = isRecord(tool) ? tool : {};
    const fn = isRecord(record.function) ? record.function : undefined;
    const description = record.description ?? fn?.description;
    return {
      name: String(record.name ?? fn?.name ?? "?"),
      description: typeof description === "string" ? description : undefined,
    };
  });
}

type RuntimeUseModel = <T extends keyof ModelParamsMap, R = ModelResultMap[T]>(
  modelType: T,
  params: ModelParamsMap[T],
  provider?: string,
) => Promise<R>;

type UsageSnapshot = Partial<TokenUsage> & { cachedPromptTokens?: number };

function providerOption(
  params: unknown,
  providerKey: string,
): Record<string, unknown> | undefined {
  if (!isRecord(params) || !isRecord(params.providerOptions)) return undefined;
  const value = params.providerOptions[providerKey];
  return isRecord(value) ? value : undefined;
}

function usageFromResult(result: unknown): UsageSnapshot | undefined {
  if (!isRecord(result) || !isRecord(result.usage)) return undefined;
  const usage: UsageSnapshot = {
    promptTokens: readNumber(result.usage.promptTokens),
    completionTokens: readNumber(result.usage.completionTokens),
    totalTokens: readNumber(result.usage.totalTokens),
    cacheReadInputTokens: readNumber(result.usage.cacheReadInputTokens),
    cacheCreationInputTokens: readNumber(result.usage.cacheCreationInputTokens),
    cachedPromptTokens: readNumber(result.usage.cachedPromptTokens),
  };
  return Object.values(usage).some((value) => value !== undefined)
    ? usage
    : undefined;
}

const runtimeWithInstrumentedModel = runtime as IAgentRuntime & {
  useModel: RuntimeUseModel;
};
const origUseModel: RuntimeUseModel =
  runtimeWithInstrumentedModel.useModel.bind(runtime);
let modelCallCounter = 0;
runtimeWithInstrumentedModel.useModel = async <
  T extends keyof ModelParamsMap,
  R = ModelResultMap[T],
>(
  modelType: T,
  params: ModelParamsMap[T],
  providerName?: string,
): Promise<R> => {
  const callId = `mc-${++modelCallCounter}`;
  const start = Date.now();
  const textParams = isRecord(params) ? (params as Partial<GenerateTextParams>) : {};
  const messageViews = messagesToSegmentViews(textParams.messages);
  const segmentViews = promptSegmentsToSegmentViews(textParams.promptSegments);
  const toolsSummary = toolsToSummary(textParams.tools);
  const promptString = typeof textParams.prompt === "string" ? textParams.prompt : "";
  // Prefer the segmented messages view as the canonical input. Fall back to the
  // legacy prompt blob only when no messages are present (embeddings, simple
  // text-gen calls, etc.).
  const inputBytes =
    messageViews.length > 0
      ? messageViews.reduce((sum, m) => sum + m.bytes, 0)
      : promptString.length;
  const inputShape =
    messageViews.length > 0
      ? "messages"
      : promptString.length > 0
        ? "prompt"
        : "other";

  // Pull the prefix hash + Cerebras cache key off providerOptions so the
  // dashboard can show "same prefix as previous call" / cache key in flight.
  const elizaPo = providerOption(params, "eliza");
  const cerebrasPo = providerOption(params, "cerebras");
  const prefixHash =
    typeof elizaPo?.prefixHash === "string" ? elizaPo.prefixHash : undefined;
  const segmentHashes = Array.isArray(elizaPo?.segmentHashes)
    ? elizaPo.segmentHashes.filter((hash): hash is string => typeof hash === "string")
    : undefined;
  const cacheKey: string | undefined =
    typeof cerebrasPo?.prompt_cache_key === "string"
      ? cerebrasPo.prompt_cache_key
      : typeof cerebrasPo?.promptCacheKey === "string"
        ? cerebrasPo.promptCacheKey
        : typeof elizaPo?.promptCacheKey === "string"
          ? elizaPo.promptCacheKey
          : undefined;
  if (prefixHash) currentStats.prefixHashes.add(prefixHash);

  broadcast(
    tag({
      type: "model_call_start",
      callId,
      modelType: String(modelType),
      params: safeSnapshot(params),
      inputShape,
      inputBytes,
      messages: messageViews,
      promptSegments: segmentViews,
      tools: toolsSummary,
      toolChoice: textParams.toolChoice,
      hasResponseSchema: !!textParams.responseSchema,
      responseFormat: textParams.responseFormat,
      prefixHash,
      segmentHashCount: segmentHashes?.length ?? 0,
      cacheKey,
      promptPreview: promptString.slice(0, 8000),
      promptBytes: promptString.length,
    })
  );
  try {
    const result = await origUseModel<T, R>(modelType, params, providerName);
    const responseText = stringifyResponse(result);
    const toolCalls = extractToolCalls(result);
    const usage = usageFromResult(result);
    if (usage) {
      currentStats.modelCalls += 1;
      currentStats.promptTokens += usage.promptTokens ?? 0;
      currentStats.completionTokens += usage.completionTokens ?? 0;
      currentStats.cacheReadTokens +=
        usage.cacheReadInputTokens ?? usage.cachedPromptTokens ?? 0;
    }
    broadcast(
      tag({
        type: "model_call_end",
        callId,
        modelType: String(modelType),
        result: safeSnapshot(result),
        responseText: responseText.slice(0, 8000),
        toolCalls,
        usage,
        durationMs: Date.now() - start,
      })
    );
    return result;
  } catch (err: unknown) {
    currentStats.errors += 1;
    const errRecord = isRecord(err) ? err : {};
    const errorDetail = {
      message: errorMessage(err),
      cause: isRecord(errRecord.cause)
        ? errRecord.cause.message
        : errRecord.cause,
      responseBody: errRecord.responseBody,
      url: errRecord.url,
      statusCode: errRecord.statusCode,
    };
    broadcast(
      tag({
        type: "model_call_end",
        callId,
        modelType: String(modelType),
        error: errorMessage(err),
        errorDetail,
        durationMs: Date.now() - start,
      })
    );
    throw err;
  }
};

function safeSnapshot(v: unknown, depth = 4): unknown {
  if (depth < 0) return "[truncated]";
  if (v == null) return v;
  if (typeof v === "string") return v.length > 12000 ? v.slice(0, 12000) + "…" : v;
  if (typeof v !== "object") return v;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => safeSnapshot(x, depth - 1));
  const out: Record<string, unknown> = {};
  let i = 0;
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (i++ > 60) {
      out["…"] = "(truncated)";
      break;
    }
    out[k] = safeSnapshot(val, depth - 1);
  }
  return out;
}
function stringifyResponse(r: unknown): string {
  if (typeof r === "string") return r;
  try { return JSON.stringify(r, null, 2); } catch { return String(r); }
}

function extractToolCalls(result: unknown): { id?: string; name: string; arguments: unknown }[] {
  if (!result || typeof result !== "object") return [];
  const tcs = isRecord(result) ? result.toolCalls : undefined;
  if (!Array.isArray(tcs)) return [];
  return tcs.map((toolCall) => {
    const tc = isRecord(toolCall) ? toolCall : {};
    const fn = isRecord(tc.function) ? tc.function : undefined;
    const fnName = fn?.name ?? tc.name ?? tc.toolName;
    const args = fn?.arguments ?? tc.arguments ?? tc.input;
    let parsed: unknown = args;
    if (typeof args === "string") {
      try { parsed = JSON.parse(args); } catch { parsed = args; }
    }
    return {
      id: typeof tc.id === "string" ? tc.id : undefined,
      name: String(fnName ?? "?"),
      arguments: safeSnapshot(parsed),
    };
  });
}

// ---------- subscribe to runtime events ----------

function registerEventListeners(rt: IAgentRuntime) {
  const wrap = <T extends keyof EventPayloadMap>(
    evType: T,
    project: (p: EventPayloadMap[T]) => Record<string, unknown>,
  ) => {
    rt.registerEvent(evType, async (payload) => {
      try {
        broadcast(tag({ type: evType, ...project(payload) }));
      } catch (e: unknown) {
        broadcast(tag({ type: "log", level: "error", message: `event ${evType}: ${errorMessage(e)}` }));
      }
    });
  };

  wrap(EventType.RUN_STARTED, (p: RunEventPayload) => ({
    runId: String(p.runId), messageId: String(p.messageId), roomId: String(p.roomId),
  }));
  wrap(EventType.RUN_ENDED, (p: RunEventPayload) => ({
    runId: String(p.runId),
    status: p.status,
    duration: p.duration ? Number(p.duration) : undefined,
    error: p.error ? String(p.error) : undefined,
  }));
  wrap(EventType.RUN_TIMEOUT, (p: RunEventPayload) => ({
    runId: String(p.runId), error: p.error ? String(p.error) : "timeout",
  }));
  wrap(EventType.MESSAGE_RECEIVED, (p: MessagePayload) => ({
    messageId: String(p.message?.id),
    text: p.message?.content?.text ?? "",
    entityId: String(p.message?.entityId),
    roomId: String(p.message?.roomId),
  }));
  wrap(EventType.MESSAGE_SENT, (p: MessagePayload) => {
    const text = p.message?.content?.text ?? "";
    if (text && currentTrajectoryFinalText !== null) currentTrajectoryFinalText = text;
    return {
      messageId: String(p.message?.id),
      text,
      actions: p.message?.content?.actions,
    };
  });
  wrap(EventType.ACTION_STARTED, (p: ActionEventPayload) => ({
    name: extractActionName(p),
    content: safeSnapshot(p.content),
    messageId: p.messageId ? String(p.messageId) : undefined,
  }));
  wrap(EventType.ACTION_COMPLETED, (p: ActionEventPayload) => ({
    name: extractActionName(p),
    content: safeSnapshot(p.content),
    messageId: p.messageId ? String(p.messageId) : undefined,
  }));
  wrap(EventType.EVALUATOR_STARTED, (p: EvaluatorEventPayload) => ({
    evaluatorId: String(p.evaluatorId),
    name: p.evaluatorName,
  }));
  wrap(EventType.EVALUATOR_COMPLETED, (p: EvaluatorEventPayload) => ({
    evaluatorId: String(p.evaluatorId),
    name: p.evaluatorName,
    completed: p.completed,
    error: p.error ? String(p.error) : undefined,
  }));
  wrap(EventType.MODEL_USED, (p: ModelEventPayload) => ({
    modelType: String(p.type),
    tokens: p.tokens,
  }));
}

function extractActionName(p: ActionEventPayload): string {
  const content = isRecord(p.content) ? p.content : {};
  if (typeof content.action === "string") return content.action;
  if (Array.isArray(content.actions)) return content.actions.map(String).join(",");
  return "(unknown)";
}

// ---------- HTTP server ----------

const PORT = Number(process.env.PORT || 7777);
const REPO_ROOT = resolve(import.meta.dir, "../../..");

let initState: "pending" | "ready" | "error" = "pending";
let initError: string | null = null;
let activeRunPromise: Promise<unknown> | null = null;

const SESSION = {
  worldId: stringToUuid("agent-console-world") as UUID,
};

async function initialize() {
  try {
    registerEventListeners(runtime);
    await runtime.initialize();
    initState = "ready";
    console.log(`\n  AGENT CONSOLE  (elizaOS)  →  http://localhost:${PORT}`);
    console.log(`  provider: ${provider!.name}`);
    console.log(`  large model: ${process.env.OPENAI_LARGE_MODEL}`);
    console.log(`  small model: ${process.env.OPENAI_SMALL_MODEL}`);
    console.log(`  base URL:    ${provider!.baseUrl}\n`);
  } catch (err: any) {
    initState = "error";
    initError = err?.message ?? String(err);
    console.error("\n  ✗ Runtime init failed:", initError, "\n");
  }
}

async function handleUserMessage(text: string) {
  if (initState !== "ready") {
    broadcast(tag({ type: "log", level: "error", message: "runtime not ready: " + (initError ?? "initializing…") }));
    return;
  }

  // Fresh trajectory + fresh room: each user message clears the world.
  const { id, color } = newTrajectory();
  const roomId = stringToUuid(`agent-console-${id}`) as UUID;
  const userId = OPERATOR_ENTITY_ID;
  const startedAt = Date.now();

  broadcast({
    type: "trajectory_start",
    trajectoryId: id,
    color,
    userMessage: text,
    provider: provider!.name,
    model: process.env.OPENAI_LARGE_MODEL,
    baseUrl: provider!.baseUrl,
    character: character.name,
    t: startedAt,
  });

  try {
    await runtime.ensureConnection({
      entityId: userId,
      roomId,
      worldId: SESSION.worldId,
      userName: "Operator",
      source: "agent-console",
      channelId: `agent-console-${id}`,
      type: ChannelType.DM,
    } as Parameters<typeof runtime.ensureConnection>[0]);

    const messageMemory = createMessageMemory({
      id: uuidv4() as UUID,
      entityId: userId,
      roomId,
      content: { text, source: "agent-console", channelType: ChannelType.DM },
    });

    let postRespondError: string | null = null;
    activeRunPromise = runtime.messageService!.handleMessage(
      runtime,
      messageMemory,
      async (content: any) => {
        if (typeof content?.text === "string") {
          broadcast(tag({ type: "response_chunk", text: content.text }));
        }
        return [];
      }
    );
    try {
      await activeRunPromise;
    } catch (err: any) {
      postRespondError = err?.message ?? String(err);
    }

    const responded = !!currentTrajectoryFinalText;
    broadcast({
      type: "trajectory_end",
      trajectoryId: id,
      color,
      durationMs: Date.now() - startedAt,
      finalText: currentTrajectoryFinalText ?? "",
      reason: postRespondError ? (responded ? "ok-with-postlog-errors" : "error") : "ok",
      postRespondError: postRespondError ?? undefined,
      stats: snapshotStats(),
    });
  } catch (err: any) {
    broadcast(tag({ type: "log", level: "error", message: err?.message ?? String(err) }));
    broadcast({
      type: "trajectory_end",
      trajectoryId: id,
      color,
      durationMs: Date.now() - startedAt,
      reason: "error",
      stats: snapshotStats(),
    });
  } finally {
    activeRunPromise = null;
  }
}

function snapshotStats() {
  const totalIn = currentStats.promptTokens;
  const cached = currentStats.cacheReadTokens;
  return {
    modelCalls: currentStats.modelCalls,
    promptTokens: totalIn,
    completionTokens: currentStats.completionTokens,
    cacheReadTokens: cached,
    cacheHitPct: totalIn > 0 ? Math.round((cached / totalIn) * 1000) / 10 : 0,
    errors: currentStats.errors,
    distinctPrefixHashes: currentStats.prefixHashes.size,
  };
}

const server = Bun.serve({
  port: PORT,
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(Bun.file(join(import.meta.dir, "public", "index.html")), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    if (url.pathname === "/actions" || url.pathname === "/actions.html") {
      return new Response(Bun.file(join(import.meta.dir, "public", "actions.html")), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    if (url.pathname === "/action-scan") {
      const sort: ActionScanSort =
        url.searchParams.get("sort") === "filepath" ? "filepath" : "name";
      try {
        return Response.json(scanRepoActions({ repoRoot: REPO_ROOT, sort }));
      } catch (err: any) {
        return Response.json(
          { error: err?.message ?? String(err), stack: err?.stack },
          { status: 500 },
        );
      }
    }

    if (url.pathname === "/runtime") {
      const actions = (runtime.actions ?? []).map((a) => ({
        name: a.name,
        description: a.description,
        contexts: a.contexts ?? [],
        similes: (a.similes ?? []).slice(0, 6),
      }));
      const providers = (runtime.providers ?? []).map((p) => ({
        name: p.name,
        description: p.description,
        position: p.position,
        dynamic: p.dynamic ?? false,
      }));
      const contextsByName: Record<
        string,
        Pick<
          ContextDefinition,
          "label" | "description" | "cacheScope" | "roleGate"
        > & {
          actions?: unknown;
          providers?: unknown;
        }
      > = {};
      try {
        const list = runtime.contexts.list();
        for (const c of list) {
          contextsByName[String(c.id)] = {
            label: c.label,
            description: c.description,
            cacheScope: c.cacheScope,
            roleGate: c.roleGate,
          };
        }
      } catch {}
      return Response.json({
        agentId: runtime.agentId,
        characterName: runtime.character.name,
        actionCount: actions.length,
        providerCount: providers.length,
        contextCount: Object.keys(contextsByName).length,
        actions,
        providers,
        contexts: contextsByName,
      });
    }

    if (url.pathname === "/status") {
      return Response.json({
        provider: provider!.name,
        model: process.env.OPENAI_LARGE_MODEL,
        smallModel: process.env.OPENAI_SMALL_MODEL,
        baseUrl: provider!.baseUrl,
        runtimeState: initState,
        runtimeError: initError,
        agent: character.name,
        availableProviders: PROVIDERS.map((p) => ({
          name: p.name, envKey: p.envKey, present: !!process.env[p.envKey],
        })),
      });
    }

    if (url.pathname === "/events") {
      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          const send = (event: any) => {
            try {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
            } catch {
              subscribers.delete(send);
            }
          };
          subscribers.add(send);
          send({ type: "hello", t: Date.now(), runtimeState: initState });
          const ping = setInterval(() => {
            try {
              controller.enqueue(encoder.encode(`: ping\n\n`));
            } catch {
              clearInterval(ping);
            }
          }, 15_000);
          req.signal.addEventListener("abort", () => {
            clearInterval(ping);
            subscribers.delete(send);
            try { controller.close(); } catch {}
          });
        },
      });
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        },
      });
    }

    if (url.pathname === "/message" && req.method === "POST") {
      const body = (await req.json()) as { message?: string };
      const text = body.message?.trim();
      if (!text) return new Response("empty", { status: 400 });
      handleUserMessage(text);
      return Response.json({ ok: true });
    }

    return new Response("not found", { status: 404 });
  },
});

console.log(`\n  AGENT CONSOLE booting on http://localhost:${server.port} …`);
initialize();
