/**
 * Exercises serialized connection reconciliation and descriptor invalidation
 * under overlap, deletion, failure, topology replacement, and bounded tracking.
 */
import { type AgentRuntime, stringToUuid, type UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  assertConversationConnectionRuntime,
  captureConversationConnectionDescriptor,
  invalidateConversationConnectionTopology,
  isConversationConnectionError,
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
  it("coalesces only identical in-flight reconciliation", async () => {
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
    expect(() =>
      assertConversationConnectionRuntime(runtime, descriptor),
    ).not.toThrow();
  });

  it("serializes every caller reconciliation for the shared world", async () => {
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
    firstGate.resolve();
    await Promise.all([first, second]);

    expect(starts).toEqual(["user", "guest"]);
    expect(maximumActive).toBe(1);
    expect(() =>
      assertConversationConnectionRuntime(runtime, firstDescriptor),
    ).not.toThrow();
    expect(() =>
      assertConversationConnectionRuntime(runtime, secondDescriptor),
    ).not.toThrow();
  });

  it("does not cache success across sequential turns", async () => {
    const runtime = createRuntime();
    const descriptor = captureDescriptor(runtime);
    const firstEnsure = vi.fn(async () => {});
    const secondEnsure = vi.fn(async () => {});

    await scheduleConversationConnectionEnsure(descriptor, firstEnsure);
    await scheduleConversationConnectionEnsure(
      captureDescriptor(runtime),
      secondEnsure,
    );

    expect(firstEnsure).toHaveBeenCalledTimes(1);
    expect(secondEnsure).toHaveBeenCalledTimes(1);
  });

  it("invalidates an ensured descriptor immediately when its owner changes", async () => {
    const runtime = createRuntime();
    const firstOwner = captureDescriptor(runtime, {
      ownerSeed: "readiness-owner-one",
    });
    await scheduleConversationConnectionEnsure(firstOwner, async () => {});

    const secondOwner = captureDescriptor(runtime, {
      ownerSeed: "readiness-owner-two",
    });

    expect(() =>
      assertConversationConnectionRuntime(runtime, firstOwner),
    ).toThrow(
      expect.objectContaining({
        code: "CONVERSATION_CONNECTION_INVALIDATED",
      }),
    );
    await scheduleConversationConnectionEnsure(secondOwner, async () => {});
    expect(() =>
      assertConversationConnectionRuntime(runtime, secondOwner),
    ).not.toThrow();
  });

  it("invalidates the descriptor after failure and allows a fresh retry", async () => {
    const runtime = createRuntime();
    const descriptor = captureDescriptor(runtime);

    await expect(
      scheduleConversationConnectionEnsure(descriptor, async () => {
        throw new Error("world role write failed");
      }),
    ).rejects.toMatchObject({
      code: "CONVERSATION_CONNECTION_REFRESH_FAILED",
    });
    expect(() =>
      assertConversationConnectionRuntime(runtime, descriptor),
    ).toThrow(
      expect.objectContaining({
        code: "CONVERSATION_CONNECTION_INVALIDATED",
      }),
    );

    const retryDescriptor = captureDescriptor(runtime);
    const retry = vi.fn(async () => {});
    await scheduleConversationConnectionEnsure(retryDescriptor, retry);

    expect(retry).toHaveBeenCalledTimes(1);
    expect(() =>
      assertConversationConnectionRuntime(runtime, retryDescriptor),
    ).not.toThrow();
  });

  it("times out callers while quarantining the unsettled raw mutation", async () => {
    vi.useFakeTimers();
    try {
      const runtime = createRuntime();
      const descriptor = captureDescriptor(runtime);
      const ensureStarted = deferred();
      const ensureGate = deferred();
      const ensure = vi.fn(async () => {
        ensureStarted.resolve();
        await ensureGate.promise;
      });

      const first = scheduleConversationConnectionEnsure(descriptor, ensure);
      const firstRejection = expect(first).rejects.toMatchObject({
        code: "CONVERSATION_CONNECTION_TIMEOUT",
      });
      await ensureStarted.promise;
      await vi.advanceTimersByTimeAsync(15_000);
      await firstRejection;

      const quarantinedDescriptor = captureDescriptor(runtime);
      const blockedEnsure = vi.fn(async () => {});
      await expect(
        scheduleConversationConnectionEnsure(
          quarantinedDescriptor,
          blockedEnsure,
        ),
      ).rejects.toMatchObject({
        code: "CONVERSATION_CONNECTION_TIMEOUT",
      });
      expect(blockedEnsure).not.toHaveBeenCalled();

      ensureGate.resolve();
      for (let index = 0; index < 5; index += 1) {
        await Promise.resolve();
      }

      const recoveredDescriptor = captureDescriptor(runtime);
      const recoveredEnsure = vi.fn(async () => {});
      await scheduleConversationConnectionEnsure(
        recoveredDescriptor,
        recoveredEnsure,
      );
      expect(recoveredEnsure).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("invalidates ensured and in-flight descriptors across room deletion", async () => {
    const runtime = createRuntime();
    const ensuredDescriptor = captureDescriptor(runtime);
    await scheduleConversationConnectionEnsure(
      ensuredDescriptor,
      async () => {},
    );

    const refreshStarted = deferred();
    const refreshGate = deferred();
    const lateRefresh = scheduleConversationConnectionEnsure(
      ensuredDescriptor,
      async () => {
        refreshStarted.resolve();
        await refreshGate.promise;
      },
    );
    await refreshStarted.promise;

    const deleteRoom = vi.fn(async () => {});
    const deletion = serializeConversationConnectionRoomDeletion(
      runtime,
      ensuredDescriptor.roomId,
      deleteRoom,
    );
    const duringDeletionDescriptor = captureDescriptor(runtime);

    expect(() =>
      assertConversationConnectionRuntime(runtime, ensuredDescriptor),
    ).toThrow();
    await expect(
      scheduleConversationConnectionEnsure(
        duringDeletionDescriptor,
        async () => {},
      ),
    ).rejects.toMatchObject({
      code: "CONVERSATION_CONNECTION_ROOM_BLOCKED",
    });

    refreshGate.resolve();
    await expect(lateRefresh).rejects.toMatchObject({
      code: "CONVERSATION_CONNECTION_INVALIDATED",
    });
    await deletion;

    expect(deleteRoom).toHaveBeenCalledTimes(1);
    expect(() =>
      assertConversationConnectionRuntime(runtime, ensuredDescriptor),
    ).toThrow();
    expect(() =>
      assertConversationConnectionRuntime(runtime, duringDeletionDescriptor),
    ).toThrow();

    const recreatedDescriptor = captureDescriptor(runtime);
    await scheduleConversationConnectionEnsure(
      recreatedDescriptor,
      async () => {},
    );
    expect(() =>
      assertConversationConnectionRuntime(runtime, recreatedDescriptor),
    ).not.toThrow();
  });

  it("rejects an ensured descriptor after an in-place rename", async () => {
    const runtime = createRuntime("Old Name");
    const oldDescriptor = captureDescriptor(runtime);
    await scheduleConversationConnectionEnsure(oldDescriptor, async () => {});

    invalidateConversationConnectionTopology(runtime);
    runtime.character.name = "New Name";
    const newDescriptor = captureDescriptor(runtime, {
      agentName: "New Name",
    });

    expect(() =>
      assertConversationConnectionRuntime(runtime, oldDescriptor),
    ).toThrow(
      expect.objectContaining({
        code: "CONVERSATION_CONNECTION_INVALIDATED",
      }),
    );
    await scheduleConversationConnectionEnsure(newDescriptor, async () => {});
    expect(() =>
      assertConversationConnectionRuntime(runtime, newDescriptor),
    ).not.toThrow();
  });

  it("eviction invalidates old room tokens instead of reviving them", () => {
    const runtime = createRuntime();
    const oldest = captureDescriptor(runtime, { roomSeed: "room-0" });

    for (let index = 1; index <= 2_048; index += 1) {
      captureDescriptor(runtime, { roomSeed: `room-${index}` });
    }

    expect(() => assertConversationConnectionRuntime(runtime, oldest)).toThrow(
      expect.objectContaining({
        code: "CONVERSATION_CONNECTION_INVALIDATED",
      }),
    );
    const recaptured = captureDescriptor(runtime, { roomSeed: "room-0" });
    expect(recaptured.roomGeneration).not.toBe(oldest.roomGeneration);
    expect(() =>
      assertConversationConnectionRuntime(runtime, recaptured),
    ).not.toThrow();
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

  it("accepts exactly the mutation queue capacity and rejects overflow", async () => {
    const runtime = createRuntime();
    const firstGate = deferred();
    const queued = Array.from({ length: 256 }, (_, index) =>
      scheduleConversationConnectionEnsure(
        captureDescriptor(runtime, { conversationId: `queued-${index}` }),
        index === 0 ? async () => firstGate.promise : async () => {},
      ),
    );

    await expect(
      scheduleConversationConnectionEnsure(
        captureDescriptor(runtime, { conversationId: "queue-overflow" }),
        async () => {},
      ),
    ).rejects.toMatchObject({
      code: "CONVERSATION_CONNECTION_QUEUE_SATURATED",
    });

    firstGate.resolve();
    await Promise.all(queued);
  });

  it("prepares a recreated room with a fresh generation", () => {
    const runtime = createRuntime();
    const original = captureDescriptor(runtime);

    prepareConversationConnectionRoom(runtime, original.roomId);

    expect(() =>
      assertConversationConnectionRuntime(runtime, original),
    ).toThrow(
      expect.objectContaining({
        code: "CONVERSATION_CONNECTION_INVALIDATED",
      }),
    );
    const recreated = captureDescriptor(runtime);
    expect(recreated.roomGeneration).not.toBe(original.roomGeneration);
    expect(() =>
      assertConversationConnectionRuntime(runtime, recreated),
    ).not.toThrow();
  });

  it("classifies and preserves connection errors raised during an ensure", async () => {
    const runtime = createRuntime();
    const descriptor = captureDescriptor(runtime);
    let runtimeChangeError: unknown;

    try {
      assertConversationConnectionRuntime(null, descriptor);
    } catch (error) {
      runtimeChangeError = error;
    }

    expect(isConversationConnectionError(runtimeChangeError)).toBe(true);
    expect(isConversationConnectionError(new Error("ordinary failure"))).toBe(
      false,
    );
    expect(
      isConversationConnectionError({
        code: "CONVERSATION_RUNTIME_CHANGED",
      }),
    ).toBe(false);
    await expect(
      scheduleConversationConnectionEnsure(descriptor, async () => {
        throw runtimeChangeError;
      }),
    ).rejects.toBe(runtimeChangeError);
    expect(() =>
      assertConversationConnectionRuntime(runtime, descriptor),
    ).not.toThrow();
  });
});

describe("conversation connection readiness extended coverage", () => {
  type CaptureInput = Parameters<
    typeof captureConversationConnectionDescriptor
  >[0];

  function extendedCaptureInput(
    runtime: AgentRuntime,
    overrides: Partial<CaptureInput> = {},
  ): CaptureInput {
    return {
      runtime,
      conversationId: "extended-conversation",
      roomId: stringToUuid("extended-room") as UUID,
      agentName: "Extended Coverage Agent",
      worldId: stringToUuid("extended-world") as UUID,
      messageServerId: stringToUuid("extended-server") as UUID,
      channelId: "web-conv-extended",
      ownerId: stringToUuid("extended-owner") as UUID,
      callerEntityId: stringToUuid("extended-caller") as UUID,
      callerRole: "USER",
      callerUserName: "extended-caller",
      ...overrides,
    };
  }

  it("captures descriptor identity fields exactly and partitions proofs", () => {
    const runtime = createRuntime("Capture Fidelity Agent");
    const roomId = stringToUuid("fidelity-room") as UUID;
    const descriptor = captureConversationConnectionDescriptor(
      extendedCaptureInput(runtime, { roomId }),
    );

    expect(Object.isFrozen(descriptor)).toBe(true);
    expect(descriptor.runtimeAgentId).toBe(runtime.agentId);
    expect(descriptor.roomId).toBe(roomId);
    expect(descriptor.topologyGeneration).toBe(0);
    expect("requestFence" in descriptor).toBe(false);

    const sameRoomRecapture = captureConversationConnectionDescriptor(
      extendedCaptureInput(runtime, { roomId }),
    );
    expect(sameRoomRecapture.topologyIdentity).toBe(
      descriptor.topologyIdentity,
    );
    expect(sameRoomRecapture.proofIdentity).toBe(descriptor.proofIdentity);
    expect(sameRoomRecapture.roomGeneration).toBe(descriptor.roomGeneration);

    const proofOnlyChange = captureConversationConnectionDescriptor(
      extendedCaptureInput(runtime, { roomId, channelId: "web-conv-other" }),
    );
    expect(proofOnlyChange.topologyIdentity).toBe(descriptor.topologyIdentity);
    expect(proofOnlyChange.topologyGeneration).toBe(
      descriptor.topologyGeneration,
    );
    expect(proofOnlyChange.proofIdentity).not.toBe(descriptor.proofIdentity);

    const otherRoom = captureConversationConnectionDescriptor(
      extendedCaptureInput(runtime, {
        roomId: stringToUuid("fidelity-room-two") as UUID,
      }),
    );
    expect(otherRoom.topologyIdentity).toBe(descriptor.topologyIdentity);
    expect(otherRoom.roomGeneration).not.toBe(descriptor.roomGeneration);
  });

  it("runs the request fence around reconciliation and turn assertion", async () => {
    const runtime = createRuntime("Fence Order Agent");
    const events: string[] = [];
    const descriptor = captureConversationConnectionDescriptor(
      extendedCaptureInput(runtime, {
        requestFence: () => {
          events.push("fence");
        },
      }),
    );
    expect(descriptor.requestFence).toBeDefined();

    await scheduleConversationConnectionEnsure(descriptor, async () => {
      events.push("ensure");
    });

    expect(events).toEqual(["fence", "ensure", "fence"]);

    events.length = 0;
    expect(() =>
      assertConversationConnectionRuntime(runtime, descriptor),
    ).not.toThrow();
    expect(events).toEqual(["fence"]);
  });

  it("propagates a pre-reconciliation fence failure without starting work", async () => {
    const runtime = createRuntime("Fence Abort Agent");
    const fenceError = new Error("request aborted before reconciliation");
    let ensureRan = false;
    const descriptor = captureConversationConnectionDescriptor(
      extendedCaptureInput(runtime, {
        requestFence: () => {
          throw fenceError;
        },
      }),
    );

    await expect(
      scheduleConversationConnectionEnsure(descriptor, async () => {
        ensureRan = true;
      }),
    ).rejects.toBe(fenceError);
    expect(ensureRan).toBe(false);

    let thrown: unknown;
    try {
      assertConversationConnectionRuntime(runtime, descriptor);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(fenceError);
  });

  it("wraps a post-reconciliation fence failure and invalidates siblings", async () => {
    const runtime = createRuntime("Fence Post Agent");
    const fenceError = new Error("request completed out of band");
    let fenceCalls = 0;
    const descriptor = captureConversationConnectionDescriptor(
      extendedCaptureInput(runtime, {
        requestFence: () => {
          fenceCalls += 1;
          if (fenceCalls === 2) {
            throw fenceError;
          }
        },
      }),
    );
    const sibling = captureConversationConnectionDescriptor(
      extendedCaptureInput(runtime, {
        conversationId: "conversation-sibling",
      }),
    );

    await expect(
      scheduleConversationConnectionEnsure(descriptor, async () => {}),
    ).rejects.toMatchObject({
      code: "CONVERSATION_CONNECTION_REFRESH_FAILED",
      cause: fenceError,
    });
    expect(fenceCalls).toBe(2);
    expect(() => assertConversationConnectionRuntime(runtime, sibling)).toThrow(
      expect.objectContaining({
        code: "CONVERSATION_CONNECTION_INVALIDATED",
      }),
    );
  });

  it("wraps non-error rejection reasons and invalidates siblings", async () => {
    const runtime = createRuntime("String Rejection Agent");
    const descriptor = captureDescriptor(runtime, {
      conversationId: "string-rejection",
    });
    const sibling = captureDescriptor(runtime, {
      conversationId: "string-sibling",
    });

    const pending = scheduleConversationConnectionEnsure(
      descriptor,
      async () => {
        throw "plain-text rejection";
      },
    );
    await expect(pending).rejects.toThrow("plain-text rejection");
    await expect(pending).rejects.toMatchObject({
      code: "CONVERSATION_CONNECTION_REFRESH_FAILED",
      cause: "plain-text rejection",
    });
    expect(() => assertConversationConnectionRuntime(runtime, sibling)).toThrow(
      expect.objectContaining({
        code: "CONVERSATION_CONNECTION_INVALIDATED",
      }),
    );
  });

  it("reports invalidation with the original cause when the topology moves mid-flight", async () => {
    const runtime = createRuntime("Midflight Invalidation Agent");
    const descriptor = captureDescriptor(runtime);
    const started = deferred();
    const release = deferred();
    const pending = scheduleConversationConnectionEnsure(
      descriptor,
      async () => {
        started.resolve();
        await release.promise;
        throw new Error("socket reset");
      },
    );

    await started.promise;
    invalidateConversationConnectionTopology(runtime);
    release.resolve();
    await expect(pending).rejects.toMatchObject({
      code: "CONVERSATION_CONNECTION_INVALIDATED",
      cause: expect.objectContaining({ message: "socket reset" }),
    });

    const fresh = captureDescriptor(runtime);
    await scheduleConversationConnectionEnsure(fresh, async () => {});
    expect(() =>
      assertConversationConnectionRuntime(runtime, fresh),
    ).not.toThrow();
  });

  it("keeps the caller pending until the exact mutation deadline", async () => {
    vi.useFakeTimers();
    try {
      const runtime = createRuntime("Deadline Boundary Agent");
      const descriptor = captureDescriptor(runtime);
      const started = deferred();
      const gate = deferred();
      const pending = scheduleConversationConnectionEnsure(
        descriptor,
        async () => {
          started.resolve();
          await gate.promise;
        },
      );

      await started.promise;
      await vi.advanceTimersByTimeAsync(14_999);

      const probe = await Promise.race([
        pending.catch(() => "settled"),
        Promise.resolve("still-pending"),
      ]);
      expect(probe).toBe("still-pending");

      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).rejects.toMatchObject({
        code: "CONVERSATION_CONNECTION_TIMEOUT",
      });
      gate.resolve();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shields a room token from eviction while its reconciliation is in flight", async () => {
    const runtime = createRuntime("Eviction Shield Agent");
    const guarded = captureDescriptor(runtime, {
      roomSeed: "shielded-room",
    });
    const gate = deferred();
    const inflight = scheduleConversationConnectionEnsure(guarded, async () => {
      await gate.promise;
    });

    for (let index = 0; index < 2_048; index += 1) {
      captureDescriptor(runtime, { roomSeed: `shield-churn-${index}` });
    }
    expect(() =>
      assertConversationConnectionRuntime(runtime, guarded),
    ).not.toThrow();

    gate.resolve();
    await inflight;

    for (let index = 0; index < 2_048; index += 1) {
      captureDescriptor(runtime, { roomSeed: `shield-drain-${index}` });
    }
    expect(() => assertConversationConnectionRuntime(runtime, guarded)).toThrow(
      expect.objectContaining({
        code: "CONVERSATION_CONNECTION_INVALIDATED",
      }),
    );
  });

  it("reconciles independent runtimes concurrently and tolerates unseen runtimes", async () => {
    const firstRuntime = createRuntime("Concurrent First");
    const secondRuntime = createRuntime("Concurrent Second");
    let firstActive = false;
    const firstGate = deferred();
    const first = scheduleConversationConnectionEnsure(
      captureDescriptor(firstRuntime, {
        conversationId: "first-runtime-turn",
      }),
      async () => {
        firstActive = true;
        await firstGate.promise;
        firstActive = false;
      },
    );
    const second = scheduleConversationConnectionEnsure(
      captureDescriptor(secondRuntime, {
        conversationId: "second-runtime-turn",
      }),
      async () => {},
    );

    await vi.waitFor(() => expect(firstActive).toBe(true));
    await second;
    expect(firstActive).toBe(true);

    firstGate.resolve();
    await first;
    expect(firstActive).toBe(false);
    expect(() =>
      invalidateConversationConnectionTopology(createRuntime("Never Captured")),
    ).not.toThrow();
  });

  it("rejects stale and deletion-blocked descriptors before starting work", async () => {
    const runtime = createRuntime("Gatekeeper Agent");
    const staleEnsure = vi.fn(async () => {});
    const stale = captureDescriptor(runtime);
    invalidateConversationConnectionTopology(runtime);
    await expect(
      scheduleConversationConnectionEnsure(stale, staleEnsure),
    ).rejects.toMatchObject({
      code: "CONVERSATION_CONNECTION_INVALIDATED",
    });
    expect(staleEnsure).not.toHaveBeenCalled();

    const deletionGate = deferred();
    const deletion = serializeConversationConnectionRoomDeletion(
      runtime,
      stringToUuid("gatekeeper-room") as UUID,
      async () => {
        await deletionGate.promise;
      },
    );
    const blockedEnsure = vi.fn(async () => {});
    const blocked = captureDescriptor(runtime, {
      roomSeed: "gatekeeper-room",
    });
    await expect(
      scheduleConversationConnectionEnsure(blocked, blockedEnsure),
    ).rejects.toMatchObject({
      code: "CONVERSATION_CONNECTION_ROOM_BLOCKED",
    });
    expect(blockedEnsure).not.toHaveBeenCalled();

    deletionGate.resolve();
    await deletion;
  });

  it("lets prepare release a room blocked by an in-flight deletion", async () => {
    const runtime = createRuntime("Prepare Unblock Agent");
    const roomId = stringToUuid("prepare-unblock-room") as UUID;
    const deletionGate = deferred();
    const deletion = serializeConversationConnectionRoomDeletion(
      runtime,
      roomId,
      async () => {
        await deletionGate.promise;
      },
    );

    const revived = captureDescriptor(runtime, {
      roomSeed: "prepare-unblock-room",
    });
    prepareConversationConnectionRoom(runtime, roomId);

    deletionGate.resolve();
    await deletion;
    await expect(
      scheduleConversationConnectionEnsure(revived, async () => {}),
    ).rejects.toMatchObject({
      code: "CONVERSATION_CONNECTION_INVALIDATED",
    });

    const postDeletion = captureDescriptor(runtime, {
      roomSeed: "prepare-unblock-room",
    });
    await scheduleConversationConnectionEnsure(postDeletion, async () => {});
    expect(() =>
      assertConversationConnectionRuntime(runtime, postDeletion),
    ).not.toThrow();
  });

  it("releases a deletion room block when the queue refuses the deletion", async () => {
    const runtime = createRuntime("Saturated Deletion Agent");
    const headGate = deferred();
    const queued = Array.from({ length: 256 }, (_, index) =>
      scheduleConversationConnectionEnsure(
        captureDescriptor(runtime, { conversationId: `bulk-${index}` }),
        index === 0
          ? async () => {
              await headGate.promise;
            }
          : async () => {},
      ),
    );

    await expect(
      serializeConversationConnectionRoomDeletion(
        runtime,
        stringToUuid("saturated-deletion-room") as UUID,
        async () => {},
      ),
    ).rejects.toMatchObject({
      code: "CONVERSATION_CONNECTION_QUEUE_SATURATED",
    });

    headGate.resolve();
    await Promise.all(queued);

    const recovered = captureDescriptor(runtime, {
      roomSeed: "saturated-deletion-room",
    });
    await scheduleConversationConnectionEnsure(recovered, async () => {});
    expect(() =>
      assertConversationConnectionRuntime(runtime, recovered),
    ).not.toThrow();
  });

  it("recognizes every connection error code and rejects impostors", async () => {
    const { ElizaError } = await import("@elizaos/core");
    const codes = [
      "CONVERSATION_CONNECTION_INVALIDATED",
      "CONVERSATION_CONNECTION_QUEUE_SATURATED",
      "CONVERSATION_CONNECTION_REFRESH_FAILED",
      "CONVERSATION_CONNECTION_ROOM_BLOCKED",
      "CONVERSATION_CONNECTION_TIMEOUT",
      "CONVERSATION_RUNTIME_CHANGED",
    ];
    for (const code of codes) {
      expect(
        isConversationConnectionError(
          new ElizaError(`synthetic ${code}`, { code }),
        ),
      ).toBe(true);
    }
    expect(
      isConversationConnectionError(
        new ElizaError("unclassified", { code: "UNRELATED_CODE" }),
      ),
    ).toBe(false);
    expect(isConversationConnectionError(null)).toBe(false);
    expect(isConversationConnectionError(undefined)).toBe(false);
  });
});
