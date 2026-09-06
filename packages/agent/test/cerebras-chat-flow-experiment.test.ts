/**
 * Exercises benchmark request overrides and the real HTTP observation boundary.
 * Prevents misleading live evidence from losing prompt tails, leaking headers,
 * changing cancellation, or silently measuring synthetic embedding fallback.
 */

import { once } from "node:events";
import { createServer } from "node:http";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import { describe, expect, it } from "vitest";
import {
  applyCacheExperiment,
  measuredProviderFetch,
  type ProviderWireEvidence,
  requireRealEmbeddingConfig,
  runChatCondition,
} from "../scripts/cerebras-chat-flow-experiment";

const experiment = {
  mode: "conversation" as const,
  keyCapabilityConfirmed: true,
  agentId: "agent-A",
  conversationId: "room-A",
  model: "model-A",
  stage: "RESPONSE_HANDLER",
};

function input() {
  return {
    messages: [
      { role: "user", content: "Full request with a required final clause." },
    ],
    tools: [{ name: "lookup", inputSchema: { type: "object" } }],
    providerOptions: {
      eliza: {
        prefixHash: "stable-prefix",
        conversationId: "local-room",
        thinking: "off",
      },
      openai: { promptCacheKey: "old-key", reasoningEffort: "low" },
      cerebras: { prompt_cache_key: "old-key", promptCacheKey: "old-key" },
      anthropic: { cacheControl: { type: "ephemeral" } },
    },
  };
}

