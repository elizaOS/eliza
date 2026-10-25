import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  AgentRuntime,
  type IAgentRuntime,
  isInsufficientCreditsError,
  isModelProviderFallbackError,
  isRateLimitError,
  ModelType,
  type TextStreamResult,
} from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { handleResponseHandler } from "../src/models/text";

let server: Server;
let baseUrl: string;
let errorFrame: Record<string, unknown>;

beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify(errorFrame)}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function runtime(): IAgentRuntime {
  const settings: Record<string, string> = {
    ELIZAOS_CLOUD_API_KEY: "synthetic-test-key",
    ELIZAOS_CLOUD_BASE_URL: baseUrl,
    ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL: "gpt-oss-120b",
  };
  return {
    character: { name: "Stream error test", bio: [] },
    getSetting: (key: string) => settings[key],
    emitEvent: vi.fn(),
  } as unknown as IAgentRuntime;
}

async function streamedReplyError(): Promise<unknown> {
  const result = (await handleResponseHandler(runtime(), {
    prompt: "Say hi",
    messages: [{ role: "user", content: "Say hi" }],
    stream: true,
    streamStructured: true,
  } as never)) as TextStreamResult;
  try {
    for await (const _chunk of result.textStream) {
      // drain
    }
  } catch (error) {
    return error;
  }
  throw new Error("stream completed without the provider error");
}

describe("Eliza Cloud mid-stream provider error frame", () => {
  it("keeps the upstream 429 classifiable as a rate limit", async () => {
    errorFrame = {
      error: {
        message: "Upstream provider is busy",
        type: "rate_limit_error",
        code: 429,
      },
    };
    const error = await streamedReplyError();
    expect(isRateLimitError(error)).toBe(true);
    expect(isModelProviderFallbackError(error, ModelType.RESPONSE_HANDLER)).toBe(true);
    expect((error as { status?: unknown }).status).toBe(429);
    expect((error as Error).message).toBe("Upstream provider is busy");
  });

  it("keeps an upstream 503 eligible for provider failover", async () => {
    errorFrame = {
      error: {
        message: "The AI service is temporarily unavailable. Please try again later.",
        type: "service_unavailable",
        code: 503,
      },
    };
    const error = await streamedReplyError();
    expect(isModelProviderFallbackError(error, ModelType.RESPONSE_HANDLER)).toBe(true);
    expect((error as { status?: unknown }).status).toBe(503);
    expect(isInsufficientCreditsError(error)).toBe(false);
  });

  it("lets the runtime fail the reply over to the next provider", async () => {
    errorFrame = {
      error: {
        message: "The AI service is temporarily unavailable. Please try again later.",
        type: "service_unavailable",
        code: 503,
      },
    };
    const agent = new AgentRuntime({
      character: { name: "Failover test", bio: [] },
      logLevel: "fatal",
      settings: {
        ELIZAOS_CLOUD_API_KEY: "synthetic-test-key",
        ELIZAOS_CLOUD_BASE_URL: baseUrl,
        ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL: "gpt-oss-120b",
      },
    });
    agent.registerDatabaseAdapter({ createLogs: async () => undefined } as never);
    agent.registerModel(ModelType.RESPONSE_HANDLER, handleResponseHandler, "elizaOSCloud", 10);
    agent.registerModel(ModelType.RESPONSE_HANDLER, async () => "backup reply", "backup", 0);
    const reply = await agent.useModel(ModelType.RESPONSE_HANDLER, {
      prompt: "Say hi",
      messages: [{ role: "user", content: "Say hi" }],
      stream: true,
      streamStructured: true,
      onStreamChunk: () => undefined,
    } as never);
    expect(reply).toBe("backup reply");
  });
});
