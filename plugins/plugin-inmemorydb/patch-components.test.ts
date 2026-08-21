/** Exercises component patching through the real Map-backed adapter and rejects paths that could reach object prototypes. */

import type { Component, UUID } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryDatabaseAdapter } from "./adapter";
import { MemoryStorage } from "./storage-memory";

const agentId = "00000000-0000-0000-0000-000000000001" as UUID;
const componentId = "40000000-0000-0000-0000-000000000001" as UUID;

describe("plugin-inmemorydb component patches", () => {
  let adapter: InMemoryDatabaseAdapter;

  beforeEach(async () => {
    adapter = new InMemoryDatabaseAdapter(new MemoryStorage(), agentId);
    await adapter.initialize();
    await adapter.createComponents([
      {
        id: componentId,
        entityId: "10000000-0000-0000-0000-000000000001" as UUID,
        agentId,
        roomId: "20000000-0000-0000-0000-000000000001" as UUID,
        worldId: "30000000-0000-0000-0000-000000000001" as UUID,
        sourceEntityId: "10000000-0000-0000-0000-000000000001" as UUID,
        type: "profile",
        data: {},
        createdAt: 1,
      } satisfies Component,
    ]);
  });

  afterEach(async () => {
    await adapter.close();
  });

  it("applies a valid nested patch", async () => {
    await adapter.patchComponents([
      { componentId, ops: [{ op: "set", path: "profile.enabled", value: true }] },
    ]);

    const [component] = await adapter.getComponentsByIds([componentId]);
    expect(component.data).toEqual({ profile: { enabled: true } });
  });

  it.each(["__proto__.polluted", "constructor.prototype.polluted"])(
    "rejects the unsafe path %s",
    async (path) => {
      await expect(
        adapter.patchComponents([{ componentId, ops: [{ op: "set", path, value: true }] }])
      ).rejects.toThrow("patch path is invalid");
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    }
  );
});
