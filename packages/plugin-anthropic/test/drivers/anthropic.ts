// spec/anthropic/index.md, "Story: Ask an Anthropic model for a complete response"
import { once } from "node:events";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EventType,
  setAnthropicAccountPoolBridge,
  type GenerateTextParams,
  type IAgentRuntime,
  type TextStreamResult,
} from "@elizaos/core";
import type { Driver, Options } from "../../gen/anthropic.conformance.ts";
import type { AnthropicFinish, AnthropicRun, AnthropicTransport, Event } from "../../gen/anthropic.ts";
import { clearTokenCache, handleTextSmall } from "../../src/index.vibe";

type FinishDecision =
  | {
      readonly kind: "finish";
      readonly reason: AnthropicFinish;
      readonly nativeShapeValid: boolean;
      readonly usageAvailable: boolean;
    }
  | { readonly kind: "abort" };

interface PausedRequest {
  readonly transport: Exclude<AnthropicTransport, "RefuseAnthropic">;
  readonly expectsObject: boolean;
  readonly decision: PromiseWithResolvers<FinishDecision>;
}

interface EntitySlot {
  state: AnthropicRun;
  controller: AbortController | undefined;
  pendingRun: Promise<string | TextStreamResult> | undefined;
  paused: PausedRequest | undefined;
  nextPaused: PromiseWithResolvers<PausedRequest> | undefined;
  sawUsageEvent: boolean;
}

let server: Server | undefined;
let baseUrl = "";
let runEpoch = 0;
let cliDir: string | undefined;
const originalPath = process.env.PATH ?? "";
const slots = new Map<string, EntitySlot>();

function initialRun(): AnthropicRun {
  return {
    phase: "AnthropicIdle",
    chosenTransport: "RefuseAnthropic",
    expectsObject: false,
    reportedUsage: false,
  };
}

function slotOf(key: string): EntitySlot {
  let slot = slots.get(key);
  if (!slot) {
    slot = {
      state: initialRun(),
      controller: undefined,
      pendingRun: undefined,
      paused: undefined,
      nextPaused: undefined,
      sawUsageEvent: false,
    };
    slots.set(key, slot);
  }
  return slot;
}

function wireStopReason(reason: AnthropicFinish): string | null {
  if (reason === "EndTurn") return "end_turn";
  if (reason === "EndTool") return "tool_use";
  if (reason === "EndStop") return "stop_sequence";
  if (reason === "EndLimit") return "max_tokens";
  if (reason === "EndRefusal") return "refusal";
  return null;
}

function writeSseFinish(
  res: ServerResponse,
  decision: Extract<FinishDecision, { kind: "finish" }>,
): void {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
  if (decision.usageAvailable) {
    res.write(
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":0}}}\n\n',
    );
  }
  res.write('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\n');
  if (decision.reason === "EndFailure") {
    res.end();
    return;
  }
  const deltaPayload = decision.usageAvailable
    ? { type: "message_delta", delta: { stop_reason: wireStopReason(decision.reason) }, usage: { output_tokens: 5 } }
    : { type: "message_delta", delta: { stop_reason: wireStopReason(decision.reason) } };
  res.write(`event: message_delta\ndata: ${JSON.stringify(deltaPayload)}\n\n`);
  res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
}

function writeWholeFinish(
  res: ServerResponse,
  expectsObject: boolean,
  decision: Extract<FinishDecision, { kind: "finish" }>,
): void {
  if (res.writableEnded || res.destroyed) return;
  const text = expectsObject
    ? (decision.nativeShapeValid ? JSON.stringify({ ok: true }) : "not-json")
    : "ok";
  const content: unknown[] = decision.reason === "EndTool"
    ? [{ type: "text", text }, { type: "tool_use", id: "toolu_1", name: "PING", input: {} }]
    : [{ type: "text", text }];
  res.writeHead(200, { "content-type": "application/json", connection: "close" });
  res.end(
    JSON.stringify({
      content,
      stop_reason: wireStopReason(decision.reason),
      ...(decision.usageAvailable ? { usage: { input_tokens: 10, output_tokens: 5 } } : {}),
    }),
  );
}

