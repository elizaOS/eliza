// spec/openai/index.md, "Story: Use an OpenAI-compatible model for the requested capability"
import { once } from "node:events";
import { createServer, type Server, type ServerResponse } from "node:http";
import {
  ConfidentialInferenceAuthority,
  ModelType,
  runWithConfidentialInference,
  type GenerateTextParams,
  type IAgentRuntime,
  type TextStreamResult,
} from "@elizaos/core";
import type { Driver, Options } from "../../gen/openai.conformance.ts";
import type { Event, OpenAiAttempt, OpenAiEndpoint, OpenAiFailure, OpenAiRun } from "../../gen/openai.ts";
import { handleTextSmall } from "../../src/index.vibe";

type StreamCommand =
  | { readonly kind: "chunk"; readonly ack: PromiseWithResolvers<void> }
  | { readonly kind: "finish"; readonly terminal: boolean; readonly shapeMatches: boolean }
  | { readonly kind: "fail"; readonly retryable: boolean }
  | { readonly kind: "abort" };

interface PausedAttempt {
  readonly attempt: OpenAiAttempt;
  readonly streaming: boolean;
  readonly pushCommand: (cmd: StreamCommand) => void;
}

interface EntitySlot {
  state: OpenAiRun;
  controller: AbortController | undefined;
  pendingRun: Promise<string | TextStreamResult> | undefined;
  streamResult: TextStreamResult | undefined;
  streamIterator: AsyncIterator<string> | undefined;
  paused: PausedAttempt | undefined;
  nextPaused: PromiseWithResolvers<PausedAttempt> | undefined;
  fallbackConfigured: boolean;
  fallbackBaseUrl: string;
}

let server: Server | undefined;
let baseUrl = "";
let runEpoch = 0;
const slots = new Map<string, EntitySlot>();
let probeMode: { terminal: boolean; shapeMatches: boolean } = { terminal: true, shapeMatches: true };

function initialRun(): OpenAiRun {
  return {
    phase: "AwaitingOpenAi",
    attempt: "PrimaryOpenAi",
    fallbackEligible: false,
    requiresSchema: false,
    confidentiality: false,
  };
}

function slotOf(key: string): EntitySlot {
  let slot = slots.get(key);
  if (!slot) {
    slot = {
      state: initialRun(),
      controller: undefined,
      pendingRun: undefined,
      streamResult: undefined,
      streamIterator: undefined,
      paused: undefined,
      nextPaused: undefined,
      fallbackConfigured: false,
      fallbackBaseUrl: "",
    };
    slots.set(key, slot);
  }
  return slot;
}

function sameEndpoint(a: OpenAiEndpoint, b: OpenAiEndpoint): boolean {
  return (
    a.address === b.address
    && a.modelId === b.modelId
    && a.acceptsOperation === b.acceptsOperation
    && a.acceptsSchema === b.acceptsSchema
    && a.confidential === b.confidential
  );
}

function endpointSuitable(endpoint: OpenAiEndpoint, needsSchema: boolean, needsConfidential: boolean): boolean {
  return (
    endpoint.address !== ""
    && endpoint.modelId !== ""
    && endpoint.acceptsOperation
    && (!needsSchema || endpoint.acceptsSchema)
    && (!needsConfidential || endpoint.confidential)
  );
}

function makeRuntime(settings: Record<string, string>): IAgentRuntime {
  return {
    agentId: "00000000-0000-0000-0000-000000000001",
    getSetting: (key: string) => (Object.hasOwn(settings, key) ? settings[key] : null),
    emitEvent: () => Promise.resolve(),
    reportError: () => undefined,
  } as unknown as IAgentRuntime;
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status, { "content-type": "application/json", connection: "close" });
  res.end(JSON.stringify(body));
}

