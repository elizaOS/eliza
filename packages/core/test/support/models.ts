// spec/core/index.md, "Each boundary operation has one owning layer"
import { once } from "node:events";
import { setImmediate } from "node:timers/promises";
import { type TextStreamResult } from "../../src/types/model.vibe";
import { type Plugin } from "../../src/types/plugin.vibe";
import { type IAgentRuntime } from "../../src/types/runtime.vibe";

export type ScriptedReply = string | number[] | number[][] | Uint8Array | { [key: string]: unknown };

export interface Scripted {
  reply?: ScriptedReply | ((params: unknown) => ScriptedReply);
  fail?: unknown;
  chunks?: string[];
  until?: Promise<void>;
  fetch?: string;
}

export interface SeenCall {
  modelType: string;
  params: unknown;
  body: string;
}

export interface ScriptedModels {
  plugin: Plugin;
  seen: SeenCall[];
  register(runtime: IAgentRuntime): void;
}

type ScriptedHandler = (runtime: IAgentRuntime, params: unknown) => Promise<ScriptedReply | TextStreamResult>;

type StreamChunk = (chunk: string) => void | Promise<void>;

function field(params: unknown, name: string): unknown {
  return typeof params === "object" && params !== null && name in params
    ? (params as Record<string, unknown>)[name]
    : undefined;
}

function signalOf(params: unknown): AbortSignal | undefined {
  const signal = field(params, "signal");
  return signal instanceof AbortSignal ? signal : undefined;
}

async function unlessAborted<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  signal.throwIfAborted();
  const settled = new AbortController();
  const aborted = once(signal, "abort", { signal: settled.signal }).then((): never => {
    signal.throwIfAborted();
    throw new TypeError("abort event on a signal that is not aborted");
  });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    settled.abort();
  }
}

async function readBody(url: string, signal: AbortSignal | undefined): Promise<string> {
  const response = await fetch(url, { signal });
  return response.text();
}

async function* streamOf(chunks: readonly string[], signal: AbortSignal | undefined): AsyncGenerator<string> {
  for (const chunk of chunks) {
    await setImmediate();
    signal?.throwIfAborted();
    yield chunk;
  }
}

async function joined(chunks: readonly string[], signal: AbortSignal | undefined): Promise<string> {
  let text = "";
  for await (const chunk of streamOf(chunks, signal)) text += chunk;
  return text;
}

function textStream(chunks: readonly string[], signal: AbortSignal | undefined): TextStreamResult {
  const text = joined(chunks, signal);
  text.catch(() => undefined);
  return {
    textStream: streamOf(chunks, signal),
    text,
    usage: Promise.resolve(undefined),
    finishReason: Promise.resolve("stop"),
  };
}

async function answer(script: Scripted, params: unknown): Promise<ScriptedReply | TextStreamResult> {
  const signal = signalOf(params);
  signal?.throwIfAborted();
  if (script.until) await unlessAborted(script.until, signal);
  const fetched = script.fetch === undefined ? undefined : await readBody(script.fetch, signal);
  if ("fail" in script) throw script.fail;
  const reply = typeof script.reply === "function" ? script.reply(params) : script.reply;
  const chunks = script.chunks;
  if (chunks) {
    const onChunk = field(params, "onStreamChunk");
    if (typeof onChunk === "function") {
      for (const chunk of chunks) {
        signal?.throwIfAborted();
        await (onChunk as StreamChunk)(chunk);
      }
    } else if (field(params, "stream") === true) {
      return textStream(chunks, signal);
    }
  }
  return reply ?? fetched ?? chunks?.join("") ?? "";
}

function scriptedHandler(modelType: string, entries: readonly Scripted[], seen: SeenCall[]): ScriptedHandler {
  let calls = 0;
  return (_runtime, params) => {
    const script = entries[Math.min(calls, entries.length - 1)] ?? {};
    calls += 1;
    seen.push({ modelType, params, body: JSON.stringify(params) ?? "" });
    return answer(script, params);
  };
}

export function scriptedModels(
  provider: string,
  priority: number,
  script: Partial<Record<string, Scripted[]>>,
): ScriptedModels {
  const seen: SeenCall[] = [];
  const handlers = Object.entries(script).map(
    ([modelType, entries]) => [modelType, scriptedHandler(modelType, entries ?? [], seen)] as const,
  );
  return {
    plugin: {
      name: provider,
      description: `Scripted ${provider} model provider`,
      priority,
      models: Object.fromEntries(handlers),
    },
    seen,
    register(runtime) {
      for (const [modelType, handler] of handlers) {
        runtime.registerModel(modelType, handler, provider, priority);
      }
    },
  };
}

function refusedSocket(code: string): Error {
  return Object.assign(new Error(`connect ${code} 127.0.0.1:9`), { code });
}

function cannotConnect(code = "ECONNREFUSED"): Error {
  return Object.assign(
    new Error(`Cannot connect to API: connect ${code} 127.0.0.1:9`, { cause: refusedSocket(code) }),
    { name: "AI_APICallError" },
  );
}

function overRefusedSocket(message: string, fields: { name?: string; code?: string }): Error {
  return Object.assign(new Error(message, { cause: cannotConnect() }), fields);
}

export function providerError(kind: "socket" | "retry" | "funding" | "policy" | "abort"): Error {
  switch (kind) {
    case "socket":
      return cannotConnect();
    case "retry": {
      const lastError = cannotConnect("ConnectionRefused");
      return Object.assign(new Error("Failed after 3 attempts. Last error: Cannot connect to API"), {
        name: "AI_RetryError",
        reason: "maxRetriesExceeded",
        lastError,
        errors: [lastError],
      });
    }
    case "funding":
      return overRefusedSocket("funding authority denied", { code: "MODEL_FUNDING_AUTHORITY_FAILED" });
    case "policy":
      return overRefusedSocket("processing policy denied", { code: "PROCESSING_POLICY_DENIED" });
    case "abort":
      return overRefusedSocket("request aborted", { name: "AbortError" });
  }
}
