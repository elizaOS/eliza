import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  deterministicOwnerEntityId: vi.fn((agentId: string) => `owner(${agentId})`),
  resolveCanonicalOwnerId: vi.fn((_runtime: unknown): string | null => null),
  logger: { debug: vi.fn(), warn: vi.fn() },
}));

vi.mock("@elizaos/core", () => ({
  deterministicOwnerEntityId: (agentId: string) =>
    mocks.deterministicOwnerEntityId(agentId),
  resolveCanonicalOwnerId: (runtime: unknown) =>
    mocks.resolveCanonicalOwnerId(runtime),
  logger: mocks.logger,
}));

import {
  resolveFallbackOwnerEntityId,
  resolveOwnerEntityId,
} from "../owner-entity.ts";

describe("resolveFallbackOwnerEntityId", () => {
  it("derives a synthetic id from the agent id", () => {
    const runtime = {
      agentId: "agent-1",
      character: { name: "Alice" },
    } as never;
    expect(resolveFallbackOwnerEntityId(runtime)).toBe("owner(agent-1)");
  });

  it("does not let a blank character name change the stable owner id", () => {
    const runtime = { agentId: "agent-1", character: { name: "  " } } as never;
    expect(resolveFallbackOwnerEntityId(runtime)).toBe("owner(agent-1)");
  });
});

describe("resolveOwnerEntityId", () => {
  it("returns the canonical owner id when configured", async () => {
    mocks.resolveCanonicalOwnerId.mockReturnValue("owner-42");
    const runtime = {} as never;
    expect(await resolveOwnerEntityId(runtime)).toBe("owner-42");
  });

  it("resolves owner from world metadata", async () => {
    mocks.resolveCanonicalOwnerId.mockReturnValue(null);
    const runtime = {
      agentId: "a1",
      getRoomsForParticipant: async () => ["room-1"],
      getRoom: async () => ({ worldId: "world-1" }),
      getWorld: async () => ({
        metadata: { ownership: { ownerId: "owner-world" } },
      }),
    } as never;
    expect(await resolveOwnerEntityId(runtime)).toBe("owner-world");
  });

  it("falls back to the synthetic id when nothing matches", async () => {
    mocks.resolveCanonicalOwnerId.mockReturnValue(null);
    const runtime = {
      agentId: "a1",
      character: { name: "Bob" },
      getRoomsForParticipant: async () => [],
    } as never;
    expect(await resolveOwnerEntityId(runtime)).toBe("owner(a1)");
  });
});
