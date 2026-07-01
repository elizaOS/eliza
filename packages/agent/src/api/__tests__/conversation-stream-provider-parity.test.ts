/**
 * Functional streaming parity for #10712.
 *
 * Drives the real conversation stream route while keeping generation
 * deterministic with a mock `runtime.useModel`. The same model fixture is used
 * for a local-inference profile and a cloud-resolved profile, proving both
 * provider paths emit ordered token SSE frames followed by a terminal `thought`
 * on the canonical `/api/conversations/:id/messages/stream` transport.
 */

import { EventEmitter } from "node:events";
import http from "node:http";
import {
  type AgentRuntime,
  ChannelType,
  logger,
  ModelType,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../chat-routes.ts", async () => {
  const actual =
    await vi.importActual<typeof import("../chat-routes.ts")>(
      "../chat-routes.ts",
    );
  return {
    ...actual,
    readChatRequestPayload: vi.fn(async () => ({
      prompt: "stream the deterministic thought",
      channelType: ChannelType.DM,
      images: undefined,
      preferredLanguage: undefined,
      source: "api",
      metadata: undefined,
    })),
    persistConversationMemory: vi.fn(async () => undefined),
    persistAssistantConversationMemory: vi.fn(async () => undefined),
    hasRecentVisibleAssistantMemorySince: vi.fn(async () => false),
    resolveNoResponseFallback: () => "",
  };
});

vi.mock("../server-helpers.ts", async () => {
  const actual = await vi.importActual<typeof import("../server-helpers.ts")>(
    "../server-helpers.ts",
  );
  return {
    ...actual,
    buildUserMessages: vi.fn(({ prompt, userId, agentId, roomId }) => ({
      userMessage: {
        id: stringToUuid("provider-parity-user-msg"),
        entityId: userId,
        agentId,
        roomId,
        content: { text: prompt, source: "api", channelType: ChannelType.DM },
      },
      messageToStore: {
        id: stringToUuid("provider-parity-user-msg-store"),
        entityId: userId,
        agentId,
        roomId,
        content: { text: prompt, source: "api", channelType: ChannelType.DM },
      },
    })),
    resolveWalletModeGuidanceReply: () => null,
    resolveAppUserName: () => "tester",
  };
});

import type {
  ConversationRouteContext,
  ConversationRouteState,
} from "../conversation-routes.ts";
import { handleConversationRoutes } from "../conversation-routes.ts";

const AGENT_ID = stringToUuid("provider-parity-agent") as UUID;
const USER_ID = stringToUuid("provider-parity-user") as UUID;
const ROOM_ID = stringToUuid("provider-parity-room") as UUID;
const TOKENS = ["Local ", "and ", "cloud ", "stream."];
const FINAL_TEXT = TOKENS.join("");
const THOUGHT =
  "Use the same deterministic token plan, then expose the compact reasoning.";

type ProviderPath = "local-inference" | "cloud-resolved";

interface StreamingModelParams {
  prompt?: string;
  stream?: boolean;
  signal?: AbortSignal;
  onStreamChunk?: (chunk: string) => Promise<void> | void;
  providerOptions?: {
    eliza?: {
      providerPath?: ProviderPath;
    };
  };
}

interface StreamingModelResult {
  text: string;
  thought: string;
  providerPath: ProviderPath;
}

interface MockResponseRecord {
  headers: Record<string, string>;
  writes: string[];
  ended: boolean;
}

type MockSocket = EventEmitter & {
  destroyed: boolean;
  writable: boolean;
};

function createMockSocket(): MockSocket {
  return Object.assign(new EventEmitter(), {
    destroyed: false,
    writable: true,
  });
}

function createReq(socket: MockSocket): http.IncomingMessage {
  const req = Object.assign(new http.IncomingMessage(null as never), {
    method: "POST",
    url: "/api/conversations/conv-1/messages/stream",
    headers: {},
  });
  Object.defineProperty(req, "socket", {
    configurable: true,
    value: socket,
  });
  return req as http.IncomingMessage;
}

