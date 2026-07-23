/**
 * Exercises the connection-proof coordinator under overlapping refresh,
 * deletion, failure, topology, and runtime replacement races.
 */
import { type AgentRuntime, stringToUuid, type UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  assertConversationConnectionRuntime,
  captureConversationConnectionDescriptor,
  hasReadyConversationConnection,
  invalidateConversationConnectionTopology,
  prepareConversationConnectionRoom,
  scheduleConversationConnectionEnsure,
  serializeConversationConnectionRoomDeletion,
} from "../conversation-connection-readiness.ts";

function createRuntime(name = "Readiness Agent"): AgentRuntime {
  return {
    agentId: stringToUuid(`readiness-runtime-${name}`),
    character: { name },
  } as unknown as AgentRuntime;
}

function captureDescriptor(
  runtime: AgentRuntime,
  input: {
    conversationId?: string;
    roomSeed?: string;
    agentName?: string;
    callerSeed?: string;
    callerRole?: "OWNER" | "USER" | "GUEST";
    ownerSeed?: string;
  } = {},
) {
  const agentName = input.agentName ?? runtime.character.name ?? "Eliza";
  const conversationId = input.conversationId ?? "conversation-1";
  return captureConversationConnectionDescriptor({
    runtime,
    conversationId,
    roomId: stringToUuid(input.roomSeed ?? "readiness-room") as UUID,
    agentName,
    worldId: stringToUuid(`${agentName}-world`) as UUID,
    messageServerId: stringToUuid(`${agentName}-server`) as UUID,
    channelId: `web-conv-${conversationId}`,
    ownerId: stringToUuid(input.ownerSeed ?? "readiness-owner") as UUID,
    callerEntityId: stringToUuid(
      input.callerSeed ?? "readiness-caller",
    ) as UUID,
    callerRole: input.callerRole ?? "USER",
    callerUserName: input.callerSeed ?? "readiness-caller",
  });
}

function deferred() {
  let resolve: (() => void) | undefined;
  let reject: ((reason: unknown) => void) | undefined;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {
    promise,
    resolve: () => resolve?.(),
    reject: (reason: unknown) => reject?.(reason),
  };
}

