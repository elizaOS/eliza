/**
 * Actual Core/Edge handleMessage with the registered Shared Google action.
 * Requires the separately owned runtime-registration hunk to be composed first.
 * All model HTTP is synthetic; all other network is denied by the fixture.
 */
import { expect, spyOn, test } from "bun:test";
import { AgentRuntime, ChannelType } from "@elizaos/core";
import { personalSharedAgentId } from "./personal-shared-identity";
import { runSharedAgentTurn } from "./run-shared-agent-turn";

function model(content: string | null, tool?: { name: string; args: object }) {
  return Response.json({
    id: "offline-google",
    object: "chat.completion",
    created: 0,
    model: "qwen-3.8-27b",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content,
          ...(tool
            ? {
                tool_calls: [
                  {
                    id: "offline-tool",
                    type: "function",
                    function: { name: tool.name, arguments: JSON.stringify(tool.args) },
                  },
                ],
              }
            : {}),
        },
        finish_reason: tool ? "tool_calls" : "stop",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}
async function exercise(publicRead: boolean) {
  const savedFetch = globalThis.fetch;
  const saved = {
    cerebras: process.env.CEREBRAS_API_KEY,
    fallback: process.env.OPENROUTER_API_KEY,
    nodeEnv: process.env.NODE_ENV,
  };
  let reads = 0,
    binds = 0,
    publicCalls = 0,
    modelCalls = 0;
  let webRegistered = false;
  let actualResults: unknown[] = [];
  const publicTopic = "Gmail API documentation rate limits";
  const publicUrl = "https://developers.google.com/gmail/api/reference/quotas";
  const reply = publicRead
    ? `Gmail API documentation describes API rate limits. [[SOURCE_URL:${publicUrl}]]`
    : "No matching invoices were found.";
  process.env.CEREBRAS_API_KEY = "offline-google-unit-key";
  delete process.env.OPENROUTER_API_KEY;
  process.env.NODE_ENV = "production";
  globalThis.fetch = (async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === "https://search.parallel.ai/mcp") {
      publicCalls += 1;
      const requestText =
        input instanceof Request ? await input.clone().text() : String(init?.body ?? "");
      expect(JSON.parse(requestText).params.arguments).toEqual({
        objective: publicTopic,
        search_queries: [publicTopic],
      });
      expect(requestText).not.toContain("PRIVATE_HISTORY_MARKER");
      return Response.json({
        jsonrpc: "2.0",
        id: 1,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                results: [
                  {
                    url: publicUrl,
                    title: "Gmail API quotas",
                    excerpt: "Gmail API documentation describes API rate limits.",
                  },
                ],
              }),
            },
          ],
        },
      });
    }
    if (!url.startsWith("https://api.cerebras.ai/"))
      throw new Error("OFFLINE_NON_MODEL_NETWORK_BLOCKED");
    modelCalls += 1;
    const text = input instanceof Request ? await input.clone().text() : String(init?.body ?? "");
    const body = JSON.parse(text) as {
      messages?: Array<{ role?: string; content?: unknown }>;
      tools?: Array<{ function?: { name?: string } }>;
    };
    const names = body.tools?.map((t) => t.function?.name) ?? [];
    const system = (body.messages ?? [])
      .filter((m) => m.role === "system" && typeof m.content === "string")
      .map((m) => m.content)
      .join("\n");
    if (names.includes("HANDLE_RESPONSE"))
      return model(null, {
        name: "HANDLE_RESPONSE",
        args: {
          shouldRespond: "RESPOND",
          thought: "Use the requested owned private read.",
          contexts: ["general"],
          intents: [],
          candidateActionNames: [publicRead ? "WEB_SEARCH" : "GOOGLE_CONTEXT"],
          requiresTool: true,
          replyText: "",
          replyEffectStatus: "none",
          facts: [],
          relationships: [],
          addressedTo: [],
        },
      });
    if (names.includes("FACTS_AND_RELATIONSHIPS_VALIDATE"))
      return model(null, {
        name: "FACTS_AND_RELATIONSHIPS_VALIDATE",
        args: { facts: [], relationships: [], thought: "No additional facts." },
      });
    if (/(?:^|\n)evaluator_stage:\n/.test(system))
      return model(
        JSON.stringify({
          success: true,
          decision: "FINISH",
          thought: "The private read is settled.",
          messageToUser: reply,
        }),
      );
    if (
      publicRead &&
      /(?:^|\n)planner_stage:\n/.test(system) &&
      names.includes("WEB_SEARCH") &&
      publicCalls === 0
    )
      throw new Error("PUBLIC_QUERY_MUST_BE_BOUND_BEFORE_EXECUTOR");
    if (
      /(?:^|\n)planner_stage:\n/.test(system) &&
      names.includes("GOOGLE_CONTEXT") &&
      reads === 0
    ) {
      return model(null, {
        name: "GOOGLE_CONTEXT",
        args: { operation: "gmail_search", query: "invoices" },
      });
    }
    return model(reply);
  }) as typeof fetch;
  let runtimeSpy: ReturnType<typeof spyOn> | undefined;
  try {
    // Observe the actual runtime's returned results, without seeding any completion state.
    runtimeSpy = spyOn(AgentRuntime.prototype, "initialize").mockImplementation(
      async function (options) {
        const initialize = initializeOriginal;
        await initialize.call(this, options);
        webRegistered = this.actions.some((action) => action.name === "WEB_SEARCH");
        const service = this.messageService!;
        const handle = service.handleMessage.bind(service);
        service.handleMessage = async (...args) => {
          const result = await handle(...args);
          actualResults = result.actionResults ?? [];
          return result;
        };
      },
    );
    const agentKey = personalSharedAgentId({
      userId: "22222222-2222-4222-8222-222222222222",
      organizationId: "11111111-1111-4111-8111-111111111111",
    });
    const turn = await runSharedAgentTurn({
      character: { name: "Eliza", system: "You are a concise assistant.", model: "qwen-3.8-27b" },
      history: publicRead
        ? [
            {
              role: "assistant",
              content: "Private history topic PRIVATE_HISTORY_MARKER must not be exported.",
            },
          ]
        : [],
      message: publicRead
        ? "Search the web for Gmail API documentation rate limits?"
        : "Search Gmail for API documentation invoices.",
      capabilityText: publicRead
        ? "Search the web for Gmail API documentation rate limits?"
        : "Search Gmail for API documentation invoices.",
      execution: {
        agentKey,
        roomKey: agentKey,
        channel: { type: ChannelType.DM, source: "blooio" },
        authenticatedPersonalSharedUser: true,
        google: async () => {
          binds += 1;
          if (publicRead) throw new Error("PUBLIC_READ_MUST_NOT_BIND_PRIVATE_GOOGLE");
          return {
            connect: async () => {
              throw new Error("OFFLINE_UNREQUESTED_CONNECT");
            },
            read: async (request) => {
              expect(request).toEqual({ kind: "gmail_search", query: "invoices" });
              reads += 1;
              return {
                kind: "private_google_gmail_search",
                untrustedContent: true,
                observedAt: "2026-10-08T00:00:00Z",
                messages: [],
              };
            },
          };
        },
      },
    });
    expect(modelCalls).toBeGreaterThan(0);
    expect(modelCalls).toBeLessThanOrEqual(12);
    if (publicRead) {
      expect(webRegistered).toBe(true);
      expect(publicCalls).toBe(1);
      expect(reads).toBe(0);
      expect(binds).toBe(0);
      expect(
        turn.actionResults?.some((result) => result.data?.actionName === "GOOGLE_CONTEXT"),
      ).toBe(false);
      expect(turn.reply).toContain("Source:");
      expect(turn.reply).not.toContain("PRIVATE_HISTORY_MARKER");
    } else {
      expect(webRegistered).toBe(false);
      expect(publicCalls).toBe(0);
      expect(reads).toBe(1);
      expect(binds).toBe(1);
      expect(actualResults).toContainEqual(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({ actionName: "GOOGLE_CONTEXT", privateSource: true }),
        }),
      );
      expect(
        turn.actionResults?.filter((result) => result.data?.actionName === "GOOGLE_CONTEXT"),
      ).toHaveLength(1);
      expect(turn.reply).toBe(reply);
    }
  } finally {
    runtimeSpy?.mockRestore();
    globalThis.fetch = savedFetch;
    if (saved.cerebras === undefined) delete process.env.CEREBRAS_API_KEY;
    else process.env.CEREBRAS_API_KEY = saved.cerebras;
    if (saved.fallback === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = saved.fallback;
    if (saved.nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = saved.nodeEnv;
  }
}
test("actual Core keeps complete public Google queries separate from consented owner Google reads", async () => {
  await exercise(true);
  await exercise(false);
});
const initializeOriginal = AgentRuntime.prototype.initialize;
