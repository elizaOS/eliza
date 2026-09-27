/** Exercises private Qwen continuation through the real SDK against a loopback server. */
import { createServer, type Server } from "node:http";
import type { GenerateTextResult, IAgentRuntime } from "@elizaos/core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handleActionPlanner } from "../models/text";
import {
  applyCerebrasReasoningReplay,
  cerebrasReasoningContent,
} from "../utils/cerebras-reasoning";

let server: Server;
let baseURL: string;
const requests: Array<Record<string, unknown>> = [];
const privateReasoning =
  "Private continuation α\nPlan the next tool, preserving the earlier observation.";
beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requests.push(body);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: `completion-${requests.length}`,
          object: "chat.completion",
          created: 0,
          model: body.model,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "Visible answer",
                reasoning: privateReasoning,
              },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 20,
            total_tokens: 30,
            completion_tokens_details: { reasoning_tokens: 18 },
          },
        })
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  baseURL = `http://127.0.0.1:${address.port}/v1`;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
});
beforeEach(() => {
  requests.length = 0;
  vi.stubEnv("ELIZA_PROVIDER", "cerebras");
  vi.stubEnv("OPENAI_BASE_URL", baseURL);
  vi.stubEnv("OPENAI_API_KEY", "fixture-key");
  vi.stubEnv("CEREBRAS_API_KEY", undefined);
  vi.stubEnv("ELIZA_MOCK_OPENAI_BASE", undefined);
});
afterEach(() => vi.unstubAllEnvs());
function runtime(): IAgentRuntime {
  return {
    getSetting: () => undefined,
    character: { name: "Test", system: "Keep private reasoning private." },
    emitEvent: vi.fn(),
    getService: () => null,
    getServicesByType: () => [],
  } as unknown as IAgentRuntime;
}

describe("Qwen private reasoning continuation", () => {
  it("retains real SDK raw response reasoning and replays it separately from visible content", async () => {
    const host = runtime();
    const first = (await handleActionPlanner(host, {
      model: "qwen-3.8-27b",
      messages: [{ role: "user", content: "Inspect the task." }],
    })) as unknown as GenerateTextResult;
    expect(first.text).toBe("Visible answer");
    const reasoning = first.content?.filter((part) => part.type === "reasoning");
    expect(reasoning).toEqual(
      cerebrasReasoningContent(
        { choices: [{ message: { reasoning: privateReasoning } }] },
        "qwen-3.8-27b"
      )
    );
    await handleActionPlanner(host, {
      model: "qwen-3.8-27b",
      messages: [
        { role: "user", content: "Inspect the task." },
        { role: "assistant", content: reasoning },
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "read-1",
              toolName: "READ",
              input: { file_path: "/app/a.ts" },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "read-1",
              toolName: "READ",
              output: { type: "text", value: "Complete source" },
            },
          ],
        },
        { role: "user", content: "Continue." },
      ],
    });
    const messages = requests[1]?.messages as Array<Record<string, unknown>>;
    const assistants = messages.filter((message) => message.role === "assistant");
    expect(assistants[0]).toMatchObject({ content: null, reasoning: privateReasoning });
    expect(assistants[1]).not.toHaveProperty("reasoning");
    expect(assistants[1]?.tool_calls).toEqual([
      {
        id: "read-1",
        type: "function",
        function: { name: "READ", arguments: '{"file_path":"/app/a.ts"}' },
      },
    ]);
  });

  it("does not forward Qwen reasoning to a different model", async () => {
    await handleActionPlanner(runtime(), {
      model: "unrelated-model",
      messages: [
        {
          role: "assistant",
          content: cerebrasReasoningContent(
            { choices: [{ message: { reasoning: privateReasoning } }] },
            "qwen-3.8-27b"
          ),
        },
        { role: "user", content: "Continue." },
      ],
    });
    expect(JSON.stringify(requests[0])).not.toContain(privateReasoning);
  });

  it("rejects serialization drift instead of attaching reasoning to another assistant", () => {
    expect(() =>
      applyCerebrasReasoningReplay(
        { model: "qwen-3.8-27b", messages: [{ role: "assistant", content: "Different response" }] },
        {
          model: "qwen-3.8-27b",
          assistants: [{ text: "Original response", toolCallIds: [], reasoning: privateReasoning }],
        }
      )
    ).toThrow("identity changed");
  });
});
