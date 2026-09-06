/**
 * Exercises benchmark request overrides and the real HTTP observation boundary.
 * Prevents misleading live evidence from losing prompt tails, leaking headers,
 * changing cancellation, or silently measuring synthetic embedding fallback.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import { describe, expect, it } from "vitest";
import {
  captureReplayAttempt,
  type ReplayAttempt,
  replayRequest,
  validateReplayStream,
} from "../scripts/cerebras-cache-wire-replay";
import {
  applyCacheExperiment,
  expectedConversationCacheKey,
  measuredProviderFetch,
  type ProviderWireEvidence,
  requireRealEmbeddingConfig,
  runChatCondition,
  verifyCacheExperimentWire,
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

  it("rejects HTTP-success SSE with truncated, filtered, errored or unfinished output", async () => {
    const server = createServer((request, response) => {
      const reason = request.url?.substring(1);
      response.writeHead(200, { "content-type": "text/event-stream" });
      const event =
        reason === "error"
          ? { error: { message: "provider failed" } }
          : {
              choices: [
                {
                  delta: { content: "response prefix" },
                  finish_reason: reason === "unfinished" ? "stop" : reason,
                },
              ],
              usage: { prompt_tokens: 12, completion_tokens: 2 },
            };
      response.write(`data: ${JSON.stringify(event)}\n\n`);
      response.end(reason === "unfinished" ? "" : "data: [DONE]\n\n");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing SSE server address");
    try {
      for (const reason of [
        "stop",
        "length",
        "content_filter",
        "error",
        "unfinished",
      ]) {
        const response = await fetch(
          `http://127.0.0.1:${address.port}/${reason}`,
        );
        expect(response.status).toBe(200);
        const raw = await response.text();
        if (reason === "stop")
          expect(validateReplayStream(raw).usage.prompt_tokens).toBe(12);
        else expect(() => validateReplayStream(raw)).toThrow();
      }
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    }
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
    const context = new AsyncLocalStorage<
      NonNullable<ProviderWireEvidence["context"]>
    >();
    const client = createOpenAI({
      apiKey: "local-test-only",
      baseURL: base,
      fetch: measuredProviderFetch(
        fetch,
        { text: base, embedding: base },
        () => context.getStore() ?? null,
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
      const expectedKey = expectedConversationCacheKey(scoped);
      const reply = await context.run(
        {
          phase: "sample",
          proof: "room-A",
          modelInvocationId: "invocation-A",
          expectedCacheKey: expectedKey,
        },
        () =>
          generateText({
            model: client.chat("test-model"),
            ...scoped,
          }),
      );
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
      const conversationWire = evidence[0];
      const automaticWire = evidence[1];
      if (!conversationWire || !automaticWire)
        throw new Error("Missing actual SDK wire observations");
      expect(
        verifyCacheExperimentWire([conversationWire], "conversation"),
      ).toBe(1);
      expect(verifyCacheExperimentWire([automaticWire], "automatic")).toBe(1);
      expect(() =>
        verifyCacheExperimentWire([conversationWire], "automatic"),
      ).toThrow("overwritten");
      expect(() =>
        verifyCacheExperimentWire([automaticWire], "conversation"),
      ).toThrow("expectation");
      const otherRoom = applyCacheExperiment(input, {
        ...experiment,
        conversationId: "room-B",
      });
      await context.run(
        {
          phase: "sample",
          proof: "room-A",
          modelInvocationId: "crossed-invocation",
          expectedCacheKey: expectedKey,
        },
        () => generateText({ model: client.chat("test-model"), ...otherRoom }),
      );
      const crossedWire = evidence.at(-1);
      if (!crossedWire) throw new Error("Missing crossed SDK request");
      expect(() =>
        verifyCacheExperimentWire([crossedWire], "conversation"),
      ).toThrow("mismatched");
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
    const sourceBody = {
      prompt_cache_key: "original-shared-affinity",
      tools: [
        {
          type: "function",
          function: {
            name: "complete_tool",
            parameters: {
              type: "object",
              properties: { requiredTail: { type: "string" } },
            },
          },
        },
      ],
      model: "test",
      messages: [
        { role: "user", content: `${"context ".repeat(30_000)}REQUIRED-TAIL` },
      ],
      stream: true,
    };
    const body = replayRequest(sourceBody, "automatic", "run", "room");
    expect(sourceBody.prompt_cache_key).toBe("original-shared-affinity");
    expect(body).not.toHaveProperty("prompt_cache_key");
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

it("retains every attempted replay including fetch rejection and interrupted response bytes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "replay-transport-"));
  const file = path.join(directory, "attempts.json");
  const rows: ReplayAttempt[] = [];
  const partial = Buffer.concat([
    Buffer.from("data: prefix "),
    Buffer.from([0xf0, 0x9f]),
  ]);
  const server = createServer((request, response) => {
    if (request.url === "/reject") {
      request.socket.destroy();
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (request.url === "/partial") {
      response.write(partial);
      setTimeout(() => response.destroy(), 40);
    } else response.end("complete response");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing loopback address");
  const persist = async () => {
    await writeFile(file, JSON.stringify(rows));
  };
  const request = {
    messages: [{ role: "user", content: "complete request 🐈" }],
    stream: true,
  };
  try {
    for (const [index, route] of ["success", "reject", "partial"].entries()) {
      const pending = captureReplayAttempt({
        endpoint: `http://127.0.0.1:${address.port}/${route}`,
        apiKey: "loopback-secret-do-not-record",
        rows,
        row: {
          index,
          order: 0,
          mode: "automatic",
          attempt: 1,
          originalContext: { roomId: "room" },
          request,
        },
        persist,
      });
      if (route === "success")
        await expect(pending).resolves.toMatchObject({
          status: 200,
          rawResponse: "complete response",
        });
      else await expect(pending).rejects.toThrow();
    }
    const saved = JSON.parse(await readFile(file, "utf8")) as ReplayAttempt[];
    expect(saved.map((row) => row.request)).toEqual([
      request,
      request,
      request,
    ]);
    expect(saved.map((row) => row.outcome)).toEqual([
      "response",
      "transport-error",
      "transport-error",
    ]);
    expect(saved[0]).toMatchObject({
      responseComplete: true,
      rawResponse: "complete response",
    });
    expect(saved[1]).toMatchObject({ responseComplete: false });
    expect(saved[1].status).toBeUndefined();
    expect(saved[1].error).toBeTruthy();
    expect(saved[2]).toMatchObject({ status: 200, responseComplete: false });
    expect(
      Buffer.from(saved[2].rawResponseBytesBase64 ?? "", "base64"),
    ).toEqual(partial);
    expect(saved[2].error).toBeTruthy();
    expect(await readFile(file, "utf8")).not.toContain(
      "loopback-secret-do-not-record",
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
    await rm(directory, { recursive: true, force: true });
  }
});
