/** Connector settlement must precede assistant extraction and terminal events. */

import {
  type IAgentRuntime,
  type Memory,
  pendingRoomPostDeliveryTaskCount,
  RoomHandlerQueue,
  RunTerminalOwner,
  roomDeliverySettlement,
  type UUID,
  withRoomDeliverySettlement,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

function runtimeStub(roomHandlerQueue: RoomHandlerQueue) {
  return {
    agentId: "00000000-0000-4000-8000-000000000001",
    reportError: vi.fn(),
    roomHandlerQueue,
  };
}
describe("assistant run settlement", () => {
  it("waits for settled connector evidence before extraction and terminal drain", async () => {
    const queue = new RoomHandlerQueue();
    const runtime = {
      ...runtimeStub(queue),
      emitEvent: vi.fn(async () => undefined),
    } as unknown as IAgentRuntime;
    const roomId = "00000000-0000-4000-8000-000000000002" as UUID;
    const message = {
      id: "trigger",
      roomId,
      entityId: runtime.agentId,
      content: { text: "Remember this" },
    } as Memory;
    const order: string[] = [];
    await queue.withLease(roomId, async (lease) => {
      await withRoomDeliverySettlement(runtime, roomId, lease, async () => {
        const owner = new RunTerminalOwner(
          runtime,
          "run" as UUID,
          message,
          Date.now(),
          lease,
        );
        owner.trackAfterDelivery("post_turn", async () => {
          order.push("extraction");
        });
        owner.request("completed");
        await Promise.resolve();
        await Promise.resolve();
        expect(order).toEqual([]);
        expect(runtime.emitEvent).not.toHaveBeenCalled();
        order.push("persist-final-reply", "persist-callback-evidence");
      });
      expect(order).toEqual([
        "persist-final-reply",
        "persist-callback-evidence",
        "extraction",
      ]);
      expect(runtime.emitEvent).toHaveBeenCalledTimes(1);
      expect(pendingRoomPostDeliveryTaskCount(runtime, roomId)).toBe(0);
      expect(queue.ownsLease(roomId, lease)).toBe(true);
    });
  });

  it("cancels extraction without deadlocking terminal drain when connector persistence fails", async () => {
    const queue = new RoomHandlerQueue();
    const runtime = {
      ...runtimeStub(queue),
      emitEvent: vi.fn(async () => undefined),
    } as unknown as IAgentRuntime;
    const roomId = "00000000-0000-4000-8000-000000000002" as UUID;
    const message = {
      id: "trigger",
      roomId,
      entityId: runtime.agentId,
      content: { text: "Remember this" },
    } as Memory;
    const extract = vi.fn(async () => undefined);
    await queue.withLease(roomId, async (lease) => {
      await expect(
        withRoomDeliverySettlement(runtime, roomId, lease, async () => {
          const owner = new RunTerminalOwner(
            runtime,
            "run" as UUID,
            message,
            Date.now(),
            lease,
          );
          owner.trackAfterDelivery("post_turn", extract);
          owner.request("completed");
          throw new Error("delivery persistence failed");
        }),
      ).rejects.toThrow("delivery persistence failed");
      expect(extract).not.toHaveBeenCalled();
      expect(runtime.emitEvent).toHaveBeenCalledTimes(1);
      expect(pendingRoomPostDeliveryTaskCount(runtime, roomId)).toBe(0);
      expect(runtime.reportError).toHaveBeenCalledWith(
        "PostDeliveryTask",
        expect.objectContaining({ code: "POST_DELIVERY_NOT_SETTLED" }),
        expect.anything(),
      );
      await expect(
        roomDeliverySettlement(runtime, roomId, lease),
      ).resolves.toBe(true);
    });
  });
});
