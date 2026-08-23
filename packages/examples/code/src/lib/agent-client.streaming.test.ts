// Exercises the Code example behavior that this module protects.
import { beforeEach, describe, expect, it } from "bun:test";
import {
  ChannelType,
  type Content,
  ElizaError,
  FAILED_TOOL_FALLBACK_MESSAGE,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type MessageTerminalFailure,
  type StreamChunkCallback,
  stringToUuid,
} from "@elizaos/core";
import type { ChatRoom } from "../types.js";
import { getAgentClient, resetAgentClient } from "./agent-client.js";
import type { SessionIdentity } from "./identity.js";

interface HandleMessageOptions {
  codingMode?: boolean;
  abortSignal?: AbortSignal;
  onStreamChunk?: StreamChunkCallback;
}

function makeIdentity(): SessionIdentity {
  const projectId = stringToUuid("agent-client-streaming-test-project");
  return {
    projectId,
    userId: stringToUuid("agent-client-streaming-test-user"),
    worldId: stringToUuid("agent-client-streaming-test-world"),
    messageServerId: stringToUuid("agent-client-streaming-test-server"),
  };
}

function makeRoom(): ChatRoom {
  return {
    id: "streaming-test-room",
    name: "Streaming test",
    messages: [],
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    taskIds: [],
    elizaRoomId: stringToUuid("agent-client-streaming-test-room"),
  };
}

function makeRuntime(
  handleMessage: (
    runtime: IAgentRuntime,
    message: Memory,
    callback?: HandlerCallback,
    options?: HandleMessageOptions,
  ) => Promise<{
    didRespond: boolean;
    responseContent?: Content | null;
    responseMessages: Memory[];
    terminalFailure?: MessageTerminalFailure;
  }>,
): IAgentRuntime {
  return {
    ensureConnection: async () => {},
    messageService: {
      handleMessage,
    },
  } as unknown as IAgentRuntime;
}

