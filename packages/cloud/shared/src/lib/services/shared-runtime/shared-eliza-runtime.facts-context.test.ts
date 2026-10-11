/** Real public Core dispatcher and Shared SDK handler; every HTTP boundary is synthetic. */
import { expect, spyOn, test } from "bun:test";
import { AgentRuntime, ChannelType, ModelType, stringToUuid } from "@elizaos/core";
import {
  createFactsAndRelationshipsTool,
  runFactsAndRelationshipsStage,
} from "../../../../../../../plugins/plugin-assistant/src/runtime/facts-and-relationships";
import { runSharedElizaRuntimeTurn } from "./shared-eliza-runtime";
import * as capturePolicy from "./shared-owner-model-capture";

function response(content: string | null, tool?: { name: string; args: object }) {
  return Response.json({
    id: "offline-facts-context",
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

test("public facts handler keeps complete Core context while capture is off", async () => {
  const savedFetch = globalThis.fetch;
  const saved = {
    key: process.env.CEREBRAS_API_KEY,
    fallback: process.env.OPENROUTER_API_KEY,
    nodeEnv: process.env.NODE_ENV,
  };
  process.env.CEREBRAS_API_KEY = "offline-facts-context-key";
  delete process.env.OPENROUTER_API_KEY;
  process.env.NODE_ENV = "production";
  const key = "public-facts-context";
  const roomId = stringToUuid(`${key}:room`),
    entityId = stringToUuid(`${key}:owner`);
  const source = {
    url: "https://docs.example/fixtures",
    text: JSON.stringify({
      url: "https://docs.example/fixtures",
      excerpt: "The complete public fixture describes API rate limits.",
    }),
  };
  const grounding = {
    kind: "web_search" as const,
    query: "fixture API rate limits",
    provider: "parallel" as const,
    text: source.text,
    observedAt: Date.now(),
    truncated: false,
    sources: [source],
    sourceUrls: [source.url],
  };
  let originalMessages: unknown, originalSchema: unknown;
  let factsCalls = 0,
    otherLargeCalls = 0,
    actionCalls = 0,
    contextCalls = 0,
    captureChecks = 0;
  const register = AgentRuntime.prototype.registerModel;
  const registration = spyOn(AgentRuntime.prototype, "registerModel").mockImplementation(function (
    this: AgentRuntime,
    type,
    handler,
    provider,
    priority,
    metadata,
  ) {
    if (type !== ModelType.TEXT_LARGE || provider !== "shared-cerebras-model")
      return register.call(this, type, handler, provider, priority, metadata);
    return register.call(
      this,
      type,
      async (runtime, params) => {
        const tool =
          Array.isArray(params.tools) && params.tools.length === 1 ? params.tools[0] : undefined;
        if (
          tool &&
          typeof tool === "object" &&
          "name" in tool &&
          tool.name === "FACTS_AND_RELATIONSHIPS_VALIDATE"
        ) {
          // This is after mandatory Core secret/PII/pre-model handling.
          originalMessages = structuredClone(params.messages);
          if ("parameters" in tool) originalSchema = structuredClone(tool.parameters);
        }
        return handler(runtime, params);
      },
      provider,
      priority,
      metadata,
    );
  });
  const observe = capturePolicy.observeOwnerCapture;
  const capture = spyOn(capturePolicy, "observeOwnerCapture").mockImplementation(
    (value, callback) => {
      expect(value).toBeUndefined();
      captureChecks++;
      return observe(value, callback);
    },
  );
  const initialize = AgentRuntime.prototype.initialize;
  const initialization = spyOn(AgentRuntime.prototype, "initialize").mockImplementation(
    async function (this: AgentRuntime, options) {
      const result = await initialize.call(this, options);
      const factMessage = {
        id: stringToUuid("facts-current"),
        entityId,
        roomId,
        agentId: this.agentId,
        createdAt: Date.now(),
        content: { text: "I enjoy cycling." },
      };
      const oldMessage = {
        ...factMessage,
        id: stringToUuid("facts-history"),
        createdAt: Date.now() - 1000,
        content: { text: "A complete prior user sentence remains here." },
      };
      const facts = await runFactsAndRelationshipsStage({
        runtime: this,
        message: factMessage,
        state: { values: {}, data: {}, text: "" },
        extract: { facts: ["The user enjoys cycling."], relationships: [] },
        priorDialogue: [oldMessage],
      });
      expect(facts.parsed.facts).toEqual([]);
      // A different TEXT_LARGE task must retain the normal public projection.
      await this.useModel(ModelType.TEXT_LARGE, {
        messages: [
          { role: "system", content: "Other structured validation." },
          { role: "user", content: "Keep the full request." },
        ],
        tools: [{ ...createFactsAndRelationshipsTool(), name: "OTHER_VALIDATION" }],
        toolChoice: "required",
      });
      await this.useModel(ModelType.ACTION_PLANNER, {
        messages: [
          { role: "system", content: "Action-context fixture." },
          { role: "user", content: "Keep the complete action request." },
        ],
        tools: [{ ...createFactsAndRelationshipsTool(), name: "OTHER_VALIDATION" }],
        toolChoice: "required",
      });
      return result;
    },
  );
  globalThis.fetch = (async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith("https://api.cerebras.ai/")) throw new Error("UNEXPECTED_OFFLINE_HTTP");
    const text = input instanceof Request ? await input.clone().text() : String(init?.body ?? "");
    const body = JSON.parse(text) as {
      messages?: Array<{ role?: string; content?: unknown }>;
      tools?: Array<{ function?: { name?: string; parameters?: unknown } }>;
    };
    const names = body.tools?.map((tool) => tool.function?.name) ?? [];
    if (names.includes("FACTS_AND_RELATIONSHIPS_VALIDATE")) {
      factsCalls++;
      expect(Array.isArray(originalMessages)).toBe(true);
      const originals = Array.isArray(originalMessages) ? originalMessages : [];
      expect(body.messages).toHaveLength(originals.length);
      for (const [index, message] of originals.entries()) {
        expect(body.messages?.[index]?.role).toBe(message.role);
        let content = body.messages?.[index]?.content;
        if (Array.isArray(content)) {
          expect(content).toHaveLength(1);
          expect(content[0]).toMatchObject({ type: "text" });
          content = content[0].text;
        }
        expect(content).toBe(message.content);
      }
      expect(body.tools?.[0]?.function?.parameters).toEqual(originalSchema);
      const complete = JSON.stringify(originalMessages);
      expect(complete).toContain("A complete prior user sentence remains here.");
      expect(complete).toContain("The user enjoys cycling.");
      expect(complete).not.toContain("untrusted_public_web_search_result");
      return response(null, {
        name: "FACTS_AND_RELATIONSHIPS_VALIDATE",
        args: { facts: [], relationships: [], thought: "No durable addition." },
      });
    }
    expect(JSON.stringify(body.messages)).toContain("untrusted_public_web_search_result");
    if (names.includes("OTHER_VALIDATION")) {
      if (JSON.stringify(body.messages).includes("Action-context fixture.")) actionCalls++;
      else otherLargeCalls++;
      return response(null, {
        name: "OTHER_VALIDATION",
        args: { facts: [], relationships: [], thought: "Completed." },
      });
    }
    contextCalls++;
    if (names.includes("HANDLE_RESPONSE"))
      return response(null, {
        name: "HANDLE_RESPONSE",
        args: {
          shouldRespond: "IGNORE",
          thought: "No response needed.",
          contexts: ["simple"],
          intents: [],
          candidateActionNames: [],
          requiresTool: false,
          replyText: "",
          replyEffectStatus: "none",
          facts: [],
          relationships: [],
          addressedTo: [],
        },
      });
    return response("Hello.");
  }) as typeof fetch;
  try {
    const result = await runSharedElizaRuntimeTurn({
      character: { name: "Eliza", system: "You are Eliza." },
      history: [],
      message: "Hello.",
      capabilityText: "Hello.",
      model: "qwen-3.8-27b",
      agentKey: key,
      realtimeGrounding: grounding,
      execution: { agentKey: key, roomKey: key, channel: { type: ChannelType.DM, source: "test" } },
    });
    expect(result.responded).toBe(false);
    expect(factsCalls).toBe(1);
    expect(otherLargeCalls).toBe(1);
    expect(actionCalls).toBe(1);
    expect(contextCalls).toBeGreaterThan(0);
    expect(captureChecks).toBeGreaterThan(0);
  } finally {
    initialization.mockRestore();
    registration.mockRestore();
    capture.mockRestore();
    globalThis.fetch = savedFetch;
    if (saved.key === undefined) delete process.env.CEREBRAS_API_KEY;
    else process.env.CEREBRAS_API_KEY = saved.key;
    if (saved.fallback === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = saved.fallback;
    if (saved.nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = saved.nodeEnv;
  }
});
