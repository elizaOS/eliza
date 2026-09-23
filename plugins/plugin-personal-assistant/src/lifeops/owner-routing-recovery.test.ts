/** Exercises real owner resolution, LifeOps promise recovery and proactive no-effect ordering with controlled storage failures. */
import type { IAgentRuntime, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { executeProactiveTask } from "../activity-profile/proactive-worker.js";
import { LifeOpsServiceBase } from "./service-mixin-core.js";

const AGENT = "11111111-1111-4111-8111-111111111111" as UUID;
const OWNER = "22222222-2222-4222-8222-222222222222" as UUID;
const ROOM = "33333333-3333-4333-8333-333333333333" as UUID;
const WORLD = "44444444-4444-4444-8444-444444444444" as UUID;
function fixture() {
  const getRoomsForParticipant = vi.fn(async () => [ROOM]);
  const getTasks = vi.fn(async () => []);
  const updateTask = vi.fn();
  const runtime = {
    agentId: AGENT,
    getSetting: () => null,
    getRoomsForParticipant,
    getRoom: async () => ({ id: ROOM, worldId: WORLD }),
    getWorld: async () => ({
      id: WORLD,
      metadata: { ownership: { ownerId: OWNER } },
    }),
    getTasks,
    updateTask,
  } as unknown as IAgentRuntime;
  return { runtime, getRoomsForParticipant, getTasks, updateTask };
}

describe("owner routing recovery", () => {
  it("shares a failed lookup then permits a successful later lookup", async () => {
    const f = fixture();
    const cause = new Error("storage offline");
    let reject!: (cause: Error) => void;
    f.getRoomsForParticipant.mockImplementationOnce(
      () =>
        new Promise<UUID[]>((_resolve, fail) => {
          reject = fail;
        }),
    );
    const service = new LifeOpsServiceBase(f.runtime);
    const first = service.ownerRoutingEntityId();
    const second = service.ownerRoutingEntityId();
    const results = Promise.allSettled([first, second]);
    expect(f.getRoomsForParticipant).toHaveBeenCalledTimes(1);
    reject(cause);
    for (const result of await results) {
      expect(result).toMatchObject({
        status: "rejected",
        reason: {
          code: "LIFEOPS_OWNER_ROUTING_UNAVAILABLE",
          cause: { code: "OWNER_ENTITY_LOOKUP_FAILED", cause },
        },
      });
    }
    await expect(service.ownerRoutingEntityId()).resolves.toBe(OWNER);
    await expect(service.ownerRoutingEntityId()).resolves.toBe(OWNER);
    expect(f.getRoomsForParticipant).toHaveBeenCalledTimes(2);
  });

  it("keeps an explicitly supplied owner independent of failed storage", async () => {
    const f = fixture();
    f.getRoomsForParticipant.mockRejectedValue(new Error("offline"));
    const service = new LifeOpsServiceBase(f.runtime, { ownerEntityId: OWNER });
    await expect(service.ownerRoutingEntityId()).resolves.toBe(OWNER);
    expect(f.getRoomsForParticipant).not.toHaveBeenCalled();
  });

  it("does no proactive work under an uncertain identity and can recover next tick", async () => {
    const f = fixture();
    const cause = new Error("storage offline");
    f.getRoomsForParticipant.mockRejectedValueOnce(cause);
    await expect(executeProactiveTask(f.runtime)).rejects.toMatchObject({
      code: "OWNER_ENTITY_LOOKUP_FAILED",
      cause,
    });
    expect(f.getTasks).not.toHaveBeenCalled();
    expect(f.updateTask).not.toHaveBeenCalled();
    await expect(executeProactiveTask(f.runtime)).resolves.toHaveProperty(
      "nextInterval",
    );
    expect(f.getTasks).toHaveBeenCalledTimes(1);
    expect(f.updateTask).not.toHaveBeenCalled();
  });
});