describe("conversation connection readiness", () => {
  it("coalesces identical in-flight refreshes", async () => {
    const runtime = createRuntime();
    const descriptor = captureDescriptor(runtime);
    const gate = deferred();
    const ensure = vi.fn(async () => gate.promise);

    const first = scheduleConversationConnectionEnsure(descriptor, ensure);
    const second = scheduleConversationConnectionEnsure(descriptor, ensure);

    expect(second).toBe(first);
    await vi.waitFor(() => expect(ensure).toHaveBeenCalledTimes(1));
    gate.resolve();
    await Promise.all([first, second]);

    expect(ensure).toHaveBeenCalledTimes(1);
    expect(hasReadyConversationConnection(descriptor)).toBe(true);
  });

  it("serializes overlapping role reconciliation for the shared world", async () => {
    const runtime = createRuntime();
    const firstDescriptor = captureDescriptor(runtime, {
      callerSeed: "readiness-user",
      callerRole: "USER",
    });
    const secondDescriptor = captureDescriptor(runtime, {
      callerSeed: "readiness-guest",
      callerRole: "GUEST",
    });
    const firstGate = deferred();
    const starts: string[] = [];
    let active = 0;
    let maximumActive = 0;

    const first = scheduleConversationConnectionEnsure(
      firstDescriptor,
      async () => {
        starts.push("user");
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await firstGate.promise;
        active -= 1;
      },
    );
    const second = scheduleConversationConnectionEnsure(
      secondDescriptor,
      async () => {
        starts.push("guest");
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        active -= 1;
      },
    );

    await vi.waitFor(() => expect(starts).toEqual(["user"]));
    expect(active).toBe(1);
    firstGate.resolve();
    await Promise.all([first, second]);

    expect(starts).toEqual(["user", "guest"]);
    expect(maximumActive).toBe(1);
    expect(hasReadyConversationConnection(firstDescriptor)).toBe(true);
    expect(hasReadyConversationConnection(secondDescriptor)).toBe(true);
  });

  it("does not let an older role proof revive after the same caller is reconciled", async () => {
    const runtime = createRuntime();
    const userDescriptor = captureDescriptor(runtime, {
      callerRole: "USER",
    });
    await scheduleConversationConnectionEnsure(userDescriptor, async () => {});
    expect(hasReadyConversationConnection(userDescriptor)).toBe(true);

    const guestDescriptor = captureDescriptor(runtime, {
      callerRole: "GUEST",
    });
    expect(hasReadyConversationConnection(guestDescriptor)).toBe(false);
    await scheduleConversationConnectionEnsure(guestDescriptor, async () => {});

    expect(hasReadyConversationConnection(userDescriptor)).toBe(false);
    expect(hasReadyConversationConnection(guestDescriptor)).toBe(true);
    expect(
      hasReadyConversationConnection(
        captureDescriptor(runtime, { callerRole: "USER" }),
      ),
    ).toBe(false);
  });

  it("invalidates the shared topology immediately when its owner changes", async () => {
    const runtime = createRuntime();
    const firstOwner = captureDescriptor(runtime, {
      ownerSeed: "readiness-owner-one",
    });
    await scheduleConversationConnectionEnsure(firstOwner, async () => {});
    expect(hasReadyConversationConnection(firstOwner)).toBe(true);

    const secondOwner = captureDescriptor(runtime, {
      ownerSeed: "readiness-owner-two",
    });
    expect(hasReadyConversationConnection(firstOwner)).toBe(false);
    expect(hasReadyConversationConnection(secondOwner)).toBe(false);
  });

  it("invalidates every proof after a refresh fails", async () => {
    const runtime = createRuntime();
    const descriptor = captureDescriptor(runtime);

    await scheduleConversationConnectionEnsure(descriptor, async () => {});
    expect(hasReadyConversationConnection(descriptor)).toBe(true);

    await expect(
      scheduleConversationConnectionEnsure(descriptor, async () => {
        throw new Error("world role write failed");
      }),
    ).rejects.toMatchObject({
      code: "CONVERSATION_CONNECTION_REFRESH_FAILED",
    });

    const nextDescriptor = captureDescriptor(runtime);
    expect(hasReadyConversationConnection(descriptor)).toBe(false);
    expect(hasReadyConversationConnection(nextDescriptor)).toBe(false);
  });

  it("keeps a late refresh from reviving a deleted room generation", async () => {
    const runtime = createRuntime();
    const descriptor = captureDescriptor(runtime);
    await scheduleConversationConnectionEnsure(descriptor, async () => {});

    const refreshStarted = deferred();
    const refreshGate = deferred();
    const lateRefresh = scheduleConversationConnectionEnsure(
      descriptor,
      async () => {
        refreshStarted.resolve();
        await refreshGate.promise;
      },
    );
    await refreshStarted.promise;

    const deleteRoom = vi.fn(async () => {});
    const deletion = serializeConversationConnectionRoomDeletion(
      runtime,
      descriptor.roomId,
      deleteRoom,
    );
    expect(hasReadyConversationConnection(descriptor)).toBe(false);

    refreshGate.resolve();
    await expect(lateRefresh).rejects.toMatchObject({
      code: "CONVERSATION_CONNECTION_INVALIDATED",
    });
    await deletion;
    expect(deleteRoom).toHaveBeenCalledTimes(1);

    const blockedDescriptor = captureDescriptor(runtime);
    await expect(
      scheduleConversationConnectionEnsure(blockedDescriptor, async () => {}),
    ).rejects.toMatchObject({
      code: "CONVERSATION_CONNECTION_ROOM_BLOCKED",
    });

    prepareConversationConnectionRoom(runtime, descriptor.roomId);
    const recreatedDescriptor = captureDescriptor(runtime);
    await scheduleConversationConnectionEnsure(
      recreatedDescriptor,
      async () => {},
    );
    expect(hasReadyConversationConnection(recreatedDescriptor)).toBe(true);
  });

  it("rejects old-name completion after an in-place topology change", async () => {
    const runtime = createRuntime("Old Name");
    const oldDescriptor = captureDescriptor(runtime);
    await scheduleConversationConnectionEnsure(oldDescriptor, async () => {});

    const refreshStarted = deferred();
    const refreshGate = deferred();
    const oldRefresh = scheduleConversationConnectionEnsure(
      oldDescriptor,
      async () => {
        refreshStarted.resolve();
        await refreshGate.promise;
      },
    );
    await refreshStarted.promise;

    invalidateConversationConnectionTopology(runtime);
    runtime.character.name = "New Name";
    const newDescriptor = captureDescriptor(runtime, {
      agentName: "New Name",
    });
    const newEnsure = vi.fn(async () => {});
    const newRefresh = scheduleConversationConnectionEnsure(
      newDescriptor,
      newEnsure,
    );

    refreshGate.resolve();
    await expect(oldRefresh).rejects.toMatchObject({
      code: "CONVERSATION_CONNECTION_INVALIDATED",
    });
    await newRefresh;

    expect(newEnsure).toHaveBeenCalledTimes(1);
    expect(hasReadyConversationConnection(oldDescriptor)).toBe(false);
    expect(hasReadyConversationConnection(newDescriptor)).toBe(true);
  });

  it("rejects a turn when the route state replaces its exact runtime", () => {
    const originalRuntime = createRuntime("Original Runtime");
    const replacementRuntime = createRuntime("Replacement Runtime");
    const descriptor = captureDescriptor(originalRuntime);

    expect(() =>
      assertConversationConnectionRuntime(replacementRuntime, descriptor),
    ).toThrow(
      expect.objectContaining({ code: "CONVERSATION_RUNTIME_CHANGED" }),
    );
  });
});
