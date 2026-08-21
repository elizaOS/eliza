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

  it("rejects oversized and segment-flooded paths before traversal", async () => {
    const longPath = `a${".b".repeat(200)}`;
    const manySegments = Array.from({ length: 17 }, (_, i) => `s${i}`).join(".");
    for (const path of [longPath, manySegments]) {
      await expect(
        adapter.patchComponents([{ componentId, ops: [{ op: "set", path, value: 1 }] }])
      ).rejects.toThrow("patch path is invalid");
    }
  });

  it("ignores inherited arrays and numbers for push and increment", async () => {
    const inheritedTags: unknown[] = ["base"];
    Object.defineProperties(Object.prototype, {
      inheritedPatchTags: { configurable: true, value: inheritedTags },
      inheritedPatchCount: { configurable: true, value: 41 },
    });
    try {
      const [component] = await adapter.getComponentsByIds([componentId]);
      component.data = { profile: {} };
      await adapter.updateComponents([component]);

      await adapter.patchComponents([
        {
          componentId,
          ops: [
            {
              op: "push",
              path: "profile.inheritedPatchTags",
              value: "new",
            },
            {
              op: "increment",
              path: "profile.inheritedPatchCount",
              value: 2,
            },
          ],
        },
      ]);

      const [updated] = await adapter.getComponentsByIds([componentId]);
      expect(updated.data).toEqual({
        profile: { inheritedPatchTags: ["new"], inheritedPatchCount: 2 },
      });
      expect(inheritedTags).toEqual(["base"]);
      expect((Object.prototype as Record<string, unknown>).inheritedPatchCount).toBe(41);
    } finally {
      delete (Object.prototype as Record<string, unknown>).inheritedPatchTags;
      delete (Object.prototype as Record<string, unknown>).inheritedPatchCount;
    }
  });

  it("never invokes an own accessor at a leaf or intermediate segment", async () => {
    let getterCalls = 0;
    const profile: Record<string, unknown> = {};
    Object.defineProperty(profile, "count", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 10;
      },
    });
    const [component] = await adapter.getComponentsByIds([componentId]);
    component.data = { profile };
    await adapter.updateComponents([component]);

    await expect(
      adapter.patchComponents([
        { componentId, ops: [{ op: "increment", path: "profile.count", value: 1 }] },
      ])
    ).rejects.toThrow("patch path is invalid");
    await expect(
      adapter.patchComponents([
        { componentId, ops: [{ op: "set", path: "profile.count.value", value: 1 }] },
      ])
    ).rejects.toThrow("patch path is invalid");
    expect(getterCalls).toBe(0);
  });

  it("does not invoke an overridden array push accessor", async () => {
    let getterCalls = 0;
    const tags: unknown[] = [];
    Object.defineProperty(tags, "push", {
      configurable: true,
      get() {
        getterCalls += 1;
        throw new Error("must not run");
      },
    });
    const [component] = await adapter.getComponentsByIds([componentId]);
    component.data = { tags };
    await adapter.updateComponents([component]);

    await adapter.patchComponents([
      {
        componentId,
        ops: [{ op: "push", path: "tags", value: "new" }],
      },
    ]);

    const [updated] = await adapter.getComponentsByIds([componentId]);
    const updatedTags = updated.data.tags as unknown[];
    expect(updatedTags.length).toBe(1);
    expect(updatedTags[0]).toBe("new");
    expect(getterCalls).toBe(0);
  });

  it("never invokes a root accessor while cloning patch data", async () => {
    let getterCalls = 0;
    const data: Record<string, unknown> = {};
    Object.defineProperty(data, "trap", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "secret";
      },
    });
    const [component] = await adapter.getComponentsByIds([componentId]);
    component.data = data;
    await adapter.updateComponents([component]);

    await expect(
      adapter.patchComponents([
        { componentId, ops: [{ op: "set", path: "safe.value", value: true }] },
      ])
    ).rejects.toThrow("patch path is invalid");
    expect(getterCalls).toBe(0);
  });

  it("rejects delimiter floods and excessive numeric indices", async () => {
    for (const path of [`${"a.".repeat(40)}z`, "items.100001.value"] as const) {
      await expect(
        adapter.patchComponents([{ componentId, ops: [{ op: "set", path, value: true }] }])
      ).rejects.toThrow("patch path is invalid");
    }
  });

  it("rejects unsupported nested prototypes", async () => {
    const [component] = await adapter.getComponentsByIds([componentId]);
    component.data = { profile: new Date() } as Component["data"];
    await adapter.updateComponents([component]);

    await expect(
      adapter.patchComponents([
        { componentId, ops: [{ op: "set", path: "profile.enabled", value: true }] },
      ])
    ).rejects.toThrow("patch path is invalid");
  });
});
