/**
 * Actual Core/Edge handleMessage with the registered Shared Google action.
 * Requires the separately owned runtime-registration hunk to be composed first.
 * All model HTTP is synthetic; all other network is denied by the fixture.
 */
import { expect, spyOn, test } from "bun:test";
import { AgentRuntime, ChannelType, stringToUuid } from "@elizaos/core";
import type { TodoStore } from "@elizaos/plugin-todos";
import { personalSharedAgentId } from "./personal-shared-identity";
import { runSharedAgentTurn } from "./run-shared-agent-turn";
import { resolveSharedCapabilityIntent } from "./shared-capability-wall";
import { runSharedElizaRuntimeTurn } from "./shared-eliza-runtime";
import { resolveSharedRealtimeRequirement } from "./shared-realtime-grounding";

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
async function exercise(
  kind: "general" | "weather" | "weather-missing" | "compound-missing" | "private",
) {
  const publicRead = kind !== "private";
  const compoundMissing = kind === "compound-missing";
  const weatherRead = kind === "weather" || kind === "weather-missing" || compoundMissing;
  const savedFetch = globalThis.fetch;
  const saved = {
    cerebras: process.env.CEREBRAS_API_KEY,
    fallback: process.env.OPENROUTER_API_KEY,
    nodeEnv: process.env.NODE_ENV,
  };
  let reads = 0,
    binds = 0,
    publicCalls = 0,
    modelCalls = 0,
    todoReads = 0;
  let webRegistered = false,
    googleRegistered = false,
    googleCapabilityOffered = false;
  let actualResults: unknown[] = [];
  const publicTopic = 'Gmail API documentation for C# client SDK "rate  limits"';
  const weatherQuery = "current public weather in Phoenix, AZ";
  const publicUrl = "https://developers.google.com/gmail/api/reference/quotas";
  const todoContent = "Stretch fixture shoulders";
  const reply = compoundMissing
    ? `Your checklist includes ${todoContent}. I could not verify current weather.`
    : weatherRead
      ? "I could not verify current weather from the available source."
      : publicRead
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
    googleCapabilityOffered ||= (body.messages ?? []).some(
      (message) =>
        typeof message.content === "string" &&
        message.content.includes("Google connection and Gmail reads (owner permission required)"),
    );
    if (publicRead) expect(names).not.toContain("GOOGLE_CONTEXT");
    if (names.includes("HANDLE_RESPONSE"))
      return model(null, {
        name: "HANDLE_RESPONSE",
        args: {
          shouldRespond: "RESPOND",
          thought: "Use the requested scoped read.",
          contexts: [compoundMissing ? "todos" : "general"],
          intents: [],
          candidateActionNames:
            kind === "weather-missing"
              ? []
              : [compoundMissing ? "TODO" : publicRead ? "WEB_SEARCH" : "GOOGLE_CONTEXT"],
          requiresTool: kind !== "weather-missing",
          replyText: kind === "weather-missing" ? reply : "",
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
      kind === "general" &&
      /(?:^|\n)planner_stage:\n/.test(system) &&
      names.includes("WEB_SEARCH") &&
      publicCalls === 0
    )
      throw new Error("PUBLIC_QUERY_MUST_BE_BOUND_BEFORE_EXECUTOR");
    if (compoundMissing && /(?:^|\n)planner_stage:\n/.test(system) && names.includes("TODO")) {
      return model(null, { name: "TODO", args: { action: "list" } });
    }
    if (weatherRead && /(?:^|\n)planner_stage:\n/.test(system) && names.includes("WEB_SEARCH")) {
      return model(null, { name: "WEB_SEARCH", args: { query: weatherQuery } });
    }
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
        googleRegistered = this.actions.some((action) => action.name === "GOOGLE_CONTEXT");
        const service = this.messageService!;
        const handle = service.handleMessage.bind(service);
        service.handleMessage = async (...args) => {
          const result = await handle(...args);
          actualResults = result.actionResults ?? [];
          if (kind === "general") {
            // Exercise the actual registered action's equivalent-query boundary
            // separately from Core's server-deterministic first call. No handler,
            // Core validator, SDK response or SQLite implementation is replaced.
            const action = this.actions.find((action) => action.name === "WEB_SEARCH")!;
            const attemptedQuery = publicTopic.toLowerCase().replace(/\s+/gu, " ");
            const outcome = await action.handler(this, args[1], undefined, {
              parameters: { query: attemptedQuery },
            });
            expect(outcome && outcome.data?.query).toBe(publicTopic);
            expect(attemptedQuery).not.toBe(publicTopic);
          }
          return result;
        };
      },
    );
    const agentKey = personalSharedAgentId({
      userId: "22222222-2222-4222-8222-222222222222",
      organizationId: "11111111-1111-4111-8111-111111111111",
    });
    const todoScope = {
      agentId: stringToUuid(agentKey),
      entityId: stringToUuid(`${agentKey}:owner`),
    };
    const unrequestedTodoWrite = async (): Promise<never> => {
      throw new Error("OFFLINE_UNREQUESTED_TODO_OPERATION");
    };
    const todoStore: TodoStore = {
      list: async (filter) => {
        expect(filter.agentId).toBe(todoScope.agentId);
        expect(filter.entityId).toBe(todoScope.entityId);
        todoReads += 1;
        return [
          {
            id: stringToUuid("compound-fixture-todo"),
            ...todoScope,
            roomId: null,
            worldId: null,
            content: todoContent,
            activeForm: "Stretching fixture shoulders",
            status: "pending",
            parentTodoId: null,
            parentTrajectoryStepId: null,
            metadata: {},
            createdAt: new Date("2026-10-08T00:00:00Z"),
            updatedAt: new Date("2026-10-08T00:00:00Z"),
            completedAt: null,
          },
        ];
      },
      applyMutation: unrequestedTodoWrite,
      readCutoverState: unrequestedTodoWrite,
      listMutationRecords: unrequestedTodoWrite,
      importMutationRecords: unrequestedTodoWrite,
      create: unrequestedTodoWrite,
      get: unrequestedTodoWrite,
      update: unrequestedTodoWrite,
      delete: unrequestedTodoWrite,
      writeList: unrequestedTodoWrite,
      clear: unrequestedTodoWrite,
    };
    const input: Parameters<typeof runSharedAgentTurn>[0] = {
      character: { name: "Eliza", system: "You are a concise assistant.", model: "qwen-3.8-27b" },
      history: publicRead
        ? [
            {
              role: "assistant",
              content: "Private history topic PRIVATE_HISTORY_MARKER must not be exported.",
            },
          ]
        : [],
      message: compoundMissing
        ? "What is the weather in Phoenix, AZ? Show a checklist."
        : weatherRead
          ? "What is the weather in Phoenix, AZ?"
          : publicRead
            ? `Search the web for ${publicTopic}?`
            : "Search Gmail for API documentation invoices.",
      capabilityText: compoundMissing
        ? "What is the weather in Phoenix, AZ? Show a checklist."
        : weatherRead
          ? "What is the weather in Phoenix, AZ?"
          : publicRead
            ? `Search the web for ${publicTopic}?`
            : "Search Gmail for API documentation invoices.",
      execution: {
        agentKey,
        roomKey: agentKey,
        channel: { type: ChannelType.DM, source: "blooio" },
        authenticatedPersonalSharedUser: true,
        ...(compoundMissing ? { todos: { scope: todoScope, store: todoStore } } : {}),
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
    };
    if (compoundMissing) {
      // Prove this exact input reaches both real predicates before exercising
      // the branch: "my todos" would be correctly blocked as private state.
      const requirement = resolveSharedRealtimeRequirement(input.capabilityText!, input.history);
      expect(requirement?.domain).toBe("weather");
      expect(requirement?.query).toBe(weatherQuery);
      const privateIntent = resolveSharedCapabilityIntent(input.capabilityText!, {
        todos: true,
        googleContext: true,
      });
      expect(privateIntent?.kind).toBe("enabled-primary");
      if (privateIntent?.kind !== "enabled-primary")
        throw new Error("Compound TODO precondition failed");
      expect(privateIntent.primary.capability).toBe("todos");
      // The actual Core result below must additionally prove the TODO list op.
    }
    const turn = weatherRead
      ? await runSharedElizaRuntimeTurn({
          ...input,
          agentKey,
          model: "qwen-3.8-27b",
          execution: input.execution!,
          ...(kind === "weather"
            ? {
                preflightActionResults: [
                  {
                    success: false,
                    text: reply,
                    error: "OFFLINE_CLOSED_WEATHER",
                    data: { actionName: "WEB_SEARCH", query: weatherQuery, observedAt: Date.now() },
                  },
                ],
              }
            : {}),
        })
      : await runSharedAgentTurn(input);
    if (kind === "weather-missing") {
      expect(modelCalls).toBe(0);
      expect(turn.reply).toContain("complete, traceable live source");
      expect(turn.usage?.totalTokens).toBe(0);
    } else expect(modelCalls).toBeGreaterThan(0);
    expect(modelCalls).toBeLessThanOrEqual(12);
    if (compoundMissing) {
      expect(todoReads).toBeGreaterThan(0);
      expect(turn.actionResults).toContainEqual(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            actionName: "TODO",
            op: "list",
            todos: expect.arrayContaining([expect.objectContaining({ content: todoContent })]),
          }),
        }),
      );
      expect(turn.reply).toContain(todoContent);
      expect(turn.reply).toContain("could not verify current weather");
    }
    if (publicRead) {
      expect(webRegistered).toBe(kind === "general" || kind === "weather");
      expect(googleRegistered).toBe(false);
      expect(googleCapabilityOffered).toBe(false);
      expect(publicCalls).toBe(weatherRead ? 0 : 2);
      expect(reads).toBe(0);
      expect(binds).toBe(0);
      expect(
        (turn.actionResults ?? []).some((result) => result.data?.actionName === "GOOGLE_CONTEXT"),
      ).toBe(false);
      if (!weatherRead) {
        expect(turn.reply).toContain("Source:");
        expect(
          turn.actionResults?.find((result) => result.data?.actionName === "WEB_SEARCH")?.data
            ?.query,
        ).toBe(publicTopic);
      }
      expect(turn.reply).not.toContain("PRIVATE_HISTORY_MARKER");
    } else {
      expect(webRegistered).toBe(false);
      expect(googleRegistered).toBe(true);
      expect(googleCapabilityOffered).toBe(true);
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
  await exercise("general");
  await exercise("weather");
  await exercise("weather-missing");
  await exercise("compound-missing");
  await exercise("private");
});
const initializeOriginal = AgentRuntime.prototype.initialize;