describe("real chat cache experiment", () => {
  it("changes only optional cloud affinity while preserving complete model inputs and local pinning", () => {
    const request = input();
    const result = applyCacheExperiment(request, experiment);
    expect(result.messages).toBe(request.messages);
    expect(result.tools).toBe(request.tools);
    expect(result.providerOptions.eliza).toBe(request.providerOptions.eliza);
    expect(result.providerOptions.anthropic).toBe(
      request.providerOptions.anthropic,
    );
    expect(result.providerOptions.openai.reasoningEffort).toBe("low");
    expect(request.providerOptions.openai.promptCacheKey).toBe("old-key");
    const nextTurn = applyCacheExperiment(
      {
        ...request,
        messages: [...request.messages, { role: "user", content: "next turn" }],
      },
      experiment,
    );
    expect(nextTurn.providerOptions.openai.promptCacheKey).toBe(
      result.providerOptions.openai.promptCacheKey,
    );
    for (const patch of [
      { agentId: "agent-B" },
      { conversationId: "room-B" },
      { model: "model-B" },
      { stage: "ACTION_PLANNER" },
    ]) {
      expect(
        applyCacheExperiment(request, { ...experiment, ...patch })
          .providerOptions.openai.promptCacheKey,
      ).not.toBe(result.providerOptions.openai.promptCacheKey);
    }
    const changedPrefix = input();
    changedPrefix.providerOptions.eliza.prefixHash = "changed-prefix";
    expect(
      applyCacheExperiment(changedPrefix, experiment).providerOptions.openai
        .promptCacheKey,
    ).not.toBe(result.providerOptions.openai.promptCacheKey);
  });

  it("omits both wire spellings for an account without routing-key capability", () => {
    const result = applyCacheExperiment(input(), {
      ...experiment,
      mode: "automatic",
      keyCapabilityConfirmed: false,
    });
    expect(result.providerOptions.openai).toEqual({ reasoningEffort: "low" });
    expect(result.providerOptions.cerebras).toEqual({});
    expect(() =>
      applyCacheExperiment(input(), {
        ...experiment,
        keyCapabilityConfirmed: false,
      }),
    ).toThrow("capability");
    expect(() =>
      applyCacheExperiment({ messages: [], providerOptions: {} }, experiment),
    ).toThrow("stable-prefix");
  });

  it("resumes each post-idle sample's own primed history after the shared wait", async () => {
    const histories = new Map<string, string[]>();
    let waited = false;
    let nextRoom = 0;
    const results = await runChatCondition({
      condition: "post-idle",
      samples: 3,
      idleMs: 360_000,
      initialRoom: "unused",
      prepareRoom: async () => {
        const room = `room-${nextRoom++}`;
        histories.set(room, []);
        return room;
      },
      runTurn: async (index, prime, room) => {
        const history = histories.get(room);
        if (!history) throw new Error("Unprepared room");
        if (prime) {
          expect(waited).toBe(false);
          history.push(`remember-${index}`);
        } else {
          expect(waited).toBe(true);
          expect(history).toEqual([`remember-${index}`]);
          history.push(`resume-${index}`);
        }
        return [...history];
      },
      wait: async () => {
        waited = true;
      },
    });
    expect(results.map((result) => result.value)).toEqual([
      ["remember-0", "resume-0"],
      ["remember-1", "resume-1"],
      ["remember-2", "resume-2"],
    ]);
  });

  it("rejects a synthetic or unidentified embedding run before dispatch", () => {
    expect(() =>
      requireRealEmbeddingConfig({ CEREBRAS_API_KEY: "not-a-real-key" }),
    ).toThrow("synthetic");
    expect(() =>
      requireRealEmbeddingConfig({
        OPENAI_EMBEDDING_URL: "https://user:secret@example.test/v1",
        OPENAI_EMBEDDING_MODEL: "embed",
        OPENAI_EMBEDDING_DIMENSIONS: "384",
      }),
    ).toThrow("credentials");
    expect(
      requireRealEmbeddingConfig({
        OPENAI_EMBEDDING_URL: "http://127.0.0.1:1234/v1",
        OPENAI_EMBEDDING_MODEL: "embed",
        OPENAI_EMBEDDING_DIMENSIONS: "384",
      }),
    ).toEqual({
      endpoint: "http://127.0.0.1:1234/v1",
      model: "embed",
      dimensions: 384,
    });
  });

  it("sends the selected affinity through the actual OpenAI SDK serializer", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push(JSON.parse(Buffer.concat(chunks).toString()));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: "test-completion",
          object: "chat.completion",
          created: 1,
          model: "test-model",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "complete reply" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        }),
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing server address");
    const base = `http://127.0.0.1:${address.port}/v1`;
    const evidence: ProviderWireEvidence[] = [];
    const client = createOpenAI({
      apiKey: "local-test-only",
      baseURL: base,
      fetch: measuredProviderFetch(
        fetch,
        { text: base, embedding: base },
        () => null,
        (item) => evidence.push(item),
      ),
    });
    const input = {
      prompt: "Keep complete context and REQUIRED-TAIL",
      providerOptions: {
        eliza: { prefixHash: "stable-prefix" },
        openai: { promptCacheKey: "overwritten-plan-key" },
      },
    };
    try {
      const scoped = applyCacheExperiment(input, experiment);
      const reply = await generateText({
        model: client.chat("test-model"),
        ...scoped,
      });
      expect(reply.text).toBe("complete reply");
      expect(requests[0]?.prompt_cache_key).toBe(
        scoped.providerOptions.openai.promptCacheKey,
      );
      expect(requests[0]?.prompt_cache_key).not.toBe("overwritten-plan-key");
      expect(requests[0]?.messages).toEqual([
        { role: "user", content: input.prompt },
      ]);
      const automatic = applyCacheExperiment(input, {
        ...experiment,
        mode: "automatic",
        keyCapabilityConfirmed: false,
      });
      await generateText({ model: client.chat("test-model"), ...automatic });
      expect(requests[1]).not.toHaveProperty("prompt_cache_key");
      expect(evidence.map((item) => item.request)).toEqual(requests);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    }
  });

  it("observes complete actual HTTP input without logging authorization or consuming streamed output", async () => {
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${Buffer.concat(chunks).toString()}\n\n`);
      response.end("data: [DONE]\n\n");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing test server address");
    const base = `http://127.0.0.1:${address.port}/v1`;
    const evidence: ProviderWireEvidence[] = [];
    const body = {
      model: "test",
      messages: [
        { role: "user", content: `${"context ".repeat(30_000)}REQUIRED-TAIL` },
      ],
      stream: true,
    };
    const measured = measuredProviderFetch(
      fetch,
      { text: base, embedding: base },
      () => ({ phase: "sample", proof: "proof-A" }),
      (item) => evidence.push(item),
    );
    try {
      const response = await measured(`${base}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: "Bearer never-capture-this",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      expect(await response.text()).toBe(
        `data: ${JSON.stringify(body)}\n\ndata: [DONE]\n\n`,
      );
      expect(evidence[0]?.request).toEqual(body);
      expect(JSON.stringify(evidence)).not.toContain("never-capture-this");
      const abort = new AbortController();
      const reason = new Error("caller cancelled");
      abort.abort(reason);
      await expect(
        measured(`${base}/chat/completions`, {
          method: "POST",
          body: JSON.stringify(body),
          signal: abort.signal,
        }),
      ).rejects.toBe(reason);
      expect(evidence.at(-1)?.outcome).toBe("error");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    }
  });
});
