/**
 * Strict OpenAI-compatible wire adapter for Cloud E2E model fixtures.
 *
 * It resolves the same core registry used by in-process scenarios and serves
 * production-client-shaped completions, SSE, tools, usage, faults, and aborts.
 */

import { createHash } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { ModelType, type ModelTypeName } from "@elizaos/core";
import {
  applyDeterministicModelFixtureBehavior,
  createDeterministicModelFixtureRegistry,
  type DeterministicModelCall,
  type DeterministicModelDiagnostics,
  type DeterministicModelFixture,
  type DeterministicModelFixtureRegistry,
  type DeterministicModelResponse,
} from "@elizaos/core/testing";

export interface RunningMockLlm {
  url: string;
  port: number;
  requestCount: () => number;
  diagnostics: () => DeterministicModelDiagnostics;
  assertFixturesConsumed: () => void;
  stop: () => Promise<void>;
}

export interface MockLlmOptions {
  fixtures?: DeterministicModelFixture[];
  fixtureRegistry?: DeterministicModelFixtureRegistry;
  scenarioId?: string;
  attemptId?: string;
  worldId?: string;
  modelTypeForRequest?: (model: string) => ModelTypeName;
  /** Legacy fixed assistant reply. Default `PONG`. */
  reply?: string;
  completionTokens?: number;
  /** Legacy context-aware fixture used by existing multi-turn specs. */
  echoContext?: boolean;
}

interface OpenAiMessage {
  role: string;
  content?: unknown;
}

interface ChatCompletionRequestBody {
  model?: string;
  messages?: OpenAiMessage[];
  tools?: Array<{
    type?: string;
    function?: { name?: string; parameters?: unknown };
  }>;
  response_format?: unknown;
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
}

type WireResponse = {
  text: string;
  toolCalls: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
  finishReason: string;
  usage?: { promptTokens: number; completionTokens: number };
};

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (
        part &&
        typeof part === "object" &&
        "text" in part &&
        typeof part.text === "string"
      ) {
        return part.text;
      }
      return "";
    })
    .filter(Boolean)
    .join(" ");
}

function userMessages(body: ChatCompletionRequestBody): string[] {
  return (body.messages ?? [])
    .filter((message) => message.role === "user")
    .map((message) => contentToText(message.content));
}

function estimatePromptTokens(body: ChatCompletionRequestBody): number {
  const text = (body.messages ?? [])
    .map((message) => contentToText(message.content))
    .join(" ");
  return Math.max(8, Math.ceil(text.length / 4));
}

function legacyFixtures(options: MockLlmOptions): DeterministicModelFixture[] {
  const reply = options.reply ?? "PONG";
  return [
    {
      name: options.echoContext ? "legacy-context-echo" : "legacy-fixed-reply",
      times: "any",
      response: (call) => {
        if (!options.echoContext) return reply;
        const body = { messages: call.params.messages as OpenAiMessage[] };
        const users = userMessages(body);
        return `turn ${users.length} (prior user turns: ${Math.max(0, users.length - 1)}): ${users.at(-1) ?? ""}`;
      },
    },
  ];
}

