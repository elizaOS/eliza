import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveCanonicalOwnerId: vi.fn(),
  stringToUuid: vi.fn((s: string) => `uuid(${s})`),
  logger: { debug: vi.fn(), warn: vi.fn() },
}));

vi.mock("@elizaos/core", () => ({
  resolveCanonicalOwnerId: (...a: unknown[]) =>
    mocks.resolveCanonicalOwnerId(...a),
  stringToUuid: (...a: unknown[]) => mocks.stringToUuid(...a),
  logger: mocks.logger,
}));

import {
  resolveFallbackOwnerEntityId,
  resolveOwnerEntityId,
} from "./owner-entity.ts";

describe("resolveFallbackOwnerEntityId", () => {
  it("derives a synthetic id from the character name", () => {
    const runtime = {
      agentId: "agent-1",
      character: { name: "Alice" },
    } as never;
    expect(resolveFallbackOwnerEntityId(runtime)).toBe(
      "uuid(Alice-admin-entity)",
    );
  });

  it("falls back to agentId when the name is blank", () => {
    const runtime = { agentId: "agent-1", character: { name: "  " } } as never;
    expect(resolveFallbackOwnerEntityId(runtime)).toBe(
      "uuid(agent-1-admin-entity)",
    );
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
    expect(await resolveOwnerEntityId(runtime)).toBe("uuid(Bob-admin-entity)");
  });
});
