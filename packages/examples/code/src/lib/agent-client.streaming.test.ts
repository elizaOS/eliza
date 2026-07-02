import { beforeEach, describe, expect, it } from "bun:test";
import {
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type StreamChunkCallback,
  stringToUuid,
} from "@elizaos/core";
import type { ChatRoom } from "../types.js";
import { getAgentClient, resetAgentClient } from "./agent-client.js";
import type { SessionIdentity } from "./identity.js";

interface HandleMessageOptions {
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
  ) => Promise<{ didRespond: boolean; responseMessages: Memory[] }>,
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
      abortSignal: abortController.signal,
      onDelta: (delta) => deltas.push(delta),
    });

    expect(response).toBe("hello");
    expect(deltas).toEqual(["hel", "lo"]);
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
});
