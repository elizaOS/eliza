/** Exercises the strict model wire adapter through real loopback HTTP requests. */

import { afterEach, describe, expect, it } from "bun:test";
import { createOpenAI } from "@ai-sdk/openai";
import { type IAgentRuntime, ModelType } from "@elizaos/core";
import {
  createDeterministicModelFixtureRegistry,
  createDeterministicModelPlugin,
} from "@elizaos/core/testing";
import { generateText, streamText, tool } from "ai";
import { z } from "zod";
import type { RunningMockLlm } from "./mock-llm";
import { startMockLlm } from "./mock-llm";

const running: RunningMockLlm[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.stop()));
});

async function start(options: Parameters<typeof startMockLlm>[0]) {
  const server = await startMockLlm(options);
  running.push(server);
  return server;
}

describe("strict Cloud model wire adapter", () => {
  it("drives the production OpenAI SDK through text, tool, usage, streaming, error, and cancellation wires", async () => {
    const server = await start({
      fixtures: [
        {
          name: "sdk-text",
          match: { input: "sdk text" },
          response: {
            text: "sdk answer",
            usage: { promptTokens: 2, completionTokens: 3 },
          },
        },
        {
          name: "sdk-tool",
          match: { input: "sdk tool", toolNames: ["CREATE_TASK"] },
          response: {
            finishReason: "tool_calls",
            toolCalls: [
              {
                id: "sdk-call-1",
                name: "CREATE_TASK",
                arguments: { title: "Synthetic task" },
              },
            ],
          },
        },
        {
          name: "sdk-stream",
          match: { input: "sdk stream" },
          response: "streamed answer",
          behavior: { stream: { chunkSize: 4, intervalMs: 0 } },
        },
        {
          name: "sdk-error",
          match: { input: "sdk error" },
          behavior: {
            error: { message: "throttled", status: 429, code: "rate_limit" },
          },
        },
        {
          name: "sdk-cancel",
          match: { input: "sdk cancel" },
          behavior: { waitForAbort: true },
        },
      ],
    });
    const openai = createOpenAI({
      apiKey: "sk-synthetic-example",
      baseURL: server.url,
    });
    const model = openai.chat("gpt-fixture");
    const text = await generateText({ model, prompt: "sdk text" });
    expect(text.text).toBe("sdk answer");
    expect(text.usage).toMatchObject({ inputTokens: 2, outputTokens: 3 });

    const tools = await generateText({
      model,
      prompt: "sdk tool",
      tools: {
        CREATE_TASK: tool({
          inputSchema: z.object({ title: z.string() }),
        }),
      },
    });
    expect(tools.toolCalls[0]).toMatchObject({
      toolName: "CREATE_TASK",
      input: { title: "Synthetic task" },
    });

    const streamed = streamText({ model, prompt: "sdk stream" });
    let streamedText = "";
    for await (const chunk of streamed.textStream) streamedText += chunk;
    expect(streamedText).toBe("streamed answer");

    await expect(
      generateText({ model, prompt: "sdk error", maxRetries: 0 }),
    ).rejects.toThrow("throttled");
    const controller = new AbortController();
    const pending = generateText({
      model,
      prompt: "sdk cancel",
      abortSignal: controller.signal,
    });
    for (let index = 0; index < 100; index += 1) {
      const consumed = server
        .diagnostics()
        .fixtures.find((fixture) => fixture.name === "sdk-cancel")?.consumed;
      if (consumed === 1) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
    }
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(() => server.assertFixturesConsumed()).not.toThrow();
  }, 30_000);

  it("serves declared text and usage with sanitized registry diagnostics", async () => {
    const server = await start({
      scenarioId: "wire.text",
      attemptId: "attempt-2",
      fixtures: [
        {
          name: "answer",
          match: { modelType: ModelType.TEXT_LARGE, input: "private prompt" },
          response: {
            text: "declared answer",
            usage: { promptTokens: 0, completionTokens: 4 },
          },
          times: 1,
        },
      ],
    });
    const response = await fetch(`${server.url}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-fixture",
        messages: [{ role: "user", content: "private prompt" }],
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
      usage: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
      };
    };
    expect(body.choices[0].message.content).toBe("declared answer");
    expect(body.usage).toEqual({
      prompt_tokens: 0,
      completion_tokens: 4,
      total_tokens: 4,
    });
    expect(server.diagnostics().scope).toEqual({
      scenarioId: "wire.text",
      attemptId: "attempt-2",
    });
    expect(JSON.stringify(server.diagnostics())).not.toContain(
      "private prompt",
    );
    expect(() => server.assertFixturesConsumed()).not.toThrow();
  });

  it("isolates fixture consumption across parallel worker servers", async () => {
    const fixture = {
      name: "once-per-worker",
      response: "ok",
      times: 1 as const,
    };
    const [first, second] = await Promise.all([
      start({
        scenarioId: "parallel",
        attemptId: "worker-1",
        fixtures: [fixture],
      }),
      start({
        scenarioId: "parallel",
        attemptId: "worker-2",
        fixtures: [fixture],
      }),
    ]);
    await Promise.all(
      [first, second].map((server) =>
        fetch(`${server.url}/chat/completions`, {
          method: "POST",
          body: JSON.stringify({ messages: [{ role: "user", content: "go" }] }),
        }),
      ),
    );
    expect(first.diagnostics().fixtures[0]?.consumed).toBe(1);
    expect(second.diagnostics().fixtures[0]?.consumed).toBe(1);
    expect(first.diagnostics().scope?.attemptId).toBe("worker-1");
    expect(second.diagnostics().scope?.attemptId).toBe("worker-2");
  });

  it("serves the identical registry through in-process and wire dispatch", async () => {
    const registry = createDeterministicModelFixtureRegistry();
    registry.beginAttempt({ scenarioId: "shared", attemptId: "attempt-1" }, [
      {
        name: "shared-answer",
        response: "same answer",
        times: 2,
      },
    ]);
    const plugin = createDeterministicModelPlugin({
      fixtureRegistry: registry,
    });
    await expect(
      plugin.models?.[ModelType.TEXT_LARGE]?.({} as IAgentRuntime, {
        prompt: "in process",
      }),
    ).resolves.toBe("same answer");
    const server = await start({ fixtureRegistry: registry });
    const response = await fetch(`${server.url}/chat/completions`, {
      method: "POST",
      body: JSON.stringify({
        messages: [{ role: "user", content: "over wire" }],
      }),
    });
    const body = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    expect(body.choices[0]?.message.content).toBe("same answer");
    expect(registry.diagnostics().fixtures[0]?.consumed).toBe(2);
    expect(() => registry.assertConsumed()).not.toThrow();
  });

  it("serves tool calls and SSE chunks from fixture behavior", async () => {
    const server = await start({
      fixtures: [
        {
          name: "tool-stream",
          response: {
            text: "working",
            finishReason: "tool_calls",
            toolCalls: [
              { id: "call-1", name: "CREATE_TASK", arguments: { title: "A" } },
            ],
          },
          behavior: { stream: { chunkSize: 3, intervalMs: 0 } },
          times: 1,
        },
      ],
    });
    const response = await fetch(`${server.url}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-fixture",
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: "user", content: "make task" }],
        tools: [
          {
            type: "function",
            function: { name: "CREATE_TASK", parameters: { type: "object" } },
          },
        ],
      }),
    });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const stream = await response.text();
    expect(stream).toContain('"content":"wor"');
    expect(stream).toContain('"name":"CREATE_TASK"');
    expect(stream).toContain('"tool_calls":[{"index":0');
    expect(stream).toContain('"finish_reason":"tool_calls"');
    expect(stream).toContain("data: [DONE]");
  });

  it("translates declared provider errors and honors client cancellation", async () => {
    const failed = await start({
      fixtures: [
        {
          name: "rate-limit",
          behavior: {
            error: {
              message: "fixture throttled",
              code: "rate_limit_exceeded",
              status: 429,
              type: "rate_limit_error",
            },
          },
          times: 1,
        },
      ],
    });
    const errorResponse = await fetch(`${failed.url}/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "fail" }] }),
    });
    expect(errorResponse.status).toBe(429);
    expect(await errorResponse.json()).toEqual({
      error: {
        message: "fixture throttled",
        type: "rate_limit_error",
        code: "rate_limit_exceeded",
      },
    });

    const waiting = await start({
      fixtures: [
        {
          name: "wait",
          behavior: { waitForAbort: true },
          times: 1,
        },
      ],
    });
    const controller = new AbortController();
    const pending = fetch(`${waiting.url}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      body: JSON.stringify({ messages: [{ role: "user", content: "wait" }] }),
    });
    controller.abort();
    await expect(pending).rejects.toThrow();

    const teardown = await start({
      fixtures: [
        {
          name: "teardown-wait",
          behavior: { waitForAbort: true },
          times: 1,
        },
      ],
    });
    const unboundedRequest = fetch(`${teardown.url}/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "wait" }] }),
    });
    for (let index = 0; index < 100; index += 1) {
      if (teardown.diagnostics().calls.length > 0) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
    }
    expect(teardown.diagnostics().calls).toHaveLength(1);
    const stopped = await Promise.race([
      teardown.stop().then(() => "stopped" as const),
      new Promise<"timed-out">((resolve) =>
        setTimeout(() => resolve("timed-out"), 500),
      ),
    ]);
    expect(stopped).toBe("stopped");
    await expect(unboundedRequest).rejects.toThrow();
  });
});