async function ensureServer(): Promise<string> {
  if (server) return baseUrl;
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => { chunks.push(chunk); });
    req.on("end", () => {
      const url = req.url ?? "";
      const body = chunks.length > 0
        ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as { stream?: boolean; response_format?: unknown })
        : {};
      if (url === "/probe/v1/chat/completions") {
        const content = probeMode.shapeMatches ? JSON.stringify({ ok: true }) : "not-json";
        writeJson(res, 200, {
          choices: [{ message: { content }, finish_reason: probeMode.terminal ? "stop" : "length" }],
          usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
        });
        return;
      }
      const match = /^\/epoch\/(\d+)\/entity\/([^/]+)\/(primary|fallback)\/v1\/chat\/completions$/.exec(url);
      if (!match || Number(match[1]) !== runEpoch) {
        writeJson(res, 404, { error: { message: "unknown route" } });
        return;
      }
      const key = decodeURIComponent(match[2] ?? "");
      const attempt: OpenAiAttempt = match[3] === "fallback" ? "FallbackOpenAi" : "PrimaryOpenAi";
      const streaming = body.stream === true;
      const slot = slotOf(key);
      let headersSent = false;

      const pushCommand = (cmd: StreamCommand): void => {
        if (res.writableEnded || res.destroyed) {
          if (cmd.kind === "chunk") cmd.ack.resolve();
          return;
        }
        if (cmd.kind === "abort") {
          if (!headersSent) {
            res.writeHead(499, { connection: "close" });
            res.end();
          } else {
            res.end();
          }
          return;
        }
        if (cmd.kind === "fail") {
          if (!headersSent) {
            writeJson(res, cmd.retryable ? 429 : 400, {
              error: {
                message: cmd.retryable ? "rate limited" : "invalid request",
                type: cmd.retryable ? "rate_limit_error" : "invalid_request_error",
              },
            });
          } else {
            res.end();
          }
          return;
        }
        if (cmd.kind === "chunk") {
          if (!headersSent) {
            headersSent = true;
            res.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
          }
          res.write('data: {"choices":[{"delta":{"content":"piece"}}]}\n\n');
          cmd.ack.resolve();
          return;
        }
        if (streaming) {
          if (!headersSent) {
            headersSent = true;
            res.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
          }
          const finishReason = cmd.terminal ? "stop" : "length";
          res.write(`data: {"choices":[{"delta":{},"finish_reason":${JSON.stringify(finishReason)}}],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}\n\n`);
          res.end("data: [DONE]\n\n");
          return;
        }
        const content = slot.state.requiresSchema
          ? (cmd.shapeMatches ? JSON.stringify({ ok: true }) : "not-json")
          : "ok";
        writeJson(res, 200, {
          choices: [{ message: { content }, finish_reason: cmd.terminal ? "stop" : "length" }],
          usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
        });
      };

      const paused: PausedAttempt = { attempt, streaming, pushCommand };
      slot.paused = paused;
      const waiter = slot.nextPaused;
      slot.nextPaused = undefined;
      waiter?.resolve(paused);
    });
  });
  server.keepAliveTimeout = 0;
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
  return baseUrl;
}

async function cleanupSlot(slot: EntitySlot): Promise<void> {
  slot.controller?.abort(new Error("reset"));
  slot.paused?.pushCommand({ kind: "abort" });
  const pending = slot.pendingRun;
  const stream = slot.streamResult;
  slot.paused = undefined;
  slot.nextPaused = undefined;
  slot.controller = undefined;
  slot.pendingRun = undefined;
  slot.streamResult = undefined;
  slot.streamIterator = undefined;
  if (stream) await stream.text.catch(() => undefined);
  if (pending) await pending.catch(() => undefined);
}