function writeCliResponse(
  res: ServerResponse,
  streaming: boolean,
  decision: Extract<FinishDecision, { kind: "finish" }>,
): void {
  if (res.writableEnded || res.destroyed) return;
  if (streaming) {
    const lines: string[] = [];
    if (decision.usageAvailable) {
      lines.push(
        JSON.stringify({
          type: "stream_event",
          event: { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } },
        }),
      );
    }
    lines.push(
      JSON.stringify({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "ok" } },
      }),
    );
    if (decision.reason !== "EndFailure") {
      const stopReason = wireStopReason(decision.reason);
      lines.push(
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "message_delta",
            delta: { stop_reason: stopReason },
            ...(decision.usageAvailable ? { usage: { output_tokens: 5 } } : {}),
          },
        }),
      );
      lines.push(JSON.stringify({ type: "stream_event", event: { type: "message_stop" } }));
      lines.push(
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          stop_reason: stopReason,
          ...(decision.usageAvailable
            ? { modelUsage: { "claude-test": { inputTokens: 10, outputTokens: 5 } } }
            : {}),
        }),
      );
    }
    res.writeHead(200, { "content-type": "text/plain", connection: "close" });
    res.end(`${lines.join("\n")}\n`);
    return;
  }
  const stop = wireStopReason(decision.reason);
  const payload = {
    result: "ok",
    ...(stop !== null ? { stop_reason: stop } : { stop_reason: "error" }),
    ...(decision.usageAvailable ? { modelUsage: { "claude-test": { inputTokens: 10, outputTokens: 5 } } } : {}),
  };
  res.writeHead(200, { "content-type": "application/json", connection: "close" });
  res.end(JSON.stringify(payload));
}

async function ensureInfra(): Promise<string> {
  if (server && cliDir) return baseUrl;
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => { chunks.push(chunk); });
    req.on("end", () => {
      const url = req.url ?? "";
      const sdkMatch = /^\/epoch\/(\d+)\/entity\/([^/]+)\/v1\/messages$/.exec(url);
      if (sdkMatch) {
        if (Number(sdkMatch[1]) !== runEpoch) {
          res.writeHead(404);
          res.end();
          return;
        }
        const key = decodeURIComponent(sdkMatch[2] ?? "");
        const slot = slotOf(key);
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          stream?: boolean;
          output_config?: { format?: unknown };
        };
        const transport: Exclude<AnthropicTransport, "RefuseAnthropic"> = body.stream === true ? "SdkStream" : "SdkWhole";
        const expectsObject = body.output_config?.format !== undefined;
        const decision = Promise.withResolvers<FinishDecision>();
        const paused: PausedRequest = { transport, expectsObject, decision };
        slot.paused = paused;
        const waiter = slot.nextPaused;
        slot.nextPaused = undefined;
        waiter?.resolve(paused);
        void decision.promise.then((chosen) => {
          if (chosen.kind === "abort") {
            if (!res.writableEnded && !res.destroyed) {
              res.writeHead(499, { connection: "close" });
              res.end();
            }
            return;
          }
          if (transport === "SdkStream") {
            writeSseFinish(res, chosen);
          } else {
            writeWholeFinish(res, expectsObject, chosen);
          }
        });
        return;
      }
      const cliMatch = /^\/epoch\/(\d+)\/cli\/([^/]+)\/(stream|whole)$/.exec(url);
      if (cliMatch) {
        if (Number(cliMatch[1]) !== runEpoch) {
          res.writeHead(404, { connection: "close" });
          res.end();
          return;
        }
        const key = decodeURIComponent(cliMatch[2] ?? "");
        const streaming = cliMatch[3] === "stream";
        const slot = slotOf(key);
        const transport: Exclude<AnthropicTransport, "RefuseAnthropic"> = streaming ? "CliStream" : "CliWhole";
        const decision = Promise.withResolvers<FinishDecision>();
        const paused: PausedRequest = { transport, expectsObject: false, decision };
        slot.paused = paused;
        const waiter = slot.nextPaused;
        slot.nextPaused = undefined;
        waiter?.resolve(paused);
        void decision.promise.then((chosen) => {
          if (chosen.kind === "abort") {
            if (!res.writableEnded && !res.destroyed) {
              res.writeHead(499, { connection: "close" });
              res.end();
            }
            return;
          }
          writeCliResponse(res, streaming, chosen);
        });
        return;
      }
      res.writeHead(404, { connection: "close" });
      res.end();
    });
  });
  server.keepAliveTimeout = 0;
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;

  cliDir = mkdtempSync(join(tmpdir(), "anthropic-cli-driver-"));
  const shimPath = join(cliDir, "claude");
  const shimSource = `#!/usr/bin/env node
const args = process.argv.slice(2);
const streaming = args.includes("stream-json");
const prompt = args[args.length - 1] ?? "";
const match = /^epoch:(\\d+):key:([^\\s]+)$/.exec(prompt.trim());
const epoch = match ? match[1] : "0";
const key = match ? match[2] : "a";
const url = "${baseUrl}/epoch/" + epoch + "/cli/" + encodeURIComponent(key) + "/" + (streaming ? "stream" : "whole");
fetch(url).then(async (res) => {
  const text = await res.text();
  process.stdout.write(text);
  process.exit(0);
}).catch(() => process.exit(1));
`;
  writeFileSync(shimPath, shimSource, "utf8");
  chmodSync(shimPath, 0o755);
  process.env.PATH = `${cliDir}:${originalPath}`;
  setAnthropicAccountPoolBridge({
    selectAnthropicSubscription: () => Promise.resolve({ id: "conformance-oauth", expiresAt: Date.now() + 600_000 }),
    getAccessToken: () => Promise.resolve("conformance-oauth-token"),
    markInvalid: () => Promise.resolve(),
    markRateLimited: () => Promise.resolve(),
  });
  return baseUrl;
}

