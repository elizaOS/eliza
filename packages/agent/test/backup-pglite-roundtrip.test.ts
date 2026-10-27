/** File-backed PGlite snapshot round-trip across independent environments.
 *
 * A snapshot captured from runtime A restores into a separate runtime B that
 * already holds divergent data. A fresh runtime C on B's data directory must
 * then read back A's rows exactly, see none of B's rows, and accept new
 * writes. This covers the snapshot-path row-level round-trip that the
 * capture/restore suites do not: backup-capture-http restores into the same
 * directory and checks only the agents row and state files, and
 * local-backup-v2-restore covers the v2 archive path, not this snapshot
 * path. Real PGlite directories and the real snapshot APIs are used
 * throughout; nothing is mocked.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ChannelType, type Memory, type UUID } from "@elizaos/core";
import type { ElizaConfig } from "@elizaos/host/protocol";
import { createTestRuntime } from "@elizaos/testing/runtime";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  createAgentSnapshot,
  restoreAgentSnapshot,
} from "../src/services/agent-backup.ts";

const CHARACTER_NAME = "Backup pglite roundtrip";
const TIMEOUT = 180_000;

let root: string;
let stateDir: string;
let dirA: string;
let dirB: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "agent-backup-roundtrip-"));
  stateDir = path.join(root, "state");
  dirA = path.join(root, "a", ".elizadb");
  dirB = path.join(root, "b", ".elizadb");
  vi.stubEnv("ELIZA_STATE_DIR", stateDir);
  for (const key of ["POSTGRES_URL", "DATABASE_URL", "ELIZA_CLOUD_PROVISIONED"])
    vi.stubEnv(key, undefined);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
}, TIMEOUT);

async function makeRuntime(pgliteDir: string) {
  vi.stubEnv("PGLITE_DATA_DIR", pgliteDir);
  const fixture = await createTestRuntime({
    // A fixed character name keeps the agentId deterministic (Core version-0
    // UUID), which restore requires: the snapshot must target the same agent.
    characterName: CHARACTER_NAME,
    pgliteDir,
    settings: { LOAD_DOCS_ON_STARTUP: false },
  });
  expect(fixture.runtime.agentId.split("-")[2]?.[0]).toBe("0");
  return fixture;
}

async function seed(
  runtime: Awaited<ReturnType<typeof makeRuntime>>["runtime"],
  prefix: string,
) {
  const worldId = crypto.randomUUID() as UUID;
  const entityId = crypto.randomUUID() as UUID;
  const roomId = crypto.randomUUID() as UUID;
  const memoryId = crypto.randomUUID() as UUID;
  const text = `${prefix} roundtrip memory body`;
  await runtime.createWorld({
    id: worldId,
    agentId: runtime.agentId,
    name: `${prefix} world`,
  });
  await runtime.createEntity({
    id: entityId,
    agentId: runtime.agentId,
    names: [`${prefix} speaker`],
  });
  await runtime.createRoom({
    id: roomId,
    agentId: runtime.agentId,
    source: "test",
    type: ChannelType.GROUP,
    name: `${prefix} room`,
    worldId,
  });
  await runtime.addParticipant(entityId, roomId);
  await runtime.createMemory(
    {
      id: memoryId,
      agentId: runtime.agentId,
      entityId,
      roomId,
      content: { text },
      createdAt: Date.now(),
    } as Memory,
    "memories",
  );
  return { worldId, entityId, roomId, memoryId, text };
}

it(
  "restores A's rows into divergent B and leaves B's rows behind",
  async () => {
    const fixtureA = await makeRuntime(dirA);
    try {
      const a = await seed(fixtureA.runtime, "source");
      const snapshot = await createAgentSnapshot(
        fixtureA.runtime,
        {} as ElizaConfig,
      );
      expect(snapshot.manifest.components.database.kind).toBe("pglite-dump");
      const agentId = fixtureA.runtime.agentId;

      const fixtureB = await makeRuntime(dirB);
      // Declared outside the try so C can still check B's rows after B's
      // cleanup runs; a seed failure skips C entirely via the outer finally.
      let b!: Awaited<ReturnType<typeof seed>>;
      try {
        b = await seed(fixtureB.runtime, "divergent");
        expect(fixtureB.runtime.agentId).toBe(agentId);
        // Restore stops B's runtime and closes its adapter, so B must not be
        // used after this point; C below reopens B's directory.
        const restored = await restoreAgentSnapshot(fixtureB.runtime, snapshot);
        expect(restored).toEqual({ restored: true, requiresRestart: true });
      } finally {
        await fixtureB.cleanup();
      }

      const fixtureC = await makeRuntime(dirB);
      try {
        expect(fixtureC.runtime.agentId).toBe(agentId);
        // 1. A's entity and memory survive with identical ids and content.
        const [entity] = await fixtureC.runtime.getEntitiesByIds([a.entityId]);
        expect(entity?.names).toEqual(["source speaker"]);
        const memories = await fixtureC.runtime.getMemories({
          agentId,
          roomId: a.roomId,
          tableName: "memories",
        });
        expect(memories.map((memory) => memory.id)).toContain(a.memoryId);
        expect(
          memories.find((memory) => memory.id === a.memoryId)?.content.text,
        ).toBe(a.text);
        // 2. World, room, and participant relationships survive.
        const [world] = await fixtureC.runtime.getWorldsByIds([a.worldId]);
        expect(world?.name).toBe("source world");
        const [room] = await fixtureC.runtime.getRoomsByIds([a.roomId]);
        expect(room?.worldId).toBe(a.worldId);
        expect(room?.name).toBe("source room");
        expect(await fixtureC.runtime.getParticipantsForRoom(a.roomId)).toEqual(
          [a.entityId],
        );
        // 3. None of B's divergent rows survive the full directory replacement.
        expect(await fixtureC.runtime.getWorldsByIds([b.worldId])).toEqual([]);
        expect(await fixtureC.runtime.getRoomsByIds([b.roomId])).toEqual([]);
        expect(await fixtureC.runtime.getEntitiesByIds([b.entityId])).toEqual(
          [],
        );
        expect(
          await fixtureC.runtime.getMemories({
            agentId,
            roomId: b.roomId,
            tableName: "memories",
          }),
        ).toEqual([]);
        // B's participant link is gone with its room, not left orphaned.
        expect(await fixtureC.runtime.getParticipantsForRoom(b.roomId)).toEqual(
          [],
        );
        // 4. The restored runtime accepts new writes and reads them back.
        const extra = await seed(fixtureC.runtime, "after-restore");
        expect(
          (
            await fixtureC.runtime.getMemories({
              agentId,
              roomId: extra.roomId,
              tableName: "memories",
            })
          ).map((memory) => memory.id),
        ).toContain(extra.memoryId);
      } finally {
        await fixtureC.cleanup();
      }
    } finally {
      await fixtureA.cleanup();
    }
  },
  TIMEOUT,
);