function createMockRes(): {
  res: http.ServerResponse;
  record: MockResponseRecord;
} {
  const record: MockResponseRecord = {
    headers: {},
    writes: [],
    ended: false,
  };
  let writableEnded = false;
  const responseFixture = {
    writeHead: vi.fn((status: number, headers?: Record<string, string>) => {
      record.headers.status = String(status);
      Object.assign(record.headers, headers);
      return responseFixture;
    }),
    setHeader: vi.fn((name: string, value: string) => {
      record.headers[name] = value;
    }),
    write: vi.fn((chunk: string | Buffer) => {
      record.writes.push(
        typeof chunk === "string" ? chunk : chunk.toString("utf-8"),
      );
      return true;
    }),
    end: vi.fn(() => {
      record.ended = true;
      writableEnded = true;
    }),
    destroyed: false,
    get writableEnded() {
      return writableEnded;
    },
  } as unknown as http.ServerResponse;
  return { res: responseFixture, record };
}

function parseSsePayloads(writes: string[]): Array<Record<string, unknown>> {
  return writes
    .join("")
    .split("\n\n")
    .map((frame) => frame.trim())
    .filter((frame) => frame.startsWith("data: "))
    .map((frame) => JSON.parse(frame.replace(/^data: /, "")));
}

function createStreamingUseModelFixture(providerPath: ProviderPath) {
  return vi.fn(
    async (
      _modelType: string,
      params: StreamingModelParams,
    ): Promise<StreamingModelResult> => {
      expect(params.stream).toBe(true);
      expect(params.prompt).toContain("stream the deterministic thought");
      expect(params.providerOptions?.eliza?.providerPath).toBe(providerPath);
      for (const token of TOKENS) {
        await Promise.resolve();
        await params.onStreamChunk?.(token);
      }
      return {
        text: FINAL_TEXT,
        thought: THOUGHT,
        providerPath,
      };
    },
  );
}

function createModelBackedMessageService(providerPath: ProviderPath) {
  return {
    async handleMessage(
      runtime: AgentRuntime,
      message: { content?: { text?: unknown } },
      _callback: unknown,
      options?: {
        abortSignal?: AbortSignal;
        onStreamChunk?: (chunk: string) => Promise<void> | void;
      },
    ) {
      const useStreamingModel = runtime.useModel as unknown as (
        modelType: typeof ModelType.TEXT_LARGE,
        params: StreamingModelParams,
      ) => Promise<StreamingModelResult>;
      const modelResult = await useStreamingModel(ModelType.TEXT_LARGE, {
        prompt: String(message.content?.text ?? ""),
        stream: true,
        signal: options?.abortSignal,
        providerOptions: { eliza: { providerPath } },
        onStreamChunk: options?.onStreamChunk,
      });
      return {
        didRespond: true,
        responseContent: {
          text: modelResult.text,
          thought: modelResult.thought,
          metadata: { providerPath: modelResult.providerPath },
        },
        responseMessages: [],
      };
    },
    shouldRespond: () => ({
      shouldRespond: true,
      skipEvaluation: true,
      reason: `${providerPath}-streaming-test`,
    }),
    deleteMessage: async () => undefined,
    clearChannel: async () => undefined,
  } satisfies NonNullable<AgentRuntime["messageService"]>;
}

