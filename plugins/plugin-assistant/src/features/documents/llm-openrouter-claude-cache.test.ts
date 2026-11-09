/**
 * Covers the OpenRouter + Claude branch of document contextualization, where
 * the full document is sent as a prompt-cache breakpoint. The requests go
 * through the real AI SDK and OpenRouter provider to a local OpenAI-compatible
 * HTTP server, so each assertion reads the wire request the provider would
 * send to OpenRouter.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  createTestRuntime,
  type TestRuntimeResult,
} from "@elizaos/testing/runtime";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { generateText } from "./llm.ts";

const CLAUDE_MODEL = "anthropic/claude-3.5-haiku";
const DOCUMENT_TEXT =
  "Refund requests are processed within five business days of approval.";
const SYSTEM_PROMPT = "You situate a chunk within its document.";
const PROMPT_TEXT =
  "<chunk>five business days</chunk>\nGive a short context for the chunk.";
const PROVIDER_CONTEXT = "context-from-openrouter";

interface WireTextPart {
  type: string;
  text: string;
  cache_control?: { type: string };
}

interface WireMessage {
  role: string;
  content: string | WireTextPart[];
}

interface OpenRouterStub {
  baseUrl: string;
  requests: () => Array<{ messages: WireMessage[] }>;
  close: () => Promise<void>;
}

async function startOpenRouterServer(): Promise<OpenRouterStub> {
  const bodies: Array<{ messages: WireMessage[] }> = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "gen-test",
          object: "chat.completion",
          created: 0,
          model: CLAUDE_MODEL,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: PROVIDER_CONTEXT },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/api/v1`,
    requests: () => bodies,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function texts(messages: WireMessage[]): string[] {
  return messages.flatMap((message) =>
    typeof message.content === "string"
      ? [message.content]
      : message.content.map((part) => part.text),
  );
}

function cachedParts(messages: WireMessage[]): WireTextPart[] {
  return messages.flatMap((message) =>
    Array.isArray(message.content)
      ? message.content.filter((part) => part.cache_control)
      : [],
  );
}

describe("OpenRouter Claude contextualization with a cached document", () => {
  let provider: OpenRouterStub;
  let fixture: TestRuntimeResult;

  beforeEach(async () => {
    provider = await startOpenRouterServer();
    fixture = await createTestRuntime({
      characterName: "OpenRouterClaudeCache",
      settings: {
        CTX_DOCUMENTS_ENABLED: "true",
        TEXT_PROVIDER: "openrouter",
        TEXT_MODEL: CLAUDE_MODEL,
        OPENROUTER_API_KEY: "test-openrouter-key",
        OPENROUTER_BASE_URL: provider.baseUrl,
        EMBEDDING_PROVIDER: "local",
      },
    });
  });

  afterEach(async () => {
    await fixture.cleanup();
    await provider.close();
  });

  test("a system prompt reaches OpenRouter with the document as the cache breakpoint", async () => {
    // The shape document-processor's generateContextsInBatch sends for every
    // chunk when TEXT_PROVIDER=openrouter and TEXT_MODEL is a Claude model.
    const result = await generateText(
      fixture.runtime,
      PROMPT_TEXT,
      SYSTEM_PROMPT,
      {
        cacheDocument: DOCUMENT_TEXT,
        cacheOptions: { type: "ephemeral" },
        autoCacheContextualRetrieval: true,
      },
    );

    expect(result.text).toBe(PROVIDER_CONTEXT);
    expect(provider.requests()).toHaveLength(1);
    const [request] = provider.requests();
    expect(
      texts(request.messages.filter((message) => message.role === "system")),
    ).toEqual([SYSTEM_PROMPT]);
    expect(cachedParts(request.messages)).toEqual([
      {
        type: "text",
        text: DOCUMENT_TEXT,
        cache_control: { type: "ephemeral" },
      },
    ]);
    expect(texts(request.messages)).toContain(PROMPT_TEXT);
  });

  test("without a system prompt the document still carries the cache breakpoint", async () => {
    const result = await generateText(fixture.runtime, PROMPT_TEXT, undefined, {
      cacheDocument: DOCUMENT_TEXT,
      cacheOptions: { type: "ephemeral" },
      autoCacheContextualRetrieval: true,
    });

    expect(result.text).toBe(PROVIDER_CONTEXT);
    const [request] = provider.requests();
    expect(cachedParts(request.messages)).toEqual([
      {
        type: "text",
        text: DOCUMENT_TEXT,
        cache_control: { type: "ephemeral" },
      },
    ]);
    expect(texts(request.messages)).toContain(PROMPT_TEXT);
  });
});