describe("AgentClient streaming", () => {
  beforeEach(() => {
    resetAgentClient();
  });

  it("passes onStreamChunk through and does not duplicate the final callback text", async () => {
    const deltas: string[] = [];
    const abortController = new AbortController();
    let seenOptions: HandleMessageOptions | undefined;

    const runtime = makeRuntime(
      async (_runtime, _message, callback, options) => {
        seenOptions = options;
        await options?.onStreamChunk?.("hel", "response-id", "hel");
        await options?.onStreamChunk?.("lo", "response-id", "hello");
        await callback?.({ text: "hello" });
        return { didRespond: true, responseMessages: [] };
      },
    );

    getAgentClient().setRuntime(runtime);
    const response = await getAgentClient().sendMessage({
      room: makeRoom(),
      text: "say hello",
      identity: makeIdentity(),
      codingMode: true,
      abortSignal: abortController.signal,
      onDelta: (delta) => deltas.push(delta),
    });

    expect(response).toBe("hello");
    expect(deltas).toEqual(["hel", "lo"]);
    expect(seenOptions?.codingMode).toBe(true);
    expect(seenOptions?.abortSignal).toBe(abortController.signal);
    expect(typeof seenOptions?.onStreamChunk).toBe("function");
  });

  it("falls back to callback text when no text chunks stream", async () => {
    const deltas: string[] = [];

    const runtime = makeRuntime(
      async (_runtime, _message, callback, options) => {
        await options?.onStreamChunk?.(
          JSON.stringify({ type: "tool_call", name: "SHELL" }),
          "response-id",
        );
        await callback?.({ text: "done" });
        return { didRespond: true, responseMessages: [] };
      },
    );

    getAgentClient().setRuntime(runtime);
    const response = await getAgentClient().sendMessage({
      room: makeRoom(),
      text: "run a tool",
      identity: makeIdentity(),
      onDelta: (delta) => deltas.push(delta),
    });

    expect(response).toBe("done");
    expect(deltas).toEqual(["done"]);
  });

  it("appends only the missing final suffix after streamed text", async () => {
    const deltas: string[] = [];

    const runtime = makeRuntime(
      async (_runtime, _message, callback, options) => {
        await options?.onStreamChunk?.(
          "The answer",
          "response-id",
          "The answer",
        );
        await callback?.({ text: "The answer is 42." });
        return { didRespond: true, responseMessages: [] };
      },
    );

    getAgentClient().setRuntime(runtime);
    const response = await getAgentClient().sendMessage({
      room: makeRoom(),
      text: "answer",
      identity: makeIdentity(),
      onDelta: (delta) => deltas.push(delta),
    });

    expect(response).toBe("The answer is 42.");
    expect(deltas).toEqual(["The answer", " is 42."]);
  });

  it("uses the returned response content when a host callback is not invoked", async () => {
    const runtime = makeRuntime(async () => ({
      didRespond: true,
      responseContent: { text: "returned directly" },
      responseMessages: [],
    }));

    getAgentClient().setRuntime(runtime);
    await expect(
      getAgentClient().sendMessage({
        room: makeRoom(),
        text: "answer",
        identity: makeIdentity(),
      }),
    ).resolves.toBe("returned directly");
  });

  it("rejects synthetic runtime replies instead of returning them as success", async () => {
    const runtime = makeRuntime(async (_runtime, _message, callback) => {
      await callback?.({
        text: "Something went wrong on my end. Please try again.",
        failureKind: "transient_failure",
        elizaSyntheticFailure: true,
        transient: true,
      });
      return {
        didRespond: true,
        responseContent: {
          text: "Something went wrong on my end. Please try again.",
          failureKind: "transient_failure",
          elizaSyntheticFailure: true,
          transient: true,
        },
        responseMessages: [],
      };
    });

    getAgentClient().setRuntime(runtime);
    await expect(
      getAgentClient().sendMessage({
        room: makeRoom(),
        text: "run a tool",
        identity: makeIdentity(),
      }),
    ).rejects.toMatchObject({
      code: "ELIZA_CODE_SYNTHETIC_TURN_FAILURE",
      context: { failureKind: "transient_failure", transient: true },
    });
  });

  it("rejects a terminal failure when callback delivery suppresses response content", async () => {
    const message =
      "I changed files but could not complete the required command verification.";
    const runtime = makeRuntime(async (_runtime, _message, callback) => {
      await callback?.({ text: message });
      return {
        didRespond: true,
        responseContent: null,
        responseMessages: [],
        terminalFailure: {
          kind: "coding_mutation_unverified",
          transient: false,
          message,
        },
      };
    });

    getAgentClient().setRuntime(runtime);
    await expect(
      getAgentClient().sendMessage({
        room: makeRoom(),
        text: "change a file",
        identity: makeIdentity(),
        codingMode: true,
      }),
    ).rejects.toMatchObject({
      code: "ELIZA_CODE_SYNTHETIC_TURN_FAILURE",
      context: {
        failureKind: "coding_mutation_unverified",
        transient: false,
      },
    });
  });

  it("rejects the planner's failed-tool fallback as a failed coding turn", async () => {
    const runtime = makeRuntime(async () => ({
      didRespond: true,
      responseContent: {
        text: `${FAILED_TOOL_FALLBACK_MESSAGE}\n\nWork that did complete: read config.go`,
      },
      responseMessages: [],
    }));

    getAgentClient().setRuntime(runtime);
    await expect(
      getAgentClient().sendMessage({
        room: makeRoom(),
        text: "run a tool",
        identity: makeIdentity(),
      }),
    ).rejects.toMatchObject({
      code: "ELIZA_CODE_SYNTHETIC_TURN_FAILURE",
      context: { failureKind: "unknown", transient: false },
    });
  });
});

function makePlumbingRuntime(
  handleMessage: (
    message: Memory,
    options: HandleMessageOptions | undefined,
  ) => Promise<{
    didRespond: boolean;
    responseContent?: Content | null;
    responseMessages: Memory[];
    terminalFailure?: MessageTerminalFailure;
  }>,
): { runtime: IAgentRuntime; connections: Array<Record<string, unknown>> } {
  const connections: Array<Record<string, unknown>> = [];
  const runtime = {
    ensureConnection: async (connection: Record<string, unknown>) => {
      connections.push(connection);
    },
    messageService: {
      handleMessage: async (
        _runtime: IAgentRuntime,
        message: Memory,
        _callback?: HandlerCallback,
        options?: HandleMessageOptions,
      ) => handleMessage(message, options),
    },
  } as unknown as IAgentRuntime;
  return { runtime, connections };
}

function makeClearingRuntime(): {
  runtime: IAgentRuntime;
  clearCalls: Array<{
    runtime: unknown;
    elizaRoomId: unknown;
    channelId: unknown;
  }>;
} {
  const clearCalls: Array<{
    runtime: unknown;
    elizaRoomId: unknown;
    channelId: unknown;
  }> = [];
  const runtime = {
    ensureConnection: async () => {},
    messageService: {
      handleMessage: async () => ({ didRespond: false, responseMessages: [] }),
      clearChannel: async (
        runtimeArg: unknown,
        elizaRoomId: unknown,
        channelId: unknown,
      ) => {
        clearCalls.push({ runtime: runtimeArg, elizaRoomId, channelId });
      },
    },
  } as unknown as IAgentRuntime;
  return { runtime, clearCalls };
}

