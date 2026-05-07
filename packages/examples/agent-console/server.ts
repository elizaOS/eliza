// Agent Console — observable elizaOS AgentRuntime with a live dashboard.
// Spins up a real @elizaos/core AgentRuntime, wires plugin-openai (Cerebras-aware),
// wraps useModel and subscribes to EventType.* so the UI sees every stage,
// every prompt, every action, every evaluator, every model token.

import { join } from "node:path";
import {
  AgentRuntime,
  ChannelType,
  EventType,
  type ActionEventPayload,
  type Character,
  type EvaluatorEventPayload,
  type IAgentRuntime,
  type MessagePayload,
  type ModelEventPayload,
  type Plugin,
  type RunEventPayload,
  type UUID,
  createCharacter,
  createMessageMemory,
  stringToUuid,
} from "@elizaos/core";
import { openaiPlugin } from "@elizaos/plugin-openai";
import sqlPlugin from "@elizaos/plugin-sql";
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
    defaultLarge: "llama-3.3-70b-versatile",
    defaultSmall: "llama-3.1-8b-instant",
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

type Subscriber = (event: any) => void;
const subscribers = new Set<Subscriber>();
function broadcast(event: any) {
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

const TRAJECTORY_COLORS = [
  "#ff8a8a", "#ffb573", "#ffe76e", "#9ce67c",
  "#8ec5ff", "#a896ff", "#d896ff",
];

let currentTrajectoryId: string | null = null;
let currentTrajectoryColor = TRAJECTORY_COLORS[0];
let currentTrajectoryFinalText: string | null = null;

function newTrajectory(): { id: string; color: string } {
  const id = Math.random().toString(36).slice(2, 10);
  const color = TRAJECTORY_COLORS[Math.floor(Math.random() * TRAJECTORY_COLORS.length)];
  currentTrajectoryId = id;
  currentTrajectoryColor = color;
  currentTrajectoryFinalText = "";
  return { id, color };
}

function tag(extra: Record<string, unknown> = {}) {
  return { trajectoryId: currentTrajectoryId, color: currentTrajectoryColor, ...extra };
}

// ---------- runtime construction ----------

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
  },
});

const runtime: IAgentRuntime = new AgentRuntime({
  character,
  plugins: [
    sqlPlugin as unknown as Plugin,
    localEmbeddingPlugin as unknown as Plugin,
    openaiPlugin,
  ],
  logLevel: "warn",
});

// ---------- wrap useModel ----------

const origUseModel = runtime.useModel.bind(runtime);
let modelCallCounter = 0;
(runtime as any).useModel = async (modelType: any, params: any, providerName?: any) => {
  const callId = `mc-${++modelCallCounter}`;
  const start = Date.now();
  const promptPreview = (() => {
    try {
      if (typeof params?.prompt === "string") return params.prompt;
      if (Array.isArray(params?.messages)) return JSON.stringify(params.messages);
      return JSON.stringify(params);
    } catch {
      return String(params);
    }
  })();

  broadcast(
    tag({
      type: "model_call_start",
      callId,
      modelType: String(modelType),
      params: safeSnapshot(params),
      promptPreview: promptPreview.slice(0, 8000),
      promptBytes: promptPreview.length,
    })
  );
  try {
    const result = await origUseModel(modelType, params, providerName);
    broadcast(
      tag({
        type: "model_call_end",
        callId,
        modelType: String(modelType),
        result: safeSnapshot(result),
        responseText: stringifyResponse(result).slice(0, 8000),
        durationMs: Date.now() - start,
      })
    );
    return result;
  } catch (err: any) {
    broadcast(
      tag({
        type: "model_call_end",
        callId,
        modelType: String(modelType),
        error: err?.message ?? String(err),
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

// ---------- subscribe to runtime events ----------

function registerEventListeners(rt: IAgentRuntime) {
  const wrap = (evType: string, project: (p: any) => Record<string, unknown>) => {
    rt.registerEvent(evType as any, async (payload: any) => {
      try {
        broadcast(tag({ type: evType, ...project(payload) }));
      } catch (e: any) {
        broadcast(tag({ type: "log", level: "error", message: `event ${evType}: ${e.message}` }));
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
  const c: any = p.content;
  if (typeof c?.action === "string") return c.action;
  if (Array.isArray(c?.actions)) return c.actions.join(",");
  return "(unknown)";
}

// ---------- HTTP server ----------

const PORT = Number(process.env.PORT || 7777);

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
  const userId = stringToUuid("agent-console-user") as UUID;
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
    });
  } catch (err: any) {
    broadcast(tag({ type: "log", level: "error", message: err?.message ?? String(err) }));
    broadcast({
      type: "trajectory_end",
      trajectoryId: id,
      color,
      durationMs: Date.now() - startedAt,
      reason: "error",
    });
  } finally {
    activeRunPromise = null;
  }
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