function makeRuntime(
  epoch: number,
  key: string,
  root: string,
  extra: Record<string, string>,
  onUsage: () => void,
): IAgentRuntime {
  const settings: Record<string, string> = {
    ANTHROPIC_BASE_URL: `${root}/epoch/${epoch}/entity/${encodeURIComponent(key)}/v1`,
    ANTHROPIC_SMALL_MODEL: "claude-test",
    ...extra,
  };
  return {
    character: { name: "Conformance", bio: [] },
    getSetting: (name: string) => (Object.hasOwn(settings, name) ? settings[name] : null),
    emitEvent: (type: string) => {
      if (type === String(EventType.MODEL_USED)) onUsage();
      return Promise.resolve();
    },
    reportError: () => undefined,
  } as unknown as IAgentRuntime;
}

async function drainResult(result: string | TextStreamResult): Promise<void> {
  if (typeof result === "object" && result !== null && "text" in result && result.text instanceof Promise) {
    await result.text;
  }
}

async function cleanupSlot(slot: EntitySlot): Promise<void> {
  slot.controller?.abort(new Error("reset"));
  slot.paused?.decision.resolve({ kind: "abort" });
  const pending = slot.pendingRun;
  slot.paused = undefined;
  slot.nextPaused = undefined;
  slot.controller = undefined;
  slot.pendingRun = undefined;
  if (pending) {
    await pending.then((value) => drainResult(value).catch(() => undefined), () => undefined);
  }
}

