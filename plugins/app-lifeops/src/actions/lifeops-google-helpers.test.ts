import type { IAgentRuntime, Memory } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { hasOwnerAccessMock } = vi.hoisted(() => ({
  hasOwnerAccessMock: vi.fn(async () => true),
}));

vi.mock("@elizaos/agent/security/access", () => ({
  hasOwnerAccess: hasOwnerAccessMock,
}));

let hasLifeOpsAccess: typeof import("./lifeops-google-helpers.js").hasLifeOpsAccess;

describe("hasLifeOpsAccess", () => {
  beforeEach(async () => {
    vi.resetModules();
    hasOwnerAccessMock.mockReset();
    hasOwnerAccessMock.mockResolvedValue(true);
    ({ hasLifeOpsAccess } = await import("./lifeops-google-helpers.js"));
  });

  it("denies messages without a concrete sender", async () => {
    const allowed = await hasLifeOpsAccess(
      { agentId: "agent-id" } as IAgentRuntime,
      { content: { text: "show my inbox" } } as Memory,
    );

    expect(allowed).toBe(false);
    expect(hasOwnerAccessMock).not.toHaveBeenCalled();
  });

  it("delegates concrete senders to the owner-only access check", async () => {
    const runtime = { agentId: "agent-id" } as IAgentRuntime;
    const message = {
      entityId: "owner-id",
      content: { text: "show my inbox" },
    } as Memory;

    await expect(hasLifeOpsAccess(runtime, message)).resolves.toBe(true);
    expect(hasOwnerAccessMock).toHaveBeenCalledWith(runtime, message);
  });

  it("rejects concrete non-owner senders", async () => {
    hasOwnerAccessMock.mockResolvedValue(false);

    await expect(
      hasLifeOpsAccess(
        { agentId: "agent-id" } as IAgentRuntime,
        {
          entityId: "not-owner-id",
          content: { text: "show my inbox" },
        } as Memory,
      ),
    ).resolves.toBe(false);
  });
});