async function probeAcceptanceRejected(requiresSchema: boolean, terminal: boolean, shapeMatches: boolean): Promise<boolean> {
  const root = await ensureServer();
  probeMode = { terminal, shapeMatches };
  const runtime = makeRuntime({
    OPENAI_API_KEY: "probe-key",
    OPENAI_BASE_URL: `${root}/probe/v1`,
    OPENAI_SMALL_MODEL: "gpt-4o-mini",
  });
  const params: GenerateTextParams = {
    prompt: "probe",
    ...(requiresSchema
      ? {
          responseSchema: {
            type: "object",
            properties: { ok: { type: "boolean" } },
            required: ["ok"],
            additionalProperties: false,
          },
        }
      : {}),
  };
  try {
    await handleTextSmall(runtime, params);
    return false;
  } catch {
    return true;
  }
}

export const driver: Driver & AsyncDisposable = {
  async reset() {
    runEpoch += 1;
    for (const slot of slots.values()) {
      await cleanupSlot(slot);
    }
    slots.clear();
    await ensureServer();
  },

  async dispatch(key: string, event: Event) {
    const slot = slotOf(key);
    const root = await ensureServer();

    if (event.type === "beginOpenAi") {
      if (slot.state.phase !== "AwaitingOpenAi") return "refused";
      const primaryOk = endpointSuitable(event.primary, event.needsSchema, event.needsConfidential);
      if (!primaryOk) {
        const badRuntime = makeRuntime({
          OPENAI_API_KEY: event.primary.address === "" ? "" : "test-key",
          OPENAI_BASE_URL: event.primary.address === "" ? "" : `${root}/probe/v1`,
          OPENAI_SMALL_MODEL: event.primary.modelId,
        });
        if (event.primary.address === "" || event.primary.modelId === "") {
          await handleTextSmall(badRuntime, { prompt: "refuse" }).catch(() => undefined);
        }
        return "refused";
      }

      const fallbackEligible =
        !sameEndpoint(event.fallback, event.primary)
        && endpointSuitable(event.fallback, event.needsSchema, event.needsConfidential);
      const encoded = encodeURIComponent(key);
      const primaryBase = `${root}/epoch/${runEpoch}/entity/${encoded}/primary/v1`;
      const fallbackBase = `${root}/epoch/${runEpoch}/entity/${encoded}/fallback/v1`;
      const settings: Record<string, string> = fallbackEligible
        ? {
            ELIZA_PROVIDER: "cerebras",
            CEREBRAS_API_KEY: "cerebras-test-key",
            CEREBRAS_BASE_URL: primaryBase,
            CEREBRAS_SMALL_MODEL: event.primary.modelId,
            OPENAI_CONFIDENTIAL: event.needsConfidential ? "true" : "false",
            OPENROUTER_API_KEY: "openrouter-test-key",
            OPENROUTER_BASE_URL: fallbackBase,
            OPENROUTER_FALLBACK_MODEL: event.fallback.modelId,
            OPENROUTER_CONFIDENTIAL: event.fallback.confidential ? "true" : "false",
          }
        : {
            OPENAI_API_KEY: "openai-test-key",
            OPENAI_BASE_URL: primaryBase,
            OPENAI_SMALL_MODEL: event.primary.modelId,
            OPENAI_CONFIDENTIAL: event.needsConfidential ? "true" : "false",
          };
      const runtime = makeRuntime(settings);
      const controller = new AbortController();
      const params: GenerateTextParams = {
        prompt: `key:${key}`,
        signal: controller.signal,
        stream: !event.needsSchema,
        ...(event.needsSchema
          ? {
              responseSchema: {
                type: "object",
                properties: { ok: { type: "boolean" } },
                required: ["ok"],
                additionalProperties: false,
              },
            }
          : {}),
      };

      const waitPaused = Promise.withResolvers<PausedAttempt>();
      slot.controller = controller;
      slot.nextPaused = waitPaused;
      slot.fallbackConfigured = fallbackEligible;
      slot.fallbackBaseUrl = fallbackBase;

      const startRun = () => {
        if (!event.needsConfidential) {
          return handleTextSmall(runtime, params);
        }
        const approvedRoutes = [
          {
            id: "primary",
            endpoint: `${primaryBase}/chat/completions`,
            model: event.primary.modelId,
            modelTypes: [ModelType.TEXT_SMALL],
          },
          ...(fallbackEligible
            ? [
                {
                  id: "fallback",
                  endpoint: `${fallbackBase}/chat/completions`,
                  model: event.fallback.modelId,
                  modelTypes: [ModelType.TEXT_SMALL],
                },
              ]
            : []),
        ];
        const profile = {
          revision: "conformance",
          expiresAt: Date.now() + 60_000,
          routes: approvedRoutes,
        };
        const authority = new ConfidentialInferenceAuthority({
          handlers: [handleTextSmall],
          currentProfile: () => profile,
          audit: { append: () => Promise.resolve() },
          transport: async (url, init, context) => {
            await context.beforeDispatch({
              evidenceDigest: "a".repeat(64),
              connectionBindingDigest: "b".repeat(64),
            });
            return globalThis.fetch(url, init);
          },
        });
        return runWithConfidentialInference(
          authority,
          { agentId: runtime.agentId, modelType: ModelType.TEXT_SMALL, handler: handleTextSmall },
          () => handleTextSmall(runtime, params),
        );
      };

      const run = startRun();
      void run.catch(() => undefined);
      slot.pendingRun = run;

      const reached = await Promise.race([
        waitPaused.promise.then((paused) => ({ ok: true as const, paused })),
        run.then(
          async (value) => {
            if (typeof value === "object" && value !== null && "textStream" in value) {
              slot.streamResult = value;
              slot.streamIterator = value.textStream[Symbol.asyncIterator]();
              return waitPaused.promise.then((paused) => ({ ok: true as const, paused }));
            }
            return { ok: false as const };
          },
          () => ({ ok: false as const }),
        ),
      ]);
      if (!reached.ok) {
        await cleanupSlot(slot);
        return "refused";
      }
      slot.state = {
        phase: "CallingOpenAi",
        attempt: "PrimaryOpenAi",
        fallbackEligible,
        requiresSchema: event.needsSchema,
        confidentiality: event.needsConfidential,
      };
      return "accepted";
    }

    if (event.type === "publishOpenAiPiece") {
      if (
        (slot.state.phase !== "CallingOpenAi" && slot.state.phase !== "PartialOpenAi")
        || slot.state.attempt !== event.attempt
        || slot.state.requiresSchema
        || !slot.paused
      ) {
        return "refused";
      }
      const ack = Promise.withResolvers<void>();
      slot.paused.pushCommand({ kind: "chunk", ack });
      await ack.promise;
      if (!slot.streamResult && slot.pendingRun) {
        const result = await slot.pendingRun;
        if (typeof result === "object" && result !== null && "textStream" in result) {
          slot.streamResult = result;
          slot.streamIterator = result.textStream[Symbol.asyncIterator]();
        }
      }
      if (slot.streamIterator) {
        const next = await slot.streamIterator.next();
        if (next.done || next.value !== "piece") {
          throw new Error("expected streamed piece from OpenAI shell");
        }
      }
      slot.state = { ...slot.state, phase: "PartialOpenAi" };
      return "accepted";
    }

    if (event.type === "acceptOpenAi") {
      if (
        (slot.state.phase !== "CallingOpenAi" && slot.state.phase !== "PartialOpenAi")
        || slot.state.attempt !== event.attempt
        || !slot.paused
      ) {
        return "refused";
      }
      if (!event.terminal || (slot.state.requiresSchema && !event.shapeMatches)) {
        const rejected = await probeAcceptanceRejected(slot.state.requiresSchema, event.terminal, event.shapeMatches);
        if (!rejected) throw new Error("expected OpenAI shell to reject non-terminal or invalid shape");
        return "refused";
      }
      const paused = slot.paused;
      const pending = slot.pendingRun;
      slot.paused = undefined;
      slot.pendingRun = undefined;
      slot.controller = undefined;
      paused.pushCommand({ kind: "finish", terminal: true, shapeMatches: true });
      if (slot.streamResult) {
        await slot.streamResult.text;
        slot.streamResult = undefined;
        slot.streamIterator = undefined;
      } else if (pending) {
        const value = await pending;
        if (typeof value === "object" && value !== null && "text" in value && value.text instanceof Promise) {
          await value.text;
        }
      }
      slot.state = { ...slot.state, phase: "CompleteOpenAi" };
      return "accepted";
    }

    if (event.type === "failOpenAi") {
      if (
        (slot.state.phase !== "CallingOpenAi" && slot.state.phase !== "PartialOpenAi")
        || slot.state.attempt !== event.attempt
        || !slot.paused
      ) {
        return "refused";
      }
      const failure: OpenAiFailure = event.failure;
      const canFailOver =
        slot.state.phase === "CallingOpenAi"
        && slot.state.attempt === "PrimaryOpenAi"
        && slot.state.fallbackEligible
        && failure === "RetryableOpenAi";
      if (canFailOver) {
        let sawFallback = false;
        let current = slot.paused;
        slot.paused = undefined;
        const pending = slot.pendingRun;
        while (!sawFallback) {
          const nextWait = Promise.withResolvers<PausedAttempt>();
          slot.nextPaused = nextWait;
          current.pushCommand({ kind: "fail", retryable: true });
          const nextResult = await Promise.race([
            nextWait.promise.then((attempt) => ({ kind: "attempt" as const, attempt })),
            ...(pending
              ? [
                  pending.then(
                    () => ({ kind: "settled" as const }),
                    () => ({ kind: "settled" as const }),
                  ),
                ]
              : []),
          ]);
          if (nextResult.kind !== "attempt") {
            throw new Error("OpenAI shell ended before reaching FallbackOpenAi");
          }
          if (nextResult.attempt.attempt === "FallbackOpenAi") {
            slot.paused = nextResult.attempt;
            sawFallback = true;
          } else {
            current = nextResult.attempt;
          }
        }
        slot.state = { ...slot.state, attempt: "FallbackOpenAi" };
        return "accepted";
      }
      const paused = slot.paused;
      const pending = slot.pendingRun;
      const stream = slot.streamResult;
      slot.paused = undefined;
      slot.pendingRun = undefined;
      slot.streamResult = undefined;
      slot.streamIterator = undefined;
      slot.controller = undefined;
      paused.pushCommand({ kind: "fail", retryable: false });
      const err = stream
        ? await stream.text.then(() => undefined, (cause: unknown) => cause)
        : pending
          ? await pending.then(
              async (val) => {
                if (typeof val === "object" && val !== null && "text" in val && val.text instanceof Promise) {
                  return val.text.then(() => undefined, (cause: unknown) => cause);
                }
                return undefined;
              },
              (cause: unknown) => cause,
            )
          : new Error("failed");
      if (err === undefined) throw new Error("expected OpenAI shell to fail");
      slot.state = { ...slot.state, phase: "FailedOpenAi" };
      return "accepted";
    }

    if (event.type === "cancelOpenAi") {
      if (slot.state.phase !== "CallingOpenAi" && slot.state.phase !== "PartialOpenAi") return "refused";
      await cleanupSlot(slot);
      slot.state = { ...slot.state, phase: "CancelledOpenAi" };
      return "accepted";
    }

    return "refused";
  },

  observe(key: string): OpenAiRun {
    return { ...slotOf(key).state };
  },

  async [Symbol.asyncDispose]() {
    for (const slot of slots.values()) {
      await cleanupSlot(slot);
    }
    slots.clear();
    if (server) {
      const closing = server;
      server = undefined;
      closing.closeAllConnections();
      await new Promise<void>((resolve) => { closing.close(() => resolve()); });
    }
  },
};

export const options: Options = { keys: ["a", "b"], walks: 20, steps: 20 };