export const driver: Driver & AsyncDisposable = {
  async reset() {
    runEpoch += 1;
    for (const slot of slots.values()) {
      await cleanupSlot(slot);
    }
    slots.clear();
    clearTokenCache();
    await ensureInfra();
  },

  async dispatch(key: string, event: Event) {
    const slot = slotOf(key);
    const root = await ensureInfra();

    if (event.type === "beginAnthropic") {
      if (slot.state.phase !== "AnthropicIdle") return "refused";
      const epoch = runEpoch;
      const settings: Record<string, string> = {
        ANTHROPIC_AUTH_MODE:
          event.auth === "AnthropicCli"
            ? "cli"
            : event.auth === "AnthropicOAuth"
              ? "oauth"
              : "apikey",
        ANTHROPIC_API_KEY: event.auth === "AnthropicApi" ? "conformance-api-key" : "",
        ANTHROPIC_MAX_OUTPUT_TOKENS: `claude-test:${event.capacity}`,
        ELIZA_ANTHROPIC_DISABLE_STREAM: event.input.streamingAllowed ? "false" : "true",
      };
      slot.sawUsageEvent = false;
      const runtime = makeRuntime(epoch, key, root, settings, () => { slot.sawUsageEvent = true; });
      const controller = new AbortController();
      const promptToken = `epoch:${epoch}:key:${key}`;
      const params: GenerateTextParams = {
        prompt: promptToken,
        signal: controller.signal,
        ...(event.cap.tag === "AskedCap" ? { maxTokens: event.cap.tokens } : {}),
        ...(event.input.hasNativeMessages ? { messages: [{ role: "user", content: promptToken }] } : {}),
        ...(event.input.hasTools
          ? { tools: [{ name: "PING", description: "Ping.", parameters: { type: "object", properties: {} } }] }
          : {}),
        ...(event.input.hasToolChoice ? { toolChoice: "auto" as const } : {}),
        ...(event.input.hasSchema
          ? { responseSchema: { type: "object", properties: { ok: { type: "boolean" } } } }
          : {}),
        ...(event.input.wantsStream ? { stream: true } : {}),
      };
      const waitPaused = Promise.withResolvers<PausedRequest>();
      slot.controller = controller;
      slot.nextPaused = waitPaused;
      const run = handleTextSmall(runtime, params).then(async (value) => {
        await drainResult(value);
        return value;
      });
      void run.catch(() => undefined);
      slot.pendingRun = run;

      const reached = await Promise.race([
        waitPaused.promise.then((paused) => ({ ok: true as const, paused })),
        run.then(
          () => ({ ok: false as const }),
          () => ({ ok: false as const }),
        ),
      ]);
      if (!reached.ok) {
        slot.controller = undefined;
        slot.pendingRun = undefined;
        slot.nextPaused = undefined;
        return "refused";
      }
      slot.state = {
        phase: "AnthropicRunning",
        chosenTransport: reached.paused.transport,
        expectsObject: event.input.hasSchema,
        reportedUsage: false,
      };
      return "accepted";
    }

    if (event.type === "finishAnthropic") {
      if (slot.state.phase !== "AnthropicRunning" || !slot.paused || !slot.pendingRun) return "refused";
      const paused = slot.paused;
      const pending = slot.pendingRun;
      slot.paused = undefined;
      slot.pendingRun = undefined;
      slot.controller = undefined;
      paused.decision.resolve({
        kind: "finish",
        reason: event.reason,
        nativeShapeValid: event.nativeShapeValid,
        usageAvailable: event.usageAvailable,
      });
      const succeeded = await pending.then(
        async (value) => {
          try {
            await drainResult(value);
            return true;
          } catch {
            return false;
          }
        },
        () => false,
      );
      await Promise.resolve();
      slot.state = {
        ...slot.state,
        phase: succeeded ? "AnthropicComplete" : "AnthropicFailed",
        reportedUsage: slot.sawUsageEvent,
      };
      return "accepted";
    }

    if (event.type === "cancelAnthropic") {
      if (slot.state.phase !== "AnthropicRunning") return "refused";
      await cleanupSlot(slot);
      slot.state = { ...slot.state, phase: "AnthropicCancelled" };
      return "accepted";
    }

    return "refused";
  },

  observe(key: string): AnthropicRun {
    return { ...slotOf(key).state };
  },

  async [Symbol.asyncDispose]() {
    for (const slot of slots.values()) {
      await cleanupSlot(slot);
    }
    slots.clear();
    setAnthropicAccountPoolBridge(null);
    clearTokenCache();
    process.env.PATH = originalPath;
    if (cliDir) {
      rmSync(cliDir, { recursive: true, force: true });
      cliDir = undefined;
    }
    if (server) {
      const closing = server;
      server = undefined;
      closing.closeAllConnections();
      await new Promise<void>((resolve) => { closing.close(() => resolve()); });
    }
  },
};

export const options: Options = { keys: ["a", "b"], walks: 20, steps: 20 };
