/**
 * Delivery-source resolution: a session whose origin source is an internal
 * routing marker (sub_agent / orchestrator) must have its completion delivered
 * through the room's real connector, resolved from the room row. Live
 * regression: "fix app-clarifier deployment" completed but its reply carried
 * source=sub_agent, no conversation matched, and the user never saw the result.
 */

import { describe, expect, it, vi } from "vitest";
import { SubAgentRouter } from "../services/sub-agent-router.js";

function makeRouter(roomSource: string | undefined) {
  const getRoom = vi.fn(async () =>
    roomSource ? { source: roomSource } : undefined,
  );
  const runtime = {
    agentId: "00000000-0000-0000-0000-000000000000",
    getSetting: () => undefined,
    getService: () => undefined,
    getRoom,
  };
  const router = new SubAgentRouter(runtime as never);
  return {
    router: router as unknown as {
      resolveDeliverySource(origin: {
        roomId: string;
        source?: string;
      }): Promise<string | undefined>;
    },
    getRoom,
  };
}

describe("resolveDeliverySource", () => {
  it("passes a real connector source through without a room lookup", async () => {
    const { router, getRoom } = makeRouter("discord");
    const out = await router.resolveDeliverySource({
      roomId: "room-1",
      source: "discord",
    });
    expect(out).toBe("discord");
    expect(getRoom).not.toHaveBeenCalled();
  });

  it("re-resolves an internal marker through the room row (live regression)", async () => {
    const { router } = makeRouter("discord");
    const out = await router.resolveDeliverySource({
      roomId: "room-1",
      source: "sub_agent",
    });
    expect(out).toBe("discord");
  });

  it("resolves a MISSING source through the room row too", async () => {
    const { router } = makeRouter("client_chat");
    const out = await router.resolveDeliverySource({ roomId: "room-1" });
    expect(out).toBe("client_chat");
  });

  it("falls back to the original marker when the room row has no usable source", async () => {
    const { router } = makeRouter(undefined);
    const out = await router.resolveDeliverySource({
      roomId: "room-1",
      source: "sub_agent",
    });
    expect(out).toBe("sub_agent");
  });

  it("memoizes per room after a successful resolution", async () => {
    const { router, getRoom } = makeRouter("discord");
    await router.resolveDeliverySource({
      roomId: "room-1",
      source: "sub_agent",
    });
    await router.resolveDeliverySource({
      roomId: "room-1",
      source: "orchestrator",
    });
    expect(getRoom).toHaveBeenCalledTimes(1);
  });
});
