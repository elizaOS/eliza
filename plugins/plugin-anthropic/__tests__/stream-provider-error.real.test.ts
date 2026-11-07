import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  AgentRuntime,
  type IAgentRuntime,
  isAuthError,
  isModelProviderFallbackError,
  isRateLimitError,
  ModelType,
  type TextStreamResult,
} from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { handleTextLarge } from "../models/text";

type Reply =
  | { kind: "http"; status: number; error: { type: string; message: string } }
  | { kind: "sse-error"; error: { type: string; message: string } };

let server: Server;
let baseUrl: string;
let reply: Reply;

const messageStart = {
  type: "message_start",
  message: {
    id: "msg_stream_error",
    type: "message",
    role: "assistant",
    content: [],
    model: "claude-opus-4-8",
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 12, output_tokens: 1 },
  },
};

beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (reply.kind === "http") {
        res.writeHead(reply.status, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: reply.error }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`event: message_start\ndata: ${JSON.stringify(messageStart)}\n\n`);
      res.end(`event: error\ndata: ${JSON.stringify({ type: "error", error: reply.error })}\n\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const settings = (): Record<string, string> => ({
  ANTHROPIC_API_KEY: "placeholder-not-a-key",
  ANTHROPIC_BASE_URL: baseUrl,
});

function runtime(): IAgentRuntime {
  const values = settings();
  return {
    character: { name: "Stream error test", bio: [] },
    getSetting: (key: string) => values[key],
    emitEvent: vi.fn(),
  } as unknown as IAgentRuntime;
}

async function streamedReplyError(): Promise<Error> {
  const result = (await handleTextLarge(runtime(), {
    prompt: "Say hi",
    stream: true,
  } as never)) as TextStreamResult;
  try {
    for await (const _chunk of result.textStream) {
      // drain
    }
  } catch (error) {
    return error as Error;
  }
  throw new Error("stream completed without the provider error");
}

describe("Anthropic streamed text provider errors", () => {
  it("keeps a 401 at stream start classifiable as an auth failure", async () => {
    reply = {
      kind: "http",
      status: 401,
      error: { type: "authentication_error", message: "invalid x-api-key" },
    };
    const error = await streamedReplyError();
    expect(error.message).toBe(
      "[Anthropic] TEXT_LARGE request using claude-opus-4-8 failed: Authentication failed. Check the configured Anthropic API key."
    );
    expect(isAuthError(error)).toBe(true);
  });

  it("keeps a 429 at stream start classifiable as a rate limit", async () => {
    reply = {
      kind: "http",
      status: 429,
      error: {
        type: "rate_limit_error",
        message: "Number of request tokens has exceeded your per-minute rate limit",
      },
    };
    const error = await streamedReplyError();
    expect(isRateLimitError(error)).toBe(true);
    expect(isModelProviderFallbackError(error, ModelType.TEXT_LARGE)).toBe(true);
  });

  it("keeps a mid-stream rate_limit_error event classifiable as a rate limit", async () => {
    reply = {
      kind: "sse-error",
      error: { type: "rate_limit_error", message: "Rate limited mid-stream" },
    };
    const error = await streamedReplyError();
    expect(error.message).toBe(
      "[Anthropic] TEXT_LARGE request using claude-opus-4-8 failed: Anthropic rate limited the request. Retry after a short delay."
    );
    expect(isRateLimitError(error)).toBe(true);
  });

  it("fails a mid-stream overloaded_error event over to the next provider", async () => {
    reply = {
      kind: "sse-error",
      error: { type: "overloaded_error", message: "Overloaded" },
    };
    const agent = new AgentRuntime({
      character: { name: "Failover test", bio: [] },
      logLevel: "fatal",
      settings: settings(),
    });
    agent.registerDatabaseAdapter({ createLogs: async () => undefined } as never);
    agent.registerModel(ModelType.TEXT_LARGE, handleTextLarge, "anthropic", 10);
    agent.registerModel(ModelType.TEXT_LARGE, async () => "backup reply", "backup", 0);
    const result = await agent.useModel(ModelType.TEXT_LARGE, {
      prompt: "Say hi",
      stream: true,
      onStreamChunk: () => undefined,
    } as never);
    expect(result).toBe("backup reply");
  });
});
