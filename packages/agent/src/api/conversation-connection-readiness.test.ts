/**
 * Unit tests for web conversation connection readiness and topology serialization.
 */

import { type AgentRuntime, ElizaError, type UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  assertConversationConnectionRuntime,
  captureConversationConnectionDescriptor,
  invalidateConversationConnectionTopology,
  isConversationConnectionError,
  prepareConversationConnectionRoom,
  scheduleConversationConnectionEnsure,
  serializeConversationConnectionRoomDeletion,
} from "./conversation-connection-readiness.js";

function makeMockRuntime(
  agentId = "00000000-0000-0000-0000-000000000001" as UUID,
): AgentRuntime {
  return {
    agentId,
  } as unknown as AgentRuntime;
}

function makeDescriptorInput(
  runtime: AgentRuntime,
  roomId = "11111111-1111-1111-1111-111111111111" as UUID,
) {
  return {
    runtime,
    conversationId: "conv-1",
    roomId,
    agentName: "Agent One",
    worldId: "22222222-2222-2222-2222-222222222222" as UUID,
    messageServerId: "33333333-3333-3333-3333-333333333333" as UUID,
    channelId: "channel-1",
    ownerId: "44444444-4444-4444-4444-444444444444" as UUID,
    callerEntityId: "55555555-5555-5555-5555-555555555555" as UUID,
    callerRole: "owner" as const,
    callerUserName: "Alice",
  };
}

describe("conversation connection readiness", () => {
  it("captures descriptor and detects runtime mismatch", () => {
    const runtimeA = makeMockRuntime();
    const runtimeB = makeMockRuntime(
      "00000000-0000-0000-0000-000000000002" as UUID,
    );
    const descriptor = captureConversationConnectionDescriptor(
      makeDescriptorInput(runtimeA),
    );

    expect(descriptor.runtimeAgentId).toBe(runtimeA.agentId);
    expect(descriptor.conversationId).toBe("conv-1");

    // Same runtime asserts cleanly
    expect(() =>
      assertConversationConnectionRuntime(runtimeA, descriptor),
    ).not.toThrow();

    // Mismatched runtime throws CONVERSATION_RUNTIME_CHANGED
    expect(() =>
      assertConversationConnectionRuntime(runtimeB, descriptor),
    ).toThrowError(/Conversation runtime changed/);
  });

  it("coalesces concurrent ensures for identical descriptor proof identity", async () => {
    const runtime = makeMockRuntime();
    const descriptor = captureConversationConnectionDescriptor(
      makeDescriptorInput(runtime),
    );

    let executions = 0;
    const ensureFn = vi.fn(async () => {
      executions += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    const [res1, res2] = await Promise.all([
      scheduleConversationConnectionEnsure(descriptor, ensureFn),
      scheduleConversationConnectionEnsure(descriptor, ensureFn),
    ]);

    expect(res1).toBeUndefined();
    expect(res2).toBeUndefined();
    expect(executions).toBe(1);
    expect(ensureFn).toHaveBeenCalledTimes(1);
  });

  it("invalidates descriptors when topology changes or room is prepared", () => {
    const runtime = makeMockRuntime();
    const descriptor = captureConversationConnectionDescriptor(
      makeDescriptorInput(runtime),
    );

    invalidateConversationConnectionTopology(runtime);

    try {
      assertConversationConnectionRuntime(runtime, descriptor);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ElizaError);
      expect((err as ElizaError).code).toBe(
        "CONVERSATION_CONNECTION_INVALIDATED",
      );
    }
  });

  it("serializes room deletion and blocks invalid descriptors", async () => {
    const runtime = makeMockRuntime();
    const roomId = "66666666-6666-6666-6666-666666666666" as UUID;
    const descriptor = captureConversationConnectionDescriptor(
      makeDescriptorInput(runtime, roomId),
    );

    let deleted = false;
    await serializeConversationConnectionRoomDeletion(
      runtime,
      roomId,
      async () => {
        deleted = true;
      },
    );

    expect(deleted).toBe(true);

    // Old descriptor is now invalidated because room generation changed
    try {
      assertConversationConnectionRuntime(runtime, descriptor);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ElizaError);
      expect((err as ElizaError).code).toBe(
        "CONVERSATION_CONNECTION_INVALIDATED",
      );
    }

    // Preparing the room again gives it a fresh generation
    prepareConversationConnectionRoom(runtime, roomId);
    const freshDescriptor = captureConversationConnectionDescriptor(
      makeDescriptorInput(runtime, roomId),
    );
    expect(() =>
      assertConversationConnectionRuntime(runtime, freshDescriptor),
    ).not.toThrow();
  });

  it("identifies conversation connection ElizaErrors correctly", () => {
    const connectionErr = new ElizaError("Room blocked", {
      code: "CONVERSATION_CONNECTION_ROOM_BLOCKED",
    });
    const genericErr = new ElizaError("Something else", {
      code: "GENERIC_ERROR",
    });

    expect(isConversationConnectionError(connectionErr)).toBe(true);
    expect(isConversationConnectionError(genericErr)).toBe(false);
    expect(isConversationConnectionError(new Error("plain error"))).toBe(false);
  });
});
