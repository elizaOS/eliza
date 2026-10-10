/** Real Core dispatch with deterministic HTTP boundaries; no model or public-provider traffic. */
import { expect, test } from "bun:test";
import { ChannelType } from "@elizaos/core";
import { runSharedElizaRuntimeTurn } from "./shared-eliza-runtime";
import {
  finalizeSharedRealtimeReply,
  resolveSharedRealtimeRequirement,
} from "./shared-realtime-grounding";

for (const status of ["supported", "unsupported"] as const) {
  test(`actual Core public source extraction: ${status}`, async () => {
    const originalFetch = globalThis.fetch;
    const originalKey = process.env.CEREBRAS_API_KEY;
    const originalFallback = process.env.OPENROUTER_API_KEY;
    const originalEnvironment = process.env.ENVIRONMENT;
    const originalNodeEnv = process.env.NODE_ENV;
    const message = "What is Bitcoin trading at in USD right now?";
    const source = {
      url: "https://example.com/bitcoin-price",
      text: "The current price of Bitcoin is 84354.17 USD.",
    };
    const draft = `Bitcoin is trading at 84354 USD. ${source.url}`;
    const requirement = resolveSharedRealtimeRequirement(message, []);
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
    process.env.CEREBRAS_API_KEY = "offline-public-quote-fixture";
    delete process.env.OPENROUTER_API_KEY;
    process.env.ENVIRONMENT = "local";
    process.env.NODE_ENV = "production";
    globalThis.fetch = (async (url, init) => {
      if (!String(url).includes("api.cerebras.ai"))
        throw new Error("Unexpected offline HTTP boundary");
      calls += 1;
      expect(calls).toBeLessThanOrEqual(3);
      const request = (await new Response(init?.body).json()) as {
        reasoning_effort?: unknown;
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
        return Response.json({
          id: "offline-public-evaluator",
          object: "chat.completion",
          created: 0,
          model: "qwen-3.8-27b",
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: {
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
            },
          ],
          usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
        });
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
        name = "SHARED_SOURCE_QUOTE";
        args = {
          status,
          sourceUrl: source.url,
          quote: status === "supported" ? source.text : "",
        };
      }
      return Response.json({
        id: "offline-public-quote",
        object: "chat.completion",
        created: 0,
        model: "qwen-3.8-27b",
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: `offline-${calls}`,
                  type: "function",
                  function: {
                    name,
                    arguments: JSON.stringify(args),
                  },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
      });
    }) as typeof fetch;
    try {
      const result = await runSharedElizaRuntimeTurn({
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
        execution: {
          channel: { type: ChannelType.DM, source: "blooio" },
          authenticatedPersonalSharedUser: true,
          roomKey: "offline-public-quote",
          agentKey: "offline-public-quote",
        },
      });
      expect(result.responded).toBe(true);
      expect(calls).toBe(3);
      expect(quoteCalls).toBe(1);
      const answer = finalizeSharedRealtimeReply(result.reply, grounding);
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
