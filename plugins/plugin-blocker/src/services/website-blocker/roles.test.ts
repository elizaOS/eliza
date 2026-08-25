import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkSenderRole } from "./roles";

const mocks = vi.hoisted(() => ({
  coreCheckSenderRole: vi.fn(),
}));

vi.mock("@elizaos/core", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@elizaos/core")>();
  return { ...mod, checkSenderRole: mocks.coreCheckSenderRole };
});

const runtime = {
  agentId: "agent-1",
  roomId: "room-1",
  entityId: "entity-1",
} as never;

const message = {
  roomId: "room-1",
  entityId: "entity-1",
} as never;

describe("checkSenderRole", () => {
  beforeEach(() => {
    mocks.coreCheckSenderRole.mockReset();
  });

  it("returns the core role check result when one is resolved", async () => {
    const roleResult = { role: "admin", allowed: true };
    mocks.coreCheckSenderRole.mockResolvedValue(roleResult);
    await expect(checkSenderRole(runtime, message)).resolves.toBe(roleResult);
    expect(mocks.coreCheckSenderRole).toHaveBeenCalledWith(runtime, message);
  });

  it("throws a descriptive fail-closed error when the core check returns null", async () => {
    mocks.coreCheckSenderRole.mockResolvedValue(null);
    await expect(checkSenderRole(runtime, message)).rejects.toThrow(
      "world/room/entity setup is broken",
    );
  });

  it("includes the room, entity and agent ids in the error", async () => {
    mocks.coreCheckSenderRole.mockResolvedValue(null);
    await expect(checkSenderRole(runtime, message)).rejects.toThrow(
      "roomId=room-1",
    );
    await expect(checkSenderRole(runtime, message)).rejects.toThrow(
      "entityId=entity-1",
    );
    await expect(checkSenderRole(runtime, message)).rejects.toThrow(
      "agentId=agent-1",
    );
  });
});
