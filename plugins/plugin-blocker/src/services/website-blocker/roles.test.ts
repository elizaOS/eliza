import { checkSenderRole as coreCheckSenderRole } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkSenderRole } from "./roles.js";

vi.mock("@elizaos/core", () => ({
  checkSenderRole: vi.fn(),
}));

function makeMessage(overrides: Record<string, unknown> = {}) {
  return {
    roomId: "room-7",
    entityId: "entity-9",
    content: { text: "hi" },
    ...overrides,
  };
}

describe("checkSenderRole (selfcontrol)", () => {
  beforeEach(() => {
    vi.mocked(coreCheckSenderRole).mockReset();
  });

  it("throws a descriptive error when the core check returns null (fail closed)", async () => {
    vi.mocked(coreCheckSenderRole).mockResolvedValue(null);
    const message = makeMessage();
    await expect(
      checkSenderRole({ agentId: "agent-1" } as never, message as never),
    ).rejects.toThrow(/checkSenderRole returned null/);
    await expect(
      checkSenderRole({ agentId: "agent-1" } as never, message as never),
    ).rejects.toThrow(/roomId=room-7/);
    await expect(
      checkSenderRole({ agentId: "agent-1" } as never, message as never),
    ).rejects.toThrow(/entityId=entity-9/);
    await expect(
      checkSenderRole({ agentId: "agent-1" } as never, message as never),
    ).rejects.toThrow(/agentId=agent-1/);
  });

  it("throws when the core check returns undefined", async () => {
    vi.mocked(coreCheckSenderRole).mockResolvedValue(undefined);
    await expect(
      checkSenderRole({ agentId: "agent-2" } as never, makeMessage() as never),
    ).rejects.toThrow(/checkSenderRole returned null/);
  });

  it("passes the runtime and message through to the core check", async () => {
    vi.mocked(coreCheckSenderRole).mockResolvedValue({ role: "admin" });
    const runtime = { agentId: "agent-3" };
    const message = makeMessage({ roomId: "room-11" });
    const result = await checkSenderRole(runtime as never, message as never);
    expect(result).toEqual({ role: "admin" });
    expect(coreCheckSenderRole).toHaveBeenCalledWith(runtime, message);
  });

  it("forwards core failures unchanged", async () => {
    const err = new Error("core exploded");
    vi.mocked(coreCheckSenderRole).mockRejectedValue(err);
    await expect(
      checkSenderRole({ agentId: "agent-4" } as never, makeMessage() as never),
    ).rejects.toThrow("core exploded");
  });
});