function buildCall(
  body: ChatCompletionRequestBody,
  modelType: ModelTypeName,
  signal: AbortSignal,
): DeterministicModelCall {
  const messages = body.messages ?? [];
  return {
    modelType,
    latestUserText: userMessages(body).at(-1) ?? "",
    toolNames: (body.tools ?? [])
      .map((tool) => tool.function?.name)
      .filter((name): name is string => typeof name === "string"),
    params: {
      messages: messages as never,
      prompt: messages
        .map((message) => `${message.role}: ${contentToText(message.content)}`)
        .join("\n"),
      tools: (body.tools ?? []).flatMap((tool) =>
        tool.function?.name
          ? [
              {
                name: tool.function.name,
                description: "Cloud E2E fixture tool",
                parameters: tool.function.parameters ?? {},
              },
            ]
          : [],
      ) as never,
      responseSchema: body.response_format as never,
      signal,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeWireResponse(
  response: DeterministicModelResponse,
  defaultCompletionTokens: number,
): WireResponse {
  if (typeof response === "string") {
    return {
      text: response,
      toolCalls: [],
      finishReason: "stop",
      usage: { promptTokens: 0, completionTokens: defaultCompletionTokens },
    };
  }
  const record = isRecord(response) ? response : {};
  const toolCalls = Array.isArray(record.toolCalls)
    ? record.toolCalls.flatMap((candidate, index) => {
        if (!isRecord(candidate) || typeof candidate.name !== "string")
          return [];
        return [
          {
            id:
              typeof candidate.id === "string"
                ? candidate.id
                : `call-${index + 1}`,
            name: candidate.name,
            arguments: isRecord(candidate.arguments) ? candidate.arguments : {},
          },
        ];
      })
    : [];
  const usage = isRecord(record.usage)
    ? {
        promptTokens:
          typeof record.usage.promptTokens === "number"
            ? record.usage.promptTokens
            : 0,
        completionTokens:
          typeof record.usage.completionTokens === "number"
            ? record.usage.completionTokens
            : defaultCompletionTokens,
      }
    : undefined;
  return {
    text:
      typeof record.text === "string"
        ? record.text
        : toolCalls.length === 0 && Object.keys(record).length > 0
          ? JSON.stringify(record)
          : "",
    toolCalls,
    finishReason:
      typeof record.finishReason === "string"
        ? record.finishReason === "tool-calls"
          ? "tool_calls"
          : record.finishReason
        : toolCalls.length > 0
          ? "tool_calls"
          : "stop",
    usage,
  };
}

async function readJsonBody(
  request: IncomingMessage,
): Promise<ChatCompletionRequestBody> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  // error-policy:J3 Invalid OpenAI input is rejected at the HTTP boundary.
  const value = JSON.parse(raw) as unknown;
  if (!isRecord(value)) throw new Error("request body must be a JSON object");
  return value as ChatCompletionRequestBody;
}

function writeJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

function openAiToolCalls(wire: WireResponse, includeIndex = false) {
  return wire.toolCalls.map((toolCall, index) => ({
    ...(includeIndex ? { index } : {}),
    id: toolCall.id,
    type: "function",
    function: {
      name: toolCall.name,
      arguments: JSON.stringify(toolCall.arguments),
    },
  }));
}

async function writeSse(
  response: ServerResponse,
  body: ChatCompletionRequestBody,
  wire: WireResponse,
  chunkSize: number,
  intervalMs: number,
  signal: AbortSignal,
): Promise<void> {
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const id = "chatcmpl-fixture";
  const send = (payload: unknown) =>
    response.write(`data: ${JSON.stringify(payload)}\n\n`);
  send({
    id,
    object: "chat.completion.chunk",
    created: 0,
    model: body.model ?? "mock-model",
    choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
  });
  for (let offset = 0; offset < wire.text.length; offset += chunkSize) {
    if (signal.aborted) return;
    send({
      id,
      object: "chat.completion.chunk",
      created: 0,
      model: body.model ?? "mock-model",
      choices: [
        {
          index: 0,
          delta: { content: wire.text.slice(offset, offset + chunkSize) },
          finish_reason: null,
        },
      ],
    });
    if (intervalMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  if (wire.toolCalls.length > 0 && !signal.aborted) {
    send({
      id,
      object: "chat.completion.chunk",
      created: 0,
      model: body.model ?? "mock-model",
      choices: [
        {
          index: 0,
          delta: { tool_calls: openAiToolCalls(wire, true) },
          finish_reason: null,
        },
      ],
    });
  }
  if (signal.aborted) return;
  const promptTokens = wire.usage?.promptTokens ?? estimatePromptTokens(body);
  const completionTokens = wire.usage?.completionTokens ?? 0;
  send({
    id,
    object: "chat.completion.chunk",
    created: 0,
    model: body.model ?? "mock-model",
    choices: [{ index: 0, delta: {}, finish_reason: wire.finishReason }],
    ...(body.stream_options?.include_usage
      ? {
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens,
          },
        }
      : {}),
  });
  response.end("data: [DONE]\n\n");
}

/** Start a loopback-only strict model server on an ephemeral port. */
export async function startMockLlm(
  options: MockLlmOptions = {},
): Promise<RunningMockLlm> {
  const fixtureSet = options.fixtures ?? legacyFixtures(options);
  const registry =
    options.fixtureRegistry ?? createDeterministicModelFixtureRegistry();
  if (!options.fixtureRegistry) {
    registry.beginAttempt(
      {
        scenarioId: options.scenarioId ?? "cloud-e2e",
        attemptId: options.attemptId ?? "attempt-1",
        ...(options.worldId ? { worldId: options.worldId } : {}),
      },
      fixtureSet,
    );
  }
  let requestCount = 0;
  const activeControllers = new Set<AbortController>();
  const activeSockets = new Set<Socket>();
  let stopPromise: Promise<void> | undefined;
  const server = createServer((request, response) => {
    const controller = new AbortController();
    activeControllers.add(controller);
    const releaseController = () => activeControllers.delete(controller);
    response.once("finish", releaseController);
    response.once("close", releaseController);
    request.once("aborted", () =>
      controller.abort(new Error("client cancelled request")),
    );
    response.once("close", () => {
      if (!response.writableEnded) {
        controller.abort(new Error("client closed response"));
      }
    });
    void (async () => {
      const url = request.url ?? "";
      if (request.method === "GET" && url.endsWith("/models")) {
        writeJson(response, 200, { object: "list", data: [] });
        return;
      }
      if (request.method !== "POST" || !url.endsWith("/chat/completions")) {
        writeJson(response, 404, {
          error: { message: "not found", type: "not_found" },
        });
        return;
      }
      const body = await readJsonBody(request);
      requestCount += 1;
      const modelType = options.modelTypeForRequest
        ? options.modelTypeForRequest(body.model ?? "")
        : ModelType.TEXT_LARGE;
      const resolution = registry.resolve(
        buildCall(body, modelType, controller.signal),
      );
      await applyDeterministicModelFixtureBehavior(
        resolution.behavior,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      const wire = normalizeWireResponse(
        resolution.rawResponse,
        options.completionTokens ?? 8,
      );
      const promptTokens =
        wire.usage?.promptTokens ?? estimatePromptTokens(body);
      const completionTokens =
        wire.usage?.completionTokens ?? options.completionTokens ?? 8;
      wire.usage = { promptTokens, completionTokens };
      if (body.stream) {
        await writeSse(
          response,
          body,
          wire,
          resolution.behavior?.stream?.chunkSize ?? 8,
          resolution.behavior?.stream?.intervalMs ?? 0,
          controller.signal,
        );
        return;
      }
      writeJson(response, 200, {
        id: "chatcmpl-fixture",
        object: "chat.completion",
        created: 0,
        model: body.model ?? "mock-model",
        system_fingerprint: `fixture-${createHash("sha256")
          .update(resolution.fixtureName)
          .digest("hex")
          .slice(0, 12)}`,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: wire.text || null,
              ...(wire.toolCalls.length > 0
                ? { tool_calls: openAiToolCalls(wire) }
                : {}),
            },
            finish_reason: wire.finishReason,
          },
        ],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
        },
      });
    })().catch((error: unknown) => {
      if (controller.signal.aborted || response.writableEnded) return;
      // error-policy:J1 Translate declared fixture/provider errors at HTTP.
      const record = isRecord(error) ? error : {};
      const status =
        typeof record.status === "number" && record.status >= 400
          ? record.status
          : error instanceof SyntaxError
            ? 400
            : 500;
      writeJson(response, status, {
        error: {
          message:
            error instanceof Error ? error.message : "mock model failure",
          type: typeof record.type === "string" ? record.type : "fixture_error",
          ...(typeof record.code === "string" ? { code: record.code } : {}),
        },
      });
    });
  });
  server.on("connection", (socket) => {
    activeSockets.add(socket);
    socket.once("close", () => activeSockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    port,
    requestCount: () => requestCount,
    diagnostics: () => registry.diagnostics(),
    assertFixturesConsumed: () => registry.assertConsumed(),
    stop: () => {
      if (stopPromise) return stopPromise;
      for (const controller of activeControllers) {
        controller.abort(new Error("mock model server stopping"));
      }
      for (const socket of activeSockets) socket.destroy();
      stopPromise = new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      return stopPromise;
    },
  };
}