function createState(providerPath: ProviderPath): {
  state: ConversationRouteState;
  useModel: ReturnType<typeof createStreamingUseModelFixture>;
} {
  const conv = {
    id: "conv-1",
    title: `${providerPath} test conv`,
    roomId: ROOM_ID,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const useModel = createStreamingUseModelFixture(providerPath);
  const runtime = {
    agentId: AGENT_ID,
    character: {
      name: "Streaming Agent",
      system: "System prompt",
      settings: {
        model:
          providerPath === "local-inference"
            ? "local-inference/eliza-1"
            : "cloud/gpt-5-mini",
      },
    },
    actions: [],
    plugins:
      providerPath === "local-inference"
        ? [{ name: "@elizaos/plugin-local-inference" }]
        : [{ name: "@elizaos/plugin-openai" }],
    logger,
    emitEvent: vi.fn(async () => undefined),
    useModel: useModel as unknown as AgentRuntime["useModel"],
    messageService: createModelBackedMessageService(providerPath),
    ensureConnection: vi.fn(async () => undefined),
    updateWorld: vi.fn(async () => undefined),
    getWorld: vi.fn(async () => null),
    getRoom: vi.fn(async () => null),
    getService: vi.fn(() => null),
    getServicesByType: vi.fn(() => []),
    getSetting: vi.fn((key: string) => {
      const values: Record<string, string> =
        providerPath === "local-inference"
          ? {
              ELIZA_LOCAL_LLAMA: "1",
              ELIZA_MODEL_PROVIDER: "local-inference",
            }
          : {
              ELIZA_MODEL_PROVIDER: "openai",
              OPENAI_API_KEY: "test-cloud-key",
            };
      return values[key] ?? null;
    }),
    adapter: {},
  } as unknown as AgentRuntime;

  return {
    useModel,
    state: {
      runtime,
      config: { user: { name: "tester" } } as never,
      agentName: "Streaming Agent",
      adminEntityId: USER_ID,
      chatUserId: USER_ID,
      logBuffer: [],
      conversations: new Map([[conv.id, conv]]),
      activeChatTurnCount: 0,
      conversationRestorePromise: null,
      deletedConversationIds: new Set(),
      broadcastWs: null,
    } as ConversationRouteState,
  };
}

function createCtx(providerPath: ProviderPath): {
  ctx: ConversationRouteContext;
  record: MockResponseRecord;
  useModel: ReturnType<typeof createStreamingUseModelFixture>;
} {
  const socket = createMockSocket();
  const req = createReq(socket);
  const { res, record } = createMockRes();
  const { state, useModel } = createState(providerPath);
  const ctx: ConversationRouteContext = {
    req,
    res,
    method: "POST",
    pathname: "/api/conversations/conv-1/messages/stream",
    state,
    readJsonBody: vi.fn(async () => ({ prompt: "unused" })),
    json: vi.fn(),
    error: vi.fn((response, message, status) => {
      response.write(`error ${status}: ${message}`);
      response.end();
    }),
  } as unknown as ConversationRouteContext;
  return { ctx, record, useModel };
}

describe("conversation stream provider parity (#10712)", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ["local-inference" as const],
    ["cloud-resolved" as const],
  ])("streams ordered token frames and a terminal thought on the %s provider path", async (providerPath) => {
    const { ctx, record, useModel } = createCtx(providerPath);

    await handleConversationRoutes(ctx);

    expect(record.headers["Content-Type"]).toBe("text/event-stream");
    expect(record.ended).toBe(true);
    expect(useModel).toHaveBeenCalledTimes(1);

    const payloads = parseSsePayloads(record.writes);
    const tokens = payloads.filter((payload) => payload.type === "token");
    expect(tokens.map((payload) => payload.text)).toEqual(TOKENS);
    expect(tokens.map((payload) => payload.fullText)).toEqual([
      "Local ",
      "Local and ",
      "Local and cloud ",
      FINAL_TEXT,
    ]);

    const done = payloads.find((payload) => payload.type === "done");
    expect(done).toMatchObject({
      type: "done",
      fullText: FINAL_TEXT,
      agentName: "Streaming Agent",
      thought: THOUGHT,
    });

    const statusKinds = payloads
      .filter((payload) => payload.type === "status")
      .map((payload) => payload.kind);
    expect(statusKinds).toEqual(["thinking", "streaming"]);
  });
});
