/**
 * Exercises mandatory request memory scope through real SQLite and AgentRuntime.
 * Fixtures supply verified authority; enrollment and session verification belong
 * to the host suite. No storage, ranking, or runtime read implementation is mocked.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AccessContext,
  AgentRuntime,
  createCharacter,
  type Memory,
  stringToUuid,
  withRequiredMemoryAccess,
} from "@elizaos/core";
import { expect, it } from "vitest";
import { SQLiteDatabaseAdapter } from "./adapter";

it("scopes omitted contexts before ranking, counts and point reads and isolates concurrent requests", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eliza-required-memory-"));
  const agentId = stringToUuid("required-memory-agent");
  const alice = stringToUuid("required-memory-alice");
  const bob = stringToUuid("required-memory-bob");
  const roomA = stringToUuid("required-memory-room-a");
  const roomB = stringToUuid("required-memory-room-b");
  const worldId = stringToUuid("required-memory-world");
  const adapter = SQLiteDatabaseAdapter.create(
    join(directory, "agent.sqlite"),
    agentId,
  );
  await adapter.initialize();
  const runtime = new AgentRuntime({
    agentId,
    adapter,
    character: createCharacter({ name: "Required memory" }),
    plugins: [],
    enableAutonomy: false,
    logLevel: "fatal",
  });
  const allowed: Memory = {
    id: stringToUuid("allowed"),
    agentId,
    entityId: alice,
    roomId: roomA,
    worldId,
    createdAt: 1,
    content: { text: `needle ${"complete authorized context ".repeat(5000)}` },
    embedding: [0.9, 0.1, 0],
    metadata: { scope: "user-private" },
  };
  const foreign: Memory = {
    id: stringToUuid("foreign"),
    agentId,
    entityId: bob,
    roomId: roomB,
    worldId,
    createdAt: 3,
    content: { text: "needle bob confidential context" },
    embedding: [1, 0, 0],
    metadata: { scope: "user-private" },
  };
  const sameRoomPrivate: Memory = {
    ...foreign,
    id: stringToUuid("same-room-private"),
    roomId: roomA,
    createdAt: 2,
  };
  const ownerOnly: Memory = {
    ...foreign,
    id: stringToUuid("owner-only"),
    roomId: roomA,
    metadata: { scope: "owner-private" },
  };
  const scope = {
    requesterEntityId: alice,
    role: "USER",
    authorizedRoomIds: [roomA],
  } satisfies AccessContext;
  let live = true;
  const authority = {
    context: scope,
    authorize: async () => {
      if (!live) throw new Error("Fixture grant revoked");
    },
  };
  try {
    await runtime.initialize();
    await adapter.ensureEmbeddingDimension(3);
    await adapter.createMemories(
      [allowed, foreign, sameRoomPrivate, ownerOnly].map((memory) => ({
        memory,
        tableName: "messages",
      })),
    );
    await withRequiredMemoryAccess(runtime, authority, async () => {
      expect(
        (await runtime.getMemories({ tableName: "messages", limit: 1 }))[0]
          .content.text,
      ).toBe(allowed.content.text);
      expect(
        (
          await runtime.searchMemories({
            tableName: "messages",
            embedding: [1, 0, 0],
            limit: 1,
          })
        )[0].id,
      ).toBe(allowed.id);
      expect(
        (
          await runtime.searchMessages({
            roomIds: [roomA, roomB],
            query: "needle",
            limit: 1,
          })
        )[0].memory.id,
      ).toBe(allowed.id);
      expect(await runtime.countMemories({ tableName: "messages" })).toBe(1);
      if (!allowed.id || !foreign.id)
        throw new Error("Fixture identity missing");
      expect(
        (await runtime.getMemoriesByIds([foreign.id, allowed.id])).map(
          (memory) => memory.id,
        ),
      ).toEqual([allowed.id]);
      expect(await runtime.getMemoryById(foreign.id)).toBeNull();
      expect(
        (
          await adapter.getMemoriesByWorldId({
            worldIds: [worldId],
            tableName: "messages",
            limit: 1,
          })
        ).map((memory) => memory.id),
      ).toEqual([allowed.id]);
      expect(
        (
          await runtime.getMemories({
            tableName: "messages",
            accessContext: {
              ...scope,
              isOwner: true,
              role: "OWNER",
              authorizedRoomIds: [roomA, roomB],
            },
          })
        ).map((memory) => memory.id),
      ).toEqual([allowed.id]);
      await expect(
        runtime.getMemories({
          tableName: "messages",
          accessContext: { ...scope, requesterEntityId: agentId },
        }),
      ).rejects.toMatchObject({ code: "MEMORY_ACCESS_ACTOR_MISMATCH" });
      await withRequiredMemoryAccess(
        runtime,
        { ...authority, context: { ...scope, authorizedRoomIds: [] } },
        async () => {
          expect(await runtime.getMemories({ tableName: "messages" })).toEqual(
            [],
          );
        },
      );
    });
    let detached: Promise<Memory[]> | undefined;
    let releaseDetached: (() => void) | undefined;
    const detachedGate = new Promise<void>((resolve) => {
      releaseDetached = resolve;
    });
    await withRequiredMemoryAccess(runtime, authority, async () => {
      detached = detachedGate.then(() =>
        runtime.getMemories({ tableName: "messages" }),
      );
    });
    if (!detached || !releaseDetached)
      throw new Error("Detached fixture did not initialize");
    const detachedRejected = expect(detached).rejects.toMatchObject({
      code: "MEMORY_ACCESS_SCOPE_CLOSED",
    });
    releaseDetached();
    await detachedRejected;
    let unsupportedExecuted = false;
    await expect(
      withRequiredMemoryAccess(
        { agentId, adapter: {} },
        authority,
        async () => {
          unsupportedExecuted = true;
          return runtime.getMemories({ tableName: "messages" });
        },
      ),
    ).rejects.toMatchObject({ code: "MEMORY_ACCESS_ADAPTER_UNSUPPORTED" });
    expect(unsupportedExecuted).toBe(false);
    const providerName = "REQUIRED_SCOPE_FIXTURE";
    runtime.registerProvider({
      name: providerName,
      get: async (providerRuntime) => ({
        text: (await providerRuntime.getMemories({ tableName: "messages" }))
          .map((memory) => memory.content.text)
          .join("\n"),
      }),
    });
    const compositionMessage: Memory = {
      ...allowed,
      id: stringToUuid("composition-same-message"),
      content: { text: "Compose authorized memory" },
    };
    // Warm the ordinary cache, then reuse the same message across two actors.
    const ordinaryState = await runtime.composeState(
      compositionMessage,
      [providerName],
      true,
    );
    expect(ordinaryState.text).toContain("needle");
    const [aliceState, bobState] = await Promise.all([
      withRequiredMemoryAccess(runtime, authority, () =>
        runtime.composeState(compositionMessage, [providerName], true),
      ),
      withRequiredMemoryAccess(
        runtime,
        {
          ...authority,
          context: {
            requesterEntityId: bob,
            role: "USER",
            authorizedRoomIds: [roomB],
          },
        },
        () => runtime.composeState(compositionMessage, [providerName], true),
      ),
    ]);
    expect(aliceState.text).toContain(allowed.content.text);
    expect(aliceState.text).not.toContain(foreign.content.text);
    expect(bobState.text).not.toContain(allowed.content.text);
    expect(bobState.text).toContain(foreign.content.text);
    if (!compositionMessage.id) throw new Error("Composition identity missing");
    expect(runtime.stateCache.get(compositionMessage.id)).toBe(ordinaryState);
    const [aliceRows, bobRows] = await Promise.all([
      withRequiredMemoryAccess(runtime, authority, () =>
        runtime.getMemories({ tableName: "messages" }),
      ),
      withRequiredMemoryAccess(
        runtime,
        {
          ...authority,
          context: {
            requesterEntityId: bob,
            role: "USER",
            authorizedRoomIds: [roomB],
          },
        },
        () => runtime.getMemories({ tableName: "messages" }),
      ),
    ]);
    expect(aliceRows.map((memory) => memory.id)).toEqual([allowed.id]);
    expect(bobRows.map((memory) => memory.id)).toEqual([foreign.id]);
    await withRequiredMemoryAccess(runtime, authority, async () => {
      live = false;
      await expect(
        runtime.getMemories({ tableName: "messages" }),
      ).rejects.toMatchObject({ code: "MEMORY_ACCESS_AUTHORITY_REJECTED" });
      live = true;
      await expect(
        runtime.getMemories({ tableName: "messages" }),
      ).rejects.toMatchObject({ code: "MEMORY_ACCESS_SCOPE_CLOSED" });
    });
    expect(await runtime.countMemories({ tableName: "messages" })).toBe(4);
  } finally {
    await runtime.stop();
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