describe("AgentClient client lifecycle, turn plumbing, and clearing", () => {
  beforeEach(() => {
    resetAgentClient();
  });

  it("returns the same client until a reset swaps in a fresh instance", () => {
    const first = getAgentClient();
    expect(getAgentClient()).toBe(first);

    resetAgentClient();

    expect(getAgentClient()).not.toBe(first);
  });

  it("rejects a send while no runtime is attached", async () => {
    await expect(
      getAgentClient().sendMessage({
        room: makeRoom(),
        text: "hello",
        identity: makeIdentity(),
      }),
    ).rejects.toThrow("Runtime not initialized");
  });

  it("applies default user name, source, and DM channel type to the turn", async () => {
    const identity = makeIdentity();
    const room = makeRoom();
    let seenMemory: Memory | undefined;
    let seenOptions: HandleMessageOptions | undefined;

    const { runtime, connections } = makePlumbingRuntime(
      async (message, options) => {
        seenMemory = message;
        seenOptions = options;
        return { didRespond: true, responseMessages: [] };
      },
    );

    getAgentClient().setRuntime(runtime);
    const response = await getAgentClient().sendMessage({
      room,
      text: "status",
      identity,
    });

    expect(response).toBe("");
    expect(connections).toHaveLength(1);
    expect(connections[0]).toMatchObject({
      entityId: identity.userId,
      roomId: room.elizaRoomId,
      worldId: identity.worldId,
      userName: "User",
      source: "eliza-code",
      type: ChannelType.DM,
      channelId: room.id,
      messageServerId: identity.messageServerId,
    });
    expect(seenMemory?.entityId).toBe(identity.userId);
    expect(seenMemory?.roomId).toBe(room.elizaRoomId);
    expect(seenMemory?.content).toMatchObject({
      text: "status",
      source: "eliza-code",
      channelType: ChannelType.DM,
    });
    expect(seenOptions).toBeUndefined();
  });

  it("honours explicit user name, source, and channel type overrides", async () => {
    const identity = makeIdentity();
    const room = makeRoom();
    let seenMemory: Memory | undefined;

    const { runtime, connections } = makePlumbingRuntime(async (message) => {
      seenMemory = message;
      return { didRespond: true, responseMessages: [] };
    });

    getAgentClient().setRuntime(runtime);
    await getAgentClient().sendMessage({
      room,
      text: "deploy check",
      identity,
      userName: "Avery",
      source: "cockpit-test",
      channelType: ChannelType.GROUP,
    });

    expect(connections[0]).toMatchObject({
      userName: "Avery",
      source: "cockpit-test",
      type: ChannelType.GROUP,
    });
    expect(seenMemory?.content).toMatchObject({
      text: "deploy check",
      source: "cockpit-test",
      channelType: ChannelType.GROUP,
    });
  });

  it("emits the raw chunk and adopts the accumulated text after divergence", async () => {
    const deltas: string[] = [];

    const runtime = makeRuntime(
      async (_runtime, _message, _callback, options) => {
        await options?.onStreamChunk?.("Hello", "response-id", "Hello");
        await options?.onStreamChunk?.(
          "World!",
          "response-id",
          "Goodbye world!",
        );
        return { didRespond: true, responseMessages: [] };
      },
    );

    getAgentClient().setRuntime(runtime);
    const response = await getAgentClient().sendMessage({
      room: makeRoom(),
      text: "greet",
      identity: makeIdentity(),
      onDelta: (delta) => deltas.push(delta),
    });

    expect(deltas).toEqual(["Hello", "World!"]);
    expect(response).toBe("Goodbye world!");
  });

  it("skips stream chunks whose accumulation matches the streamed prefix exactly", async () => {
    const deltas: string[] = [];

    const runtime = makeRuntime(
      async (_runtime, _message, _callback, options) => {
        await options?.onStreamChunk?.("Hi", "response-id", "Hi");
        await options?.onStreamChunk?.("Hi", "response-id", "Hi");
        return { didRespond: true, responseMessages: [] };
      },
    );

    getAgentClient().setRuntime(runtime);
    const response = await getAgentClient().sendMessage({
      room: makeRoom(),
      text: "greet",
      identity: makeIdentity(),
      onDelta: (delta) => deltas.push(delta),
    });

    expect(deltas).toEqual(["Hi"]);
    expect(response).toBe("Hi");
  });

  it("appends unrecognised json payloads to the visible transcript instead of dropping them", async () => {
    const deltas: string[] = [];

    const runtime = makeRuntime(
      async (_runtime, _message, _callback, options) => {
        await options?.onStreamChunk?.(
          '{"type":"mystery_event"}',
          "response-id",
        );
        await options?.onStreamChunk?.('{"broken"', "response-id");
        return { didRespond: true, responseMessages: [] };
      },
    );

    getAgentClient().setRuntime(runtime);
    const response = await getAgentClient().sendMessage({
      room: makeRoom(),
      text: "stream something",
      identity: makeIdentity(),
      onDelta: (delta) => deltas.push(delta),
    });

    expect(deltas).toEqual(['{"type":"mystery_event"}', '{"broken"']);
    expect(response).toBe('{"type":"mystery_event"}{"broken"');
  });

  it("recognises structured events behind leading whitespace", async () => {
    const deltas: string[] = [];

    const runtime = makeRuntime(
      async (_runtime, _message, callback, options) => {
        await options?.onStreamChunk?.(
          '  {"type":"context_event"}',
          "response-id",
        );
        await callback?.({ text: "final answer" });
        return { didRespond: true, responseMessages: [] };
      },
    );

    getAgentClient().setRuntime(runtime);
    const response = await getAgentClient().sendMessage({
      room: makeRoom(),
      text: "stream something",
      identity: makeIdentity(),
      onDelta: (delta) => deltas.push(delta),
    });

    expect(deltas).toEqual(["final answer"]);
    expect(response).toBe("final answer");
  });

  it("maps a transient terminal failure to an ephemeral error carrying the failure code", async () => {
    const runtime = makeRuntime(async () => ({
      didRespond: false,
      responseContent: null,
      responseMessages: [],
      terminalFailure: {
        kind: "tool_boundary_failed",
        code: "TOOL_EXIT_1",
        transient: true,
        message: "The tool run aborted.",
      },
    }));

    getAgentClient().setRuntime(runtime);
    await expect(
      getAgentClient().sendMessage({
        room: makeRoom(),
        text: "run a tool",
        identity: makeIdentity(),
      }),
    ).rejects.toMatchObject({
      code: "ELIZA_CODE_SYNTHETIC_TURN_FAILURE",
      severity: "ephemeral",
      context: {
        failureKind: "tool_boundary_failed",
        failureCode: "TOOL_EXIT_1",
        transient: true,
      },
    });
  });

  it("reports non-transient terminal failures as fatal with no failure code", async () => {
    const runtime = makeRuntime(async () => ({
      didRespond: false,
      responseMessages: [],
      terminalFailure: {
        kind: "coding_mutation_unverified",
        transient: false,
        message: "Verification could not complete.",
      },
    }));

    getAgentClient().setRuntime(runtime);

    let caught: unknown;
    try {
      await getAgentClient().sendMessage({
        room: makeRoom(),
        text: "change a file",
        identity: makeIdentity(),
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ElizaError);
    const elizaError = caught as ElizaError;
    expect(elizaError.severity).toBe("fatal");
    expect(elizaError.context).toEqual({
      failureKind: "coding_mutation_unverified",
      transient: false,
    });
  });

  it("falls back to the generic message when a synthetic failure carries blank text", async () => {
    const runtime = makeRuntime(async () => ({
      didRespond: true,
      responseContent: { text: "   \n\t", elizaSyntheticFailure: true },
      responseMessages: [],
    }));

    getAgentClient().setRuntime(runtime);
    await expect(
      getAgentClient().sendMessage({
        room: makeRoom(),
        text: "retry",
        identity: makeIdentity(),
      }),
    ).rejects.toMatchObject({
      code: "ELIZA_CODE_SYNTHETIC_TURN_FAILURE",
      message: "The coding-agent turn failed before producing a result.",
      severity: "fatal",
      context: { failureKind: "unknown", transient: false },
    });
  });

  it("forwards clearConversation to the runtime channel clearer", async () => {
    const room = makeRoom();
    const { runtime, clearCalls } = makeClearingRuntime();

    getAgentClient().setRuntime(runtime);
    await getAgentClient().clearConversation(room);

    expect(clearCalls).toHaveLength(1);
    expect(clearCalls[0]?.runtime).toBe(runtime);
    expect(clearCalls[0]?.elizaRoomId).toBe(room.elizaRoomId);
    expect(clearCalls[0]?.channelId).toBe(room.id);
  });

  it("treats clearConversation as a no-op when the message service is absent", async () => {
    const runtime = {
      ensureConnection: async () => {},
    } as unknown as IAgentRuntime;

    getAgentClient().setRuntime(runtime);
    await expect(
      getAgentClient().clearConversation(makeRoom()),
    ).resolves.toBeUndefined();
  });

  it("resolves silently when clearing before any runtime exists", async () => {
    await expect(
      getAgentClient().clearConversation(makeRoom()),
    ).resolves.toBeUndefined();
  });
});
