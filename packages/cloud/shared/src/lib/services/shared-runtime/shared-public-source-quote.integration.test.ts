/** Real Core dispatch with deterministic HTTP boundaries; no model or public-provider traffic. */
import { expect, spyOn, test } from "bun:test";
import { ChannelType } from "@elizaos/core";
import { DefaultMessageService } from "@elizaos/plugin-assistant";
import { chatSseFrame } from "../chat-sse-frames";
import { runSharedAgentTurnStream, type SharedAgentTurnStreamPart } from "./run-shared-agent-turn";
import { runSharedElizaRuntimeTurn, runSharedElizaRuntimeTurnStream } from "./shared-eliza-runtime";
import {
  finalizeSharedRealtimeReply,
  resolveSharedRealtimeRequirement,
} from "./shared-realtime-grounding";

/** Only provider HTTP is canned; Core consumes the genuine JSON/SSE wire. */
function modelResponse(
  message: {
    role: string;
    content: string | null;
    tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
  },
  finishReason: "stop" | "tool_calls",
  stream: boolean,
) {
  const usage = { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 };
  if (!stream) {
    return Response.json({
      id: "offline-public-quote",
      object: "chat.completion",
      created: 0,
      model: "qwen-3.8-27b",
      choices: [{ index: 0, finish_reason: finishReason, message }],
      usage,
    });
  }
  const chunks = [
    {
      id: "offline-public-quote",
      object: "chat.completion.chunk",
      created: 0,
      model: "qwen-3.8-27b",
      choices: [
        {
          index: 0,
          finish_reason: null,
          delta: {
            role: message.role,
            ...(message.content ? { content: message.content } : {}),
            ...(message.tool_calls
              ? { tool_calls: message.tool_calls.map((call, index) => ({ index, ...call })) }
              : {}),
          },
        },
      ],
    },
    {
      id: "offline-public-quote",
      object: "chat.completion.chunk",
      created: 0,
      model: "qwen-3.8-27b",
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      usage,
    },
  ];
  return new Response(
    `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
}

for (const [scenario, status] of [
  ["buffered-supported", "supported"],
  ["buffered-unsupported", "unsupported"],
  ["runtime-stream-supported", "supported"],
  ["runtime-stream-unsupported", "unsupported"],
  ["runtime-stream-aborted", "supported"],
  ["outer-stream-supported", "supported"],
  ["outer-stream-aborted-before-consumption", "supported"],
  ["ordinary-stream", "supported"],
] as const) {
  test(`actual Core public source extraction: ${scenario}`, async () => {
    const originalFetch = globalThis.fetch;
    const originalKey = process.env.CEREBRAS_API_KEY;
    const originalFallback = process.env.OPENROUTER_API_KEY;
    const originalEnvironment = process.env.ENVIRONMENT;
    const originalNodeEnv = process.env.NODE_ENV;
    const ordinary = scenario === "ordinary-stream";
    const publicQuestion = "What is Bitcoin trading at in USD right now?";
    const message = ordinary ? "Hello there." : publicQuestion;
    const source = {
      url: "https://example.com/bitcoin-price",
      text: "The current price of Bitcoin is 84354.17 USD.",
    };
    const draft = ordinary ? "Hello there." : `Bitcoin is trading at 84354 USD. ${source.url}`;
    const requirement = resolveSharedRealtimeRequirement(publicQuestion, []);
    if (!requirement) throw new Error("Current price request must have public query authority");
    const grounding = {
      kind: "web_search" as const,
      query: requirement.query,
      provider: "parallel",
      observedAt: Date.now(),
      sources: [source],
      sourceUrls: [source.url],
      text: JSON.stringify({ results: [source] }),
      truncated: false,
    };
    let calls = 0;
    let quoteCalls = 0;
    let searches = 0;
    const abort = new AbortController();
    const abortReason = new Error("synthetic public stream cancellation");
    const observedParts: SharedAgentTurnStreamPart[] = [];
    // Passive call-through spy; the actual Core service and method still run.
    const coreDelivery = spyOn(DefaultMessageService.prototype, "handleMessage");
    process.env.CEREBRAS_API_KEY = "offline-public-quote-fixture";
    delete process.env.OPENROUTER_API_KEY;
    process.env.ENVIRONMENT = "local";
    process.env.NODE_ENV = "production";
    globalThis.fetch = (async (url, init) => {
      if (String(url) === "https://search.parallel.ai/mcp") {
        searches += 1;
        const request = (await new Response(init?.body).json()) as { id: string | number };
        return Response.json({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  results: [{ url: source.url, title: "Bitcoin price", excerpts: [source.text] }],
                }),
              },
            ],
          },
        });
      }
      if (!String(url).includes("api.cerebras.ai"))
        throw new Error("Unexpected offline HTTP boundary");
      calls += 1;
      expect(calls).toBeLessThanOrEqual(3);
      const request = (await new Response(init?.body).json()) as {
        reasoning_effort?: unknown;
        stream?: boolean;
        tools?: Array<{ function?: { name?: string } }>;
        messages?: Array<{ role: string; content?: unknown }>;
      };
      const names = request.tools?.map((tool) => tool.function?.name) ?? [];
      const system = (request.messages ?? [])
        .filter((entry) => entry.role === "system" && typeof entry.content === "string")
        .map((entry) => entry.content as string)
        .join("\n");
      const evaluator = /(?:^|\n)evaluator_stage:\n/.test(system);
      console.info("[offline-public-stage]", {
        ordinal: calls,
        toolCount: names.length,
        evaluator,
        extraction: names.includes("SHARED_SOURCE_QUOTE"),
      });
      if (evaluator) {
        expect(calls).toBe(2);
        return modelResponse(
          {
            role: "assistant",
            content: JSON.stringify({
              success: true,
              decision: "FINISH",
              thought: "The current preflight receipt is available.",
              messageToUser: draft,
              replyEffectStatus: "none",
              requestFullyCovered: true,
            }),
          },
          "stop",
          request.stream === true,
        );
      }
      let args: object;
      let name: string;
      if (names.includes("HANDLE_RESPONSE")) {
        expect(calls).toBe(1);
        name = "HANDLE_RESPONSE";
        args = {
          shouldRespond: "RESPOND",
          contexts: ["simple"],
          intents: [],
          candidateActionNames: [],
          requiresTool: false,
          replyText: draft,
          replyEffectStatus: "none",
          facts: [],
          relationships: [],
          addressedTo: [],
        };
      } else {
        expect(names).toEqual(["SHARED_SOURCE_QUOTE"]);
        expect(request.reasoning_effort).toBe("none");
        quoteCalls += 1;
        expect(quoteCalls).toBe(1);
        if (scenario === "runtime-stream-aborted") {
          abort.abort(abortReason);
          throw abortReason;
        }
        name = "SHARED_SOURCE_QUOTE";
        args = {
          status,
          sourceUrl: source.url,
          quote: status === "supported" ? source.text : "",
        };
      }
      return modelResponse(
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: `offline-${calls}`,
              type: "function",
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
        "tool_calls",
        request.stream === true,
      );
    }) as typeof fetch;
    try {
      const input = {
        character: {
          name: "Eliza",
          system: "You are Eliza.",
          model: "qwen-3.8-27b",
        },
        message,
        capabilityText: message,
        history: [],
        agentKey: "offline-public-quote",
        model: "qwen-3.8-27b",
        abortSignal: abort.signal,
        ...(!ordinary
          ? {
              realtimeGrounding: grounding,
              preflightActionResults: [
                {
                  success: true,
                  data: {
                    actionName: "WEB_SEARCH",
                    query: requirement.query,
                    provider: "parallel",
                    observedAt: grounding.observedAt,
                    sources: [source],
                    sourceUrls: [source.url],
                    text: grounding.text,
                    truncated: false,
                  },
                },
              ],
            }
          : {}),
        execution: {
          channel: { type: ChannelType.DM, source: "blooio" },
          authenticatedPersonalSharedUser: true as const,
          roomKey: "offline-public-quote",
          agentKey: "offline-public-quote",
        },
      };
      let answer: string;
      if (scenario.startsWith("buffered")) {
        const result = await runSharedElizaRuntimeTurn(input);
        expect(result.responded).toBe(true);
        answer = finalizeSharedRealtimeReply(result.reply, grounding);
      } else {
        const stream = scenario.startsWith("outer")
          ? await runSharedAgentTurnStream(input)
          : await runSharedElizaRuntimeTurnStream(input);
        if (scenario === "outer-stream-aborted-before-consumption") abort.abort(abortReason);
        const consume = async () => {
          if (!stream.parts) throw new Error("Actual runtime stream omitted parts");
          for await (const part of stream.parts) observedParts.push(part);
        };
        if (scenario.includes("aborted")) {
          await expect(consume()).rejects.toThrow();
          expect(observedParts).toEqual([]);
          expect(calls).toBe(3);
          expect(quoteCalls).toBe(1);
          expect(coreDelivery.mock.calls[0]?.[3]?.onStreamChunk).toBeUndefined();
          return;
        }
        await consume();
        const text = observedParts
          .filter((part) => part.type === "text-delta")
          .map((part) => part.text)
          .join("");
        const finish = observedParts.find((part) => part.type === "finish");
        if (!finish || finish.type !== "finish") throw new Error("Actual stream omitted finish");
        expect(text).toBe(finish.text);
        expect(observedParts.filter((part) => part.type === "text-delta")).toHaveLength(1);
        const sse = observedParts
          .map((part) =>
            chatSseFrame(
              part.type === "text-delta" ? "chunk" : "done",
              part.type === "text-delta"
                ? { text: part.text, chunk: part.text }
                : { text: part.text },
            ),
          )
          .join("");
        if (ordinary) {
          expect(text).toBe(draft);
          expect(quoteCalls).toBe(0);
          expect(calls).toBe(1);
          expect(coreDelivery.mock.calls[0]?.[3]?.onStreamChunk).toBeFunction();
          return;
        }
        expect(sse).not.toContain(draft);
        expect(sse).not.toContain("84354 USD");
        expect(sse).not.toContain("[[SOURCE_URL:");
        expect(sse).toContain('"type":"done"');
        if (status === "supported") expect(sse).toContain(source.text);
        answer = finish.text;
        expect(searches).toBe(scenario.startsWith("outer") ? 1 : 0);
      }
      expect(calls).toBe(3);
      expect(quoteCalls).toBe(1);
      expect(coreDelivery.mock.calls[0]?.[3]?.onStreamChunk).toBeUndefined();
      if (status === "supported") {
        expect(answer).toContain(source.text);
        expect(answer).toContain(source.url);
        expect(answer).not.toContain("[[SOURCE_URL:");
        expect(answer).not.toContain("parallel");
      } else {
        expect(answer).toContain("couldn’t verify");
      }
    } finally {
      // error-policy:J6 restore every process-owned dependency boundary after any outcome.
      globalThis.fetch = originalFetch;
      coreDelivery.mockRestore();
      for (const [name, value] of [
        ["CEREBRAS_API_KEY", originalKey],
        ["OPENROUTER_API_KEY", originalFallback],
        ["ENVIRONMENT", originalEnvironment],
        ["NODE_ENV", originalNodeEnv],
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
}
