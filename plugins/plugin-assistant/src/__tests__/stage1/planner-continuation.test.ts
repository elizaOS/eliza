import type { State } from "@elizaos/core/protocol";
import { ModelType, type UUID } from "@elizaos/core/protocol";
import { describe, expect, it, vi } from "vitest";
import { runV5MessageRuntimeStage1 } from "../../services/message.js";
import {
  makeMessage,
  makeRuntime,
  stage1Response,
  useModelCalls,
} from "./fixtures.js";

describe("planner prior dialogue and continuation resolution (#17024)", () => {
  const roomId = "00000000-0000-0000-0000-000000001111" as UUID;

  function recentState(recentMessages: unknown[]): State {
    return {
      values: { availableContexts: "simple, general" },
      data: {
        providers: {
          RECENT_MESSAGES: {
            text: "# Conversation Messages\nprovider text should not render",
            data: { recentMessages },
            providerName: "RECENT_MESSAGES",
          },
        },
      },
      text: "",
    };
  }

  it("preserves older ordinary and tool-derived dialogue as history in the planner context", async () => {
    const runtime = makeRuntime([
      stage1Response({
        contexts: ["general"],
        replyText: "On it.",
        extra: { requiresTool: true },
      }),
      JSON.stringify({
        thought: "No tool needed in this fixture.",
        toolCalls: [],
        messageToUser: "Done.",
      }),
    ]);
    const agentId = runtime.agentId;
    const state = recentState([
      {
        id: "00000000-0000-0000-0000-00000000dd01" as UUID,
        entityId: "00000000-0000-0000-0000-00000000dd11" as UUID,
        agentId,
        roomId,
        createdAt: 1,
        content: { text: "whats the btc price", source: "discord" },
        metadata: {
          type: "message",
          sender: { id: "discord-1gig", name: "1gig" },
        },
      },
      {
        id: "00000000-0000-0000-0000-00000000dd02" as UUID,
        entityId: agentId,
        agentId,
        roomId,
        createdAt: 2,
        content: {
          text: "Do you want that in USD or EUR?",
          source: "discord",
        },
      },
      {
        id: "00000000-0000-0000-0000-00000000dd03" as UUID,
        entityId: agentId,
        agentId,
        roomId,
        createdAt: 3,
        content: {
          text: "BTC is around $63,000 right now.",
          source: "discord",
          actions: ["WEB_SEARCH"],
        },
      },
      {
        id: "00000000-0000-0000-0000-00000000dd04" as UUID,
        entityId: agentId,
        agentId,
        roomId,
        createdAt: 4,
        content: {
          text: "ETH is $3,000 right now.",
          source: "discord",
          actionCallbackHistory: ["ETH is $3,000 right now."],
        },
      },
      ...Array.from({ length: 6 }, (_, index) => ({
        id: `later-dialogue-${index}`,
        entityId: agentId,
        agentId,
        roomId,
        createdAt: 5 + index,
        content: { text: `Later unrelated reply ${index}`, source: "discord" },
      })),
    ]);
    runtime.composeState = vi.fn(async () => state);

    const result = await runV5MessageRuntimeStage1({
      runtime,
      message: makeMessage({ text: "in USD please" }),
      state,
      responseId: "00000000-0000-0000-0000-0000000000c1" as UUID,
    });

    expect(result.kind).toBe("planned_reply");
    const calls = useModelCalls(runtime);
    expect(calls[1]?.[0]).toBe(ModelType.ACTION_PLANNER);
    const plannerParams = calls[1]?.[1] as {
      messages?: Array<{ role?: string; content?: string | null }>;
    };
    const plannerUserContent = plannerParams.messages?.[1]?.content ?? "";
    // The ordinary own reply — the question a continuation refers to — is
    // visible and role-tagged.
    expect(plannerUserContent).toContain(
      "Test Agent: Do you want that in USD or EUR?",
    );
    // Tool-derived answers can contain recalled story details. Preserve their
    // visible text without leaking internal action/callback metadata.
    expect(plannerUserContent).toContain("BTC is around $63,000");
    expect(plannerUserContent).toContain("ETH is $3,000");
    expect(plannerUserContent).not.toContain("actionCallbackHistory");
    // The planner boundary instruction now covers own-reply staleness.
  });

  it("resolves an explicit continuation turn to the prior user request for candidate inference", async () => {
    const shellHandler = vi.fn(async () => ({
      success: true,
      text: "Filesystem usage: 42%",
    }));
    const runtime = makeRuntime([
      stage1Response({
        contexts: ["simple"],
        replyText: "Sure.",
      }),
      {
        thought: "Run the pending disk-usage request.",
        toolCalls: [
          {
            id: "shell-disk-usage",
            name: "SHELL",
            arguments: { command: "df -h" },
          },
        ],
      },
      JSON.stringify({
        success: true,
        decision: "FINISH",
        thought: "Shell returned the disk usage.",
        messageToUser: "Filesystem usage is at 42%.",
      }),
    ]);
    runtime.actions = [
      {
        name: "SHELL",
        similes: [],
        description: "Run a local shell command.",
        parameters: [
          {
            name: "command",
            description: "Command to run",
            required: true,
            schema: { type: "string" },
          },
        ],
        examples: [],
        validate: async () => true,
        handler: shellHandler,
      },
    ] as never;
    const agentId = runtime.agentId;
    const state = recentState([
      {
        id: "00000000-0000-0000-0000-00000000ee01" as UUID,
        entityId: "00000000-0000-0000-0000-000000000002" as UUID,
        agentId,
        roomId,
        createdAt: 1,
        content: {
          text: "show me disk usage on this server",
          source: "test",
        },
      },
      {
        id: "00000000-0000-0000-0000-00000000ee02" as UUID,
        entityId: agentId,
        agentId,
        roomId,
        createdAt: 2,
        content: { text: "On it.", source: "test" },
      },
    ]);
    runtime.composeState = vi.fn(async () => state);

    const result = await runV5MessageRuntimeStage1({
      runtime,
      message: makeMessage({ text: "finish my request" }),
      state,
      responseId: "00000000-0000-0000-0000-0000000000c2" as UUID,
    });

    // The contentless continuation turn resolved to the pending shell
    // request, so the turn routes to the planner with the shell candidate
    // and the shell action actually runs.
    expect(result.kind).toBe("planned_reply");
    expect(shellHandler).toHaveBeenCalledTimes(1);
    const calls = useModelCalls(runtime);
    expect(calls[1]?.[0]).toBe(ModelType.ACTION_PLANNER);
    const plannerParams = JSON.stringify(calls[1]?.[1] ?? {});
    expect(plannerParams).toContain("SHELL");
    if (result.kind === "planned_reply") {
      expect(result.result.responseContent?.text).toBe(
        "Filesystem usage is at 42%.",
      );
    }
  });

  it("still resolves an approval continuation after a planner-terminal STOP ack (#20324 review)", async () => {
    const shellHandler = vi.fn(async () => ({
      success: true,
      text: "Filesystem usage: 42%",
    }));
    const runtime = makeRuntime([
      stage1Response({
        contexts: ["simple"],
        replyText: "Sure.",
      }),
      {
        thought: "Run the pending disk-usage request.",
        toolCalls: [
          {
            id: "shell-disk-usage-stop",
            name: "SHELL",
            arguments: { command: "df -h" },
          },
        ],
      },
      JSON.stringify({
        success: true,
        decision: "FINISH",
        thought: "Shell returned the disk usage.",
        messageToUser: "Filesystem usage is at 42%.",
      }),
    ]);
    runtime.actions = [
      {
        name: "SHELL",
        similes: [],
        description: "Run a local shell command.",
        parameters: [
          {
            name: "command",
            description: "Command to run",
            required: true,
            schema: { type: "string" },
          },
        ],
        examples: [],
        validate: async () => true,
        handler: shellHandler,
      },
    ] as never;
    const agentId = runtime.agentId;
    const state = recentState([
      {
        id: "00000000-0000-0000-0000-00000000ee11" as UUID,
        entityId: "00000000-0000-0000-0000-000000000002" as UUID,
        agentId,
        roomId,
        createdAt: 1,
        content: {
          text: "show me disk usage on this server",
          source: "test",
        },
      },
      {
        id: "00000000-0000-0000-0000-00000000ee12" as UUID,
        entityId: agentId,
        agentId,
        roomId,
        createdAt: 2,
        content: { text: "On it.", source: "test", actions: ["STOP"] },
      },
    ]);
    runtime.composeState = vi.fn(async () => state);

    const result = await runV5MessageRuntimeStage1({
      runtime,
      message: makeMessage({ text: "that is good" }),
      state,
      responseId: "00000000-0000-0000-0000-0000000000c6" as UUID,
    });

    expect(result.kind).toBe("planned_reply");
    expect(shellHandler).toHaveBeenCalledTimes(1);
  });

  it("does not promote a non-continuation turn from prior history (topic-switch control)", async () => {
    const runtime = makeRuntime([
      stage1Response({
        contexts: ["simple"],
        replyText: "You're welcome!",
      }),
    ]);
    runtime.actions = [
      {
        name: "SHELL",
        similes: [],
        description: "Run a local shell command.",
        parameters: [],
        examples: [],
        validate: async () => true,
        handler: vi.fn(async () => ({ success: true, text: "" })),
      },
    ] as never;
    const agentId = runtime.agentId;
    const state = recentState([
      {
        id: "00000000-0000-0000-0000-00000000ee01" as UUID,
        entityId: "00000000-0000-0000-0000-000000000002" as UUID,
        agentId,
        roomId,
        createdAt: 1,
        content: {
          text: "show me disk usage on this server",
          source: "test",
        },
      },
      {
        id: "00000000-0000-0000-0000-00000000ee02" as UUID,
        entityId: agentId,
        agentId,
        roomId,
        createdAt: 2,
        content: { text: "On it.", source: "test" },
      },
    ]);
    runtime.composeState = vi.fn(async () => state);

    const result = await runV5MessageRuntimeStage1({
      runtime,
      message: makeMessage({ text: "thanks, you are great" }),
      state,
      responseId: "00000000-0000-0000-0000-0000000000c3" as UUID,
    });

    expect(result.kind).toBe("direct_reply");
    expect(useModelCalls(runtime)).toHaveLength(1);
  });

  it("does not replay a completed action when the user praises its short reply", async () => {
    const shellHandler = vi.fn(async () => ({ success: true, text: "" }));
    const runtime = makeRuntime([
      stage1Response({
        contexts: ["simple"],
        replyText: "Thanks!",
      }),
    ]);
    runtime.actions = [
      {
        name: "SHELL",
        similes: [],
        description: "Run a local shell command.",
        parameters: [],
        examples: [],
        validate: async () => true,
        handler: shellHandler,
      },
    ] as never;
    const agentId = runtime.agentId;
    const state = recentState([
      {
        id: "00000000-0000-0000-0000-00000000ef01" as UUID,
        entityId: "00000000-0000-0000-0000-000000000002" as UUID,
        agentId,
        roomId,
        createdAt: 1,
        content: {
          text: "delete the temporary file with the shell",
          source: "test",
        },
      },
      {
        id: "00000000-0000-0000-0000-00000000ef02" as UUID,
        entityId: agentId,
        agentId,
        roomId,
        createdAt: 2,
        content: { text: "Done.", source: "test" },
      },
    ]);
    runtime.composeState = vi.fn(async () => state);

    const result = await runV5MessageRuntimeStage1({
      runtime,
      message: makeMessage({ text: "that is great" }),
      state,
      responseId: "00000000-0000-0000-0000-0000000000c4" as UUID,
    });

    expect(result.kind).toBe("direct_reply");
    expect(shellHandler).not.toHaveBeenCalled();
    expect(useModelCalls(runtime)).toHaveLength(1);
  });

  it("does not promote another participant's pending request", async () => {
    const shellHandler = vi.fn(async () => ({ success: true, text: "" }));
    const runtime = makeRuntime([
      stage1Response({
        contexts: ["simple"],
        replyText: "What would you like me to do?",
      }),
    ]);
    runtime.actions = [
      {
        name: "SHELL",
        similes: [],
        description: "Run a local shell command.",
        parameters: [],
        examples: [],
        validate: async () => true,
        handler: shellHandler,
      },
    ] as never;
    const agentId = runtime.agentId;
    const state = recentState([
      {
        id: "00000000-0000-0000-0000-00000000ff01" as UUID,
        entityId: "00000000-0000-0000-0000-00000000ff11" as UUID,
        agentId,
        roomId,
        createdAt: 1,
        content: {
          text: "show me disk usage on this server",
          source: "test",
        },
      },
      {
        id: "00000000-0000-0000-0000-00000000ff02" as UUID,
        entityId: agentId,
        agentId,
        roomId,
        createdAt: 2,
        content: { text: "Should I run it?", source: "test" },
      },
    ]);
    runtime.composeState = vi.fn(async () => state);

    const result = await runV5MessageRuntimeStage1({
      runtime,
      message: makeMessage({ text: "go ahead" }),
      state,
      responseId: "00000000-0000-0000-0000-0000000000c5" as UUID,
    });

    expect(result.kind).toBe("direct_reply");
    expect(shellHandler).not.toHaveBeenCalled();
    expect(useModelCalls(runtime)).toHaveLength(1);
  });
});
