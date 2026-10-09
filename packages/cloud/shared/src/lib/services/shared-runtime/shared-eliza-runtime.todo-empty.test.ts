/** One genuine Core/SQLite TODO turn; synthetic model HTTP, all other network forbidden. */
import { expect, test } from "bun:test";
import { ChannelType, stringToUuid } from "@elizaos/core";
import type { TodoStore } from "@elizaos/plugin-todos";
import { runSharedAgentTurn } from "./run-shared-agent-turn";

function model(content: string | null, tool?: { name: string; args: object }) {
  return Response.json({
    id: "offline-todo-empty",
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
                    id: "offline-todo-tool",
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

test("actual Core planner carries current-owner empty TODO proof into final egress", async () => {
  const savedFetch = globalThis.fetch;
  const saved = {
    cerebras: process.env.CEREBRAS_API_KEY,
    fallback: process.env.OPENROUTER_API_KEY,
    nodeEnv: process.env.NODE_ENV,
  };
  const agentKey = "shared-todo-empty-proof";
  const scope = { agentId: stringToUuid(agentKey), entityId: stringToUuid(`${agentKey}:owner`) };
  const userMessageId = stringToUuid("todo-empty-core-user");
  const reply = "You have no active todos.";
  let reads = 0,
    postToolDispatchReads = 0,
    preToolDispatchReads = 0,
    modelCalls = 0;
  let todoDispatched = false;
  let replyRecoveryRequested = false;
  const unrequested = async (): Promise<never> => {
    throw new Error("UNREQUESTED_TODO_OPERATION");
  };
  const store: TodoStore = {
    list: async (filter) => {
      expect(filter).toEqual({ ...scope, includeCompleted: false });
      reads++;
      if (todoDispatched) postToolDispatchReads++;
      else preToolDispatchReads++;
      return [];
    },
    applyMutation: unrequested,
    readCutoverState: unrequested,
    listMutationRecords: unrequested,
    importMutationRecords: unrequested,
    create: unrequested,
    get: unrequested,
    update: unrequested,
    delete: unrequested,
    writeList: unrequested,
    clear: unrequested,
  };
  process.env.CEREBRAS_API_KEY = "offline-todo-fixture-key";
  delete process.env.OPENROUTER_API_KEY;
  process.env.NODE_ENV = "production";
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("https://api.cerebras.ai/"))
      throw new Error("OFFLINE_NON_MODEL_NETWORK_FORBIDDEN");
    modelCalls++;
    if (modelCalls > 12) throw new Error("OFFLINE_MODEL_CALL_BOUND");
    const text = input instanceof Request ? await input.clone().text() : String(init?.body ?? "");
    const body = JSON.parse(text) as {
      messages?: Array<{ role?: string; content?: unknown }>;
      tools?: Array<{ function?: { name?: string } }>;
    };
    const names = body.tools?.map((tool) => tool.function?.name) ?? [];
    const system = (body.messages ?? [])
      .filter((message) => message.role === "system" && typeof message.content === "string")
      .map((message) => message.content)
      .join("\n");
    if (system.includes("\nreply_recovery:\n")) replyRecoveryRequested = true;
    if (names.includes("HANDLE_RESPONSE"))
      return model(null, {
        name: "HANDLE_RESPONSE",
        args: {
          shouldRespond: "RESPOND",
          thought: "Read the owned checklist.",
          contexts: ["todos"],
          intents: [],
          candidateActionNames: ["TODO"],
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
          thought: "The actual scoped read is settled.",
          messageToUser: reply,
        }),
      );
    if (/(?:^|\n)planner_stage:\n/.test(system) && names.includes("TODO") && !todoDispatched) {
      todoDispatched = true;
      return model(null, { name: "TODO", args: { action: "list" } });
    }
    if (/(?:^|\n)planner_stage:\n/.test(system) && names.length === 0) {
      // The terminal planner explicitly requires this JSON envelope, not plain prose.
      return model(
        JSON.stringify({
          thought: "The scoped TODO read is complete.",
          toolCalls: [],
          messageToUser: reply,
          completed: true,
        }),
      );
    }
    return model(reply);
  }) as typeof fetch;
  try {
    const turn = await runSharedAgentTurn({
      character: { name: "Eliza", system: "You are a concise assistant.", model: "qwen-3.8-27b" },
      history: [],
      message: "Show a checklist.",
      capabilityText: "Show a checklist.",
      messageIds: { user: userMessageId, assistant: stringToUuid("todo-empty-core-assistant") },
      execution: {
        agentKey,
        roomKey: agentKey,
        channel: { type: ChannelType.DM, source: "blooio" },
        authenticatedPersonalSharedUser: true,
        todos: { scope, store },
      },
    });
    expect(todoDispatched).toBe(true);
    expect(reads).toBeGreaterThanOrEqual(1);
    expect(reads).toBe(preToolDispatchReads + postToolDispatchReads);
    // Phase counts are not callsite attribution: providers may recompose after dispatch.
    console.info(
      JSON.stringify({ totalStoreReads: reads, preToolDispatchReads, postToolDispatchReads }),
    );
    expect(modelCalls).toBeGreaterThan(0);
    expect(modelCalls).toBeLessThanOrEqual(12);
    expect(turn.reply).toBe(reply);
    expect(replyRecoveryRequested).toBe(false);
    expect(turn.responded).not.toBe(false);
    const settled =
      turn.actionResults?.filter(
        (action) =>
          action.success && action.data?.actionName === "TODO" && action.data?.op === "list",
      ) ?? [];
    expect(settled).toHaveLength(1);
    const result = settled[0];
    expect(result).toMatchObject({
      success: true,
      data: { op: "list", todos: [], readOnlyOperation: true },
      emptyTrackedState: {
        resource: "todos",
        scope: "active_current_inventory",
        count: 0,
        ...scope,
        messageId: stringToUuid(userMessageId),
      },
    });
  } finally {
    globalThis.fetch = savedFetch;
    for (const [name, value] of [
      ["CEREBRAS_API_KEY", saved.cerebras],
      ["OPENROUTER_API_KEY", saved.fallback],
      ["NODE_ENV", saved.nodeEnv],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
