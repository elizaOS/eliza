/** Real SDK + loopback wire fixture: transport strings never reach canonical callers. */
import { createServer } from "node:http";
import type { IAgentRuntime } from "@elizaos/core";
import { jsonSchema } from "ai";
import { afterEach, expect, it, vi } from "vitest";
import { handleActionPlanner } from "../models/text";
import type { TextStreamResult } from "../types";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
it.each([
  { stream: false, structured: false, malformed: false, buffered: false, noOptIn: true },
  { stream: true, structured: true, malformed: false, buffered: false, noOptIn: true },
  {
    stream: false,
    structured: false,
    malformed: false,
    buffered: false,
    hookFailure: true,
    hookOnly: true,
  },
  {
    stream: true,
    structured: true,
    malformed: false,
    buffered: false,
    hookFailure: true,
    hookOnly: true,
  },
  ...[false, true].flatMap((stream) =>
    [false, true].map((structured) => ({
      stream,
      structured,
      malformed: false,
      buffered: false,
      hookFailure: true,
    }))
  ),
  { stream: false, structured: false, malformed: false, buffered: false },
  { stream: true, structured: false, malformed: false, buffered: false },
  { stream: true, structured: false, malformed: false, buffered: true },
  { stream: true, structured: true, malformed: false, buffered: false },
  { stream: true, structured: true, malformed: true, buffered: false },
  { stream: true, structured: true, malformed: false, buffered: false, callCount: 0 },
  { stream: true, structured: true, malformed: false, buffered: false, callCount: 2 },
])(
  "preserves canonical native content $stream/$structured/$malformed/$buffered",
  async ({
    stream,
    structured,
    malformed,
    buffered,
    callCount = 1,
    hookFailure = false,
    hookOnly = false,
    noOptIn = false,
  }) => {
    const expected = ' "quoted 雪" \r\n';
    const rawArguments = JSON.stringify(
      noOptIn
        ? { content: expected }
        : malformed
          ? { arguments: "not-an-object" }
          : { arguments: { content: expected } }
    );
    const requests: Array<{ tools: unknown[]; messages: unknown[] }> = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        requests.push(body);
        const choice = {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "c", type: "function", function: { name: "FILE", arguments: rawArguments } },
            ],
          },
          finish_reason: "tool_calls",
        };
        if (!body.stream) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              id: "fixture",
              object: "chat.completion",
              created: 0,
              model: body.model,
              choices: [choice],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            })
          );
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        const event = (delta: unknown, finish: string | null = null) =>
          res.write(
            `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 0, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
          );
        if (callCount !== 1) {
          event({ role: "assistant", content: "Complete retained prose." });
          for (let index = 0; index < callCount; index++)
            event({
              tool_calls: [
                {
                  index,
                  id: `c${index}`,
                  type: "function",
                  function: { name: "FILE", arguments: rawArguments },
                },
              ],
            });
          event({}, callCount ? "tool_calls" : "stop");
          res.end("data: [DONE]\n\n");
          return;
        }
        const mid = Math.floor(rawArguments.length / 2);
        event({
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "c",
              type: "function",
              function: { name: "FILE", arguments: rawArguments.slice(0, mid) },
            },
          ],
        });
        event({ tool_calls: [{ index: 0, function: { arguments: rawArguments.slice(mid) } }] });
        event({}, "tool_calls");
        res.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing address");
    const local = `http://127.0.0.1:${address.port}/v1/chat/completions`;
    const fetchOriginal = globalThis.fetch;
    vi.stubGlobal("fetch", async (_input: unknown, init: RequestInit) =>
      fetchOriginal(local, init)
    );
    vi.stubEnv("ELIZA_PROVIDER", "cerebras");
    vi.stubEnv("OPENAI_BASE_URL", "https://api.cerebras.ai/v1");
    vi.stubEnv("OPENAI_API_KEY", "fixture");
    vi.stubEnv("CEREBRAS_API_KEY", "");
    vi.stubEnv("ELIZA_MOCK_OPENAI_BASE", "");
    vi.stubEnv("ELIZA_PLANNER_FULL_ACTION_SURFACE", buffered ? "1" : "");
    const callbacks: string[] = [];
    let inputEffects = 0;
    const runtime = {
      getSetting: () => undefined,
      character: { name: "Test" },
      emitEvent: vi.fn(),
      getService: () => null,
      getServicesByType: () => [],
    } as unknown as IAgentRuntime;
    try {
      const run = async () => {
        const result = await handleActionPlanner(runtime, {
          model: "qwen-3.8-27b",
          providerOptions: noOptIn ? {} : { eliza: { preferLosslessToolArguments: true } },
          messages: [{ role: "user", content: "Preserve exact content." }],
          tools: hookFailure
            ? {
                FILE: {
                  inputSchema: jsonSchema(
                    { type: "object", properties: { content: { type: "string" } } },
                    { validate: (value) => ({ success: true, value }) }
                  ),
                  ...(hookOnly ? {} : { execute: async () => ({ success: true }) }),
                  onInputAvailable: ({ input }: { input: unknown }) => {
                    expect(input).toEqual({ content: expected });
                    inputEffects++;
                    throw new Error("503 service unavailable after input hook");
                  },
                },
              }
            : [
                {
                  name: "FILE",
                  description: "Write exact content",
                  parameters: {
                    type: "object",
                    properties: { content: { type: "string" } },
                    required: ["content"],
                    additionalProperties: false,
                  },
                },
              ],
          toolChoice: "required",
          stream,
          streamStructured: structured,
          onStreamChunk: (chunk: string) => {
            callbacks.push(chunk);
          },
        } as never);
        if (stream) {
          const streamed = result as TextStreamResult;
          for await (const _chunk of streamed.textStream) {
            /* drain completion */
          }
          const calls = await streamed.toolCalls;
          expect(calls).toHaveLength(callCount);
          for (const call of calls ?? [])
            expect(call).toMatchObject({ arguments: { content: expected } });
          if (structured && noOptIn)
            expect(callbacks.join("")).toBe(JSON.stringify({ content: expected }));
          if (structured && !noOptIn)
            expect(callbacks).toEqual([
              callCount === 1 ? JSON.stringify({ content: expected }) : "Complete retained prose.",
            ]);
        } else expect(result).toMatchObject({ toolCalls: [{ arguments: { content: expected } }] });
      };
      if (malformed || hookFailure) {
        await expect(run()).rejects.toThrow();
        expect(callbacks).toEqual([]);
      } else await run();
      expect(requests).toHaveLength(1);
      if (hookFailure) expect(inputEffects).toBe(1);
      const schema = (
        requests[0].tools[0] as {
          function: { parameters: { properties: Record<string, unknown> } };
        }
      ).function.parameters;
      if (noOptIn) expect(schema.properties).toHaveProperty("content");
      else expect(schema.properties).toHaveProperty("arguments");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  }
);
