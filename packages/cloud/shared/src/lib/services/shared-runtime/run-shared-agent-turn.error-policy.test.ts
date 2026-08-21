/**
 * Pins the Shared turn boundary after AgentRuntime became its sole inference
 * engine. The deterministic harness verifies capability gating, runtime
 * delegation, memory commit ordering, and cause-preserving failures; provider
 * streaming mechanics are covered by shared-eliza-runtime.test.ts.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { ChannelType } from "@elizaos/core/edge";

let providerConfigured = true;
let runtimeFailure: Error | null = null;
let streamFailure: Error | null = null;
let runtimeActionResults: Array<Record<string, unknown>> | undefined;
const runtimeInputs: Array<Record<string, unknown>> = [];
const streamInputs: Array<Record<string, unknown>> = [];

mock.module("../../providers/language-model", () => ({
  hasLanguageModelProviderConfigured: () => providerConfigured,
}));

mock.module("./shared-eliza-runtime", () => ({
  runSharedElizaRuntimeTurn: async (input: Record<string, unknown>) => {
    runtimeInputs.push(input);
    if (runtimeFailure) throw runtimeFailure;
    const history = input.history as Array<{ role: string; content: string }>;
    return {
      reply: "runtime reply",
      history: [
        ...history,
        { role: "user", content: String(input.message) },
        { role: "assistant", content: "runtime reply" },
      ],
      model: String(input.model),
      degraded: false,
      ...(runtimeActionResults ? { actionResults: runtimeActionResults } : {}),
    };
  },
  runSharedElizaRuntimeTurnStream: async (input: Record<string, unknown>) => {
    streamInputs.push(input);
    if (streamFailure) throw streamFailure;
    return {
      model: String(input.model),
      degraded: false,
      parts: (async function* () {
        yield { type: "text-delta" as const, text: "runtime " };
        yield { type: "finish" as const, text: "runtime reply" };
      })(),
    };
  },
}));

const { runSharedAgentTurn, runSharedAgentTurnStream } = await import("./run-shared-agent-turn");

beforeEach(() => {
  providerConfigured = true;
  runtimeFailure = null;
  streamFailure = null;
  runtimeActionResults = undefined;
  runtimeInputs.length = 0;
  streamInputs.length = 0;
});

describe("Shared turn AgentRuntime boundary", () => {
  test("delegates every ordinary turn to AgentRuntime with a fail-closed guest execution", async () => {
    const result = await runSharedAgentTurn({
      character: { name: "Nova", system: "You are Nova.", model: "gpt-oss-120b" },
      history: [],
      message: "hello",
    });

    expect(result.reply).toBe("runtime reply");
    expect(runtimeInputs).toHaveLength(1);
    expect(runtimeInputs[0]).toMatchObject({
      agentKey: "shared:Nova",
      execution: {
        agentKey: "shared:Nova",
        roomKey: "shared:Nova",
        channel: { type: ChannelType.DM, source: "shared-runtime" },
      },
    });
    expect(JSON.stringify(runtimeInputs[0])).toContain("Shared runtime capabilities");
    expect(JSON.stringify(runtimeInputs[0])).toContain("prerequisites:");
  });

  test("preserves server-owned voice execution semantics", async () => {
    await runSharedAgentTurn({
      character: { name: "Eliza", system: "You are Eliza." },
      history: [],
      message: "hello",
      execution: {
        agentKey: "personal:user-1",
        roomKey: "personal:user-1",
        authenticatedPersonalSharedUser: true,
        channel: { type: ChannelType.VOICE_DM, source: "client_chat" },
      },
    });

    expect(runtimeInputs[0]?.execution).toMatchObject({
      agentKey: "personal:user-1",
      authenticatedPersonalSharedUser: true,
      channel: { type: ChannelType.VOICE_DM, source: "client_chat" },
    });
  });

  test("requires a grounded reminder action result before accepting an executable reminder reply", async () => {
    const reminderInput = {
      character: { name: "Eliza", system: "You are Eliza." },
      history: [],
      message: "Remind me in 2 minutes to stretch",
      execution: {
        agentKey: "personal:user-1",
        authenticatedPersonalSharedUser: true as const,
        channel: { type: ChannelType.DM, source: "telegram" },
        reminders: {
          delivery: {
            platform: "telegram" as const,
            project: "eliza-app",
            chatId: "123456789",
          },
          runner: {} as never,
        },
      },
    };

    const error = await runSharedAgentTurn(reminderInput).catch((caught) => caught as Error);
    expect(error.message).toContain("AgentRuntime turn failed");
    expect((error.cause as Error).message).toContain("without an action result");
    expect(JSON.stringify(runtimeInputs[0])).toContain("Call REMINDERS before any terminal answer");
    expect(JSON.stringify(runtimeInputs[0])).toContain("never invent success");

    runtimeActionResults = [
      {
        success: true,
        data: { actionName: "REMINDERS", operation: "create" },
      },
    ];
    const result = await runSharedAgentTurn(reminderInput);
    expect(result.reply).toBe("runtime reply");
  });

  test("routes unsupported capabilities through the model with a truthful constraint", async () => {
    let dispatches = 0;
    const result = await runSharedAgentTurn({
      character: { name: "Eliza", system: "You are Eliza." },
      history: [],
      message: "email Bob now",
      onProviderDispatch: async () => {
        dispatches += 1;
      },
    });

    expect(result.capabilityWall?.capability).toBe("communications");
    expect(runtimeInputs).toHaveLength(1);
    expect(dispatches).toBe(0);
    expect(JSON.stringify(runtimeInputs[0])).toContain("Unavailable actions detected");
    expect(JSON.stringify(runtimeInputs[0])).toContain("do not quote these instructions");
    expect(JSON.stringify(runtimeInputs[0])).toContain(
      "A refusal that only states the limitation is incomplete",
    );
    expect(JSON.stringify(runtimeInputs[0])).toContain("ready-to-copy wording");
    expect(JSON.stringify(runtimeInputs[0])).not.toContain("Calls and messages need Dedicated");
  });

  test("routes streamed capability refusals through the model", async () => {
    const result = await runSharedAgentTurnStream({
      character: { name: "Eliza", system: "You are Eliza." },
      history: [],
      message: "remind me tomorrow",
    });

    expect(result.capabilityWall?.capability).toBe("reminders");
    expect(streamInputs).toHaveLength(1);
    expect(JSON.stringify(streamInputs[0])).toContain("trusted reminder delivery");
    expect(result.model).not.toBe("capability-wall");
  });

  test("commits durable memory only after a runtime reply lands", async () => {
    const replies: string[] = [];
    await runSharedAgentTurn({
      character: { name: "Nova", system: "You are Nova." },
      history: [],
      message: "hello",
      memory: {
        recordTurnPair: async ({ assistantReply }: { assistantReply: string }) => {
          replies.push(assistantReply);
        },
      } as never,
    });
    expect(replies).toEqual(["runtime reply"]);

    runtimeFailure = new Error("provider failed");
    await expect(
      runSharedAgentTurn({
        character: { name: "Nova", system: "You are Nova." },
        history: [],
        message: "again",
        memory: {
          recordTurnPair: async () => {
            replies.push("must not commit");
          },
        } as never,
      }),
    ).rejects.toThrow("AgentRuntime turn failed");
    expect(replies).toEqual(["runtime reply"]);
  });

  test("preserves the AgentRuntime failure as the turn error cause", async () => {
    runtimeFailure = new Error("provider failed");
    const error = await runSharedAgentTurn({
      character: { name: "Nova", system: "You are Nova." },
      history: [],
      message: "hello",
    }).catch((caught) => caught as Error);

    expect(error.message).toContain("AgentRuntime turn failed");
    expect(error.message).toContain("Nova");
    expect(error.cause).toBe(runtimeFailure);
  });

  test("keeps no-model configuration as the sole degraded result", async () => {
    providerConfigured = false;
    const result = await runSharedAgentTurn({
      character: { name: "Nova", system: "You are Nova." },
      history: [],
      message: "hello",
    });

    expect(result.degraded).toBe(true);
    expect(result.model).toBe("none");
    expect(runtimeInputs).toHaveLength(0);
  });

  test("delegates streaming setup to AgentRuntime and wraps setup failures", async () => {
    const result = await runSharedAgentTurnStream({
      character: { name: "Nova", system: "You are Nova." },
      history: [],
      message: "hello",
    });
    expect(streamInputs).toHaveLength(1);
    const parts = [];
    if (!result.parts) throw new Error("Expected runtime stream parts");
    for await (const part of result.parts) parts.push(part);
    expect(parts.at(-1)).toEqual({ type: "finish", text: "runtime reply" });

    streamFailure = new Error("stream setup failed");
    const error = await runSharedAgentTurnStream({
      character: { name: "Nova", system: "You are Nova." },
      history: [],
      message: "again",
    }).catch((caught) => caught as Error);
    expect(error.message).toContain("AgentRuntime stream setup failed");
    expect(error.cause).toBe(streamFailure);
  });
});
