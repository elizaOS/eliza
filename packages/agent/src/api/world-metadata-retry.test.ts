/**
 * Unit tests for updateWorldMetadataWithRetry against a fake world store whose
 * compare-and-swap rejects a stale revision; no database or runtime involved.
 */
import { ElizaError, type UUID, type World } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  updateWorldMetadataWithRetry,
  WORLD_METADATA_WRITE_ATTEMPTS,
} from "./world-metadata-retry";

const WORLD_ID = "00000000-0000-0000-0000-00000000aa01" as UUID;

function staleWrite(): ElizaError {
  return new ElizaError("World metadata write used a stale revision", {
    code: "WORLD_METADATA_STALE_WRITE",
    context: { worldId: WORLD_ID },
  });
}

function fakeStore(options: { staleWrites: number; revisionBumps?: number }) {
  let revision = 0;
  let stored: World = {
    id: WORLD_ID,
    name: "web-chat",
    agentId: "00000000-0000-0000-0000-00000000aa02" as UUID,
    messageServerId: "00000000-0000-0000-0000-00000000aa03" as UUID,
    metadata: { __eliza_world_metadata_revision: 0 },
  } as World;
  let remainingStale = options.staleWrites;
  const getWorld = vi.fn(async () => structuredClone(stored));
  const updateWorld = vi.fn(async (world: World) => {
    if (remainingStale > 0) {
      remainingStale -= 1;
      // A concurrent writer landed first: the stored revision moved on.
      revision += options.revisionBumps ?? 1;
      stored = {
        ...stored,
        metadata: {
          ...stored.metadata,
          __eliza_world_metadata_revision: revision,
        },
      };
      throw staleWrite();
    }
    revision += 1;
    stored = {
      ...world,
      metadata: {
        ...world.metadata,
        __eliza_world_metadata_revision: revision,
      },
    };
  });
  return { getWorld, updateWorld, read: () => stored };
}

describe("updateWorldMetadataWithRetry", () => {
  it("re-reads and re-applies the mutation after a stale-revision conflict", async () => {
    const store = fakeStore({ staleWrites: 1 });
    const result = await updateWorldMetadataWithRetry(
      store,
      WORLD_ID,
      (world) => {
        world.metadata ??= {};
        if ((world.metadata as { ownership?: unknown }).ownership) return false;
        (world.metadata as Record<string, unknown>).ownership = {
          ownerId: "u1",
        };
        return true;
      },
    );
    expect(store.getWorld).toHaveBeenCalledTimes(2);
    expect(store.updateWorld).toHaveBeenCalledTimes(2);
    expect(result?.metadata).toMatchObject({ ownership: { ownerId: "u1" } });
    expect(store.read().metadata).toMatchObject({
      ownership: { ownerId: "u1" },
    });
  });

  it("does not write when the mutation reports no change", async () => {
    const store = fakeStore({ staleWrites: 0 });
    const result = await updateWorldMetadataWithRetry(
      store,
      WORLD_ID,
      () => false,
    );
    expect(store.updateWorld).not.toHaveBeenCalled();
    expect(result?.id).toBe(WORLD_ID);
  });

  it("returns null for a missing world", async () => {
    const store = {
      getWorld: vi.fn(async () => null),
      updateWorld: vi.fn(async () => undefined),
    };
    expect(
      await updateWorldMetadataWithRetry(store, WORLD_ID, () => true),
    ).toBeNull();
    expect(store.updateWorld).not.toHaveBeenCalled();
  });

  it("gives up with the stale-write code after the bounded attempts", async () => {
    const store = fakeStore({ staleWrites: WORLD_METADATA_WRITE_ATTEMPTS + 2 });
    await expect(
      updateWorldMetadataWithRetry(store, WORLD_ID, () => true),
    ).rejects.toMatchObject({ code: "WORLD_METADATA_STALE_WRITE" });
    expect(store.updateWorld).toHaveBeenCalledTimes(
      WORLD_METADATA_WRITE_ATTEMPTS,
    );
  });

  it("propagates any other write failure unchanged", async () => {
    const failure = new Error("connection reset");
    const store = {
      getWorld: vi.fn(async () => ({ id: WORLD_ID, metadata: {} }) as World),
      updateWorld: vi.fn(async () => {
        throw failure;
      }),
    };
    await expect(
      updateWorldMetadataWithRetry(store, WORLD_ID, () => true),
    ).rejects.toBe(failure);
    expect(store.updateWorld).toHaveBeenCalledTimes(1);
  });
});
