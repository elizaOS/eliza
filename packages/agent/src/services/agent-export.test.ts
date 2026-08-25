/**
 * Same-named unit suite for the real `agent-export` public surface.
 *
 * Sibling files already pin password length, media capture/restore, canonicalize
 * walk bounds, and the encrypted backup round-trip. This file covers the
 * remaining exported branches: `AgentExportError` defaults, collection digest
 * and manifest edge cases (empty, single, missing, wrong algorithm), binary
 * unpack rejections, decrypt/decompress/schema/version gates, restore failures,
 * and `estimateExportSize` counting and agent-id filtering. Drives the live
 * module with in-memory adapters and crafted `.eliza-agent` bytes — no mocked
 * return value is re-asserted as the behavior under test.
 */

import * as crypto from "node:crypto";
import { gzipSync } from "node:zlib";
import { type AgentRuntime, ElizaError } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  AGENT_EXPORT_FAILED,
  AgentExportError,
  type AgentExportPayload,
  buildExportManifest,
  digestCollection,
  estimateExportSize,
  exportAgent,
  importAgent,
  MANIFEST_COLLECTIONS,
  type ManifestCollection,
  verifyExportManifest,
} from "./agent-export.ts";

const PASSWORD = "password12ok";
const AGENT_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_ID = "00000000-0000-4000-8000-000000000002";
const MAGIC = Buffer.from("ELIZA_AGENT_V1\n", "utf-8");

function runtimeWith(adapter: object, agentId = AGENT_ID): AgentRuntime {
  return { adapter, agentId } as unknown as AgentRuntime;
}

function payload(overrides: Record<string, unknown> = {}): AgentExportPayload {
  return {
    version: 1,
    exportedAt: "2026-08-23T00:00:00.000Z",
    sourceAgentId: AGENT_ID,
    agent: { name: "Ada" },
    entities: [],
    memories: [],
    components: [],
    rooms: [],
    participants: [],
    relationships: [],
    worlds: [],
    tasks: [],
    logs: [],
    ...overrides,
  } as AgentExportPayload;
}

function packHeader(opts: {
  iterations: number;
  ciphertext?: Buffer;
  magic?: Buffer;
}): Buffer {
  const iterBuf = Buffer.alloc(4);
  iterBuf.writeUInt32BE(opts.iterations, 0);
  return Buffer.concat([
    opts.magic ?? MAGIC,
    iterBuf,
    Buffer.alloc(32),
    Buffer.alloc(12),
    Buffer.alloc(16),
    opts.ciphertext ?? Buffer.alloc(0),
  ]);
}

async function packEncrypted(
  plaintext: Buffer,
  password: string,
  iterations = 1,
): Promise<Buffer> {
  const salt = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const key = await new Promise<Buffer>((resolve, reject) => {
    crypto.pbkdf2(password, salt, iterations, 32, "sha256", (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const iterBuf = Buffer.alloc(4);
  iterBuf.writeUInt32BE(iterations, 0);
  return Buffer.concat([MAGIC, iterBuf, salt, iv, tag, ciphertext]);
}

function gzipJson(value: unknown): Buffer {
  return gzipSync(Buffer.from(JSON.stringify(value), "utf-8"));
}

function restoreAdapter(overrides: Record<string, unknown> = {}) {
  const createdAgents: Array<Record<string, unknown>> = [];
  const adapter = {
    createAgents: async (rows: Array<Record<string, unknown>>) => {
      createdAgents.push(...rows);
      return rows.map((row) => row.id as string);
    },
    createWorlds: async () => undefined,
    createRooms: async () => undefined,
    createEntities: async () => true,
    createRoomParticipants: async () => true,
    updateParticipantUserStates: async () => undefined,
    createComponents: async () => undefined,
    createMemories: async () => undefined,
    createRelationships: async () => true,
    createTasks: async () => undefined,
    createLogs: async () => undefined,
    ...overrides,
  };
  return { adapter, createdAgents };
}

describe("AgentExportError", () => {
  it("defaults code to AGENT_EXPORT_FAILED and remains an ElizaError", () => {
    const err = new AgentExportError("export exploded");
    expect(err).toBeInstanceOf(AgentExportError);
    expect(err).toBeInstanceOf(ElizaError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("AgentExportError");
    expect(err.code).toBe(AGENT_EXPORT_FAILED);
    expect(err.message).toBe("export exploded");
  });

  it("preserves a caller-supplied code, cause, and context", () => {
    const cause = new Error("root");
    const err = new AgentExportError("wrapped", {
      code: "CUSTOM_EXPORT",
      cause,
      context: { agentId: AGENT_ID },
    });
    expect(err.code).toBe("CUSTOM_EXPORT");
    expect(err.cause).toBe(cause);
    expect(err.context).toEqual({ agentId: AGENT_ID });
  });
});

describe("MANIFEST_COLLECTIONS", () => {
  it("lists every restore collection in a stable order", () => {
    expect([...MANIFEST_COLLECTIONS]).toEqual([
      "entities",
      "memories",
      "components",
      "rooms",
      "participants",
      "relationships",
      "worlds",
      "tasks",
      "logs",
      "media",
    ]);
  });
});

describe("digestCollection", () => {
  it("digests an empty array as count 0 with a stable sha256", () => {
    const empty = digestCollection([]);
    expect(empty.count).toBe(0);
    expect(empty.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(digestCollection([])).toEqual(empty);
  });

  it("digests a single element and a two-element list differently", () => {
    const single = digestCollection([{ id: "e1" }]);
    const two = digestCollection([{ id: "e1" }, { id: "e2" }]);
    expect(single.count).toBe(1);
    expect(two.count).toBe(2);
    expect(single.sha256).not.toBe(two.sha256);
    expect(single.sha256).not.toBe(digestCollection([]).sha256);
  });

  it("is independent of object key order inside items", () => {
    expect(digestCollection([{ b: 1, a: 2 }])).toEqual(
      digestCollection([{ a: 2, b: 1 }]),
    );
  });

  it("treats null, a plain object, and a string as an empty collection", () => {
    const empty = digestCollection([]);
    expect(digestCollection(null as unknown as unknown[])).toEqual(empty);
    expect(
      digestCollection({ length: 1, 0: { id: "x" } } as unknown as unknown[]),
    ).toEqual(empty);
    expect(digestCollection("not-an-array" as unknown as unknown[])).toEqual(
      empty,
    );
  });
});

describe("buildExportManifest", () => {
  it("covers every MANIFEST_COLLECTIONS name as empty when fields are missing", () => {
    const manifest = buildExportManifest(
      {} as unknown as Pick<AgentExportPayload, ManifestCollection>,
    );
    expect(manifest.algorithm).toBe("sha256");
    const empty = digestCollection([]);
    for (const name of MANIFEST_COLLECTIONS) {
      expect(manifest.components[name]).toEqual(empty);
    }
  });

  it("digests a single populated collection and leaves the others empty", () => {
    const memories = [{ id: "m1", text: "hi" }];
    const manifest = buildExportManifest({
      memories,
    } as unknown as Pick<AgentExportPayload, ManifestCollection>);
    expect(manifest.components.memories).toEqual(digestCollection(memories));
    expect(manifest.components.entities).toEqual(digestCollection([]));
    expect(manifest.components.media.count).toBe(0);
  });
});

describe("verifyExportManifest remaining branches", () => {
  it("treats a missing algorithm as absent (back-compat OK)", () => {
    const v = verifyExportManifest(
      payload({
        manifest: { components: { memories: { sha256: "abc", count: 1 } } },
      }),
    );
    expect(v).toEqual({ present: false, ok: true, mismatches: [] });
  });

  it("treats a non-sha256 algorithm as absent (back-compat OK)", () => {
    const v = verifyExportManifest(
      payload({
        manifest: { algorithm: "md5", components: {} },
      }),
    );
    expect(v.present).toBe(false);
    expect(v.ok).toBe(true);
    expect(v.mismatches).toEqual([]);
  });

  it("uses an empty digest as expected when a collection is omitted from components", () => {
    const honest = payload({ memories: [{ id: "m1" }] });
    const v = verifyExportManifest(
      payload({
        memories: honest.memories,
        manifest: {
          algorithm: "sha256",
          components: {
            // memories omitted — expected falls back to { sha256: "", count: 0 }
          },
        },
      }),
    );
    expect(v.present).toBe(true);
    expect(v.ok).toBe(false);
    const memories = v.mismatches.find((m) => m.collection === "memories");
    expect(memories?.expected).toEqual({ sha256: "", count: 0 });
    expect(memories?.actual.count).toBe(1);
    expect(memories?.actual.sha256).toBe(
      digestCollection(honest.memories).sha256,
    );
  });
});

describe("estimateExportSize", () => {
  it("returns the 2000-byte base overhead for an empty agent", async () => {
    const adapter = {
      getMemories: async () => [],
      getAllWorlds: async () => [],
      getRoomsForParticipants: async () => [],
      getEntitiesForRooms: async () => {
        throw new Error(
          "getEntitiesForRooms must not run with an empty room list",
        );
      },
      getTasks: async () => [],
    };
    await expect(estimateExportSize(runtimeWith(adapter))).resolves.toEqual({
      estimatedBytes: 2000,
      memoriesCount: 0,
      entitiesCount: 0,
      roomsCount: 0,
      worldsCount: 0,
      tasksCount: 0,
    });
  });

  it("counts a single linked memory/room/entity/world/task", async () => {
    const adapter = {
      getMemories: async ({ tableName }: { tableName: string }) =>
        tableName === "messages" ? [{ id: "m1" }] : [],
      getAllWorlds: async () => [{ id: "w1", agentId: AGENT_ID }],
      getRoomsForParticipants: async () => ["r1"],
      getEntitiesForRooms: async (roomIds: string[]) =>
        roomIds.map(() => ({ entities: [{ id: "e1" }] })),
      getTasks: async () => [{ id: "t1", agentId: AGENT_ID }],
    };
    await expect(estimateExportSize(runtimeWith(adapter))).resolves.toEqual({
      estimatedBytes: 1 * 500 + 1 * 200 + 1 * 300 + 1 * 200 + 1 * 400 + 2000,
      memoriesCount: 1,
      entitiesCount: 1,
      roomsCount: 1,
      worldsCount: 1,
      tasksCount: 1,
    });
  });

  it("sums memories across tables, filters foreign worlds/tasks, and skips entities without ids", async () => {
    const adapter = {
      getMemories: async ({ tableName }: { tableName: string }) => {
        if (tableName === "messages") return [{ id: "m1" }, { id: "m2" }];
        if (tableName === "facts") return [{ id: "m3" }];
        return [];
      },
      getAllWorlds: async () => [
        { id: "w-own", agentId: AGENT_ID },
        { id: "w-other", agentId: OTHER_ID },
      ],
      getRoomsForParticipants: async () => ["r1", "r2"],
      getEntitiesForRooms: async (roomIds: string[]) =>
        roomIds.map((roomId) => ({
          entities:
            roomId === "r1"
              ? [{ id: "e1" }, { name: "no-id" }]
              : [{ id: "e2" }],
        })),
      getTasks: async () => [
        { id: "t-own", agentId: AGENT_ID },
        { id: "t-snake", agent_id: AGENT_ID },
        { id: "t-foreign", agentId: OTHER_ID },
        // agentId wins over agent_id when both are present
        { id: "t-both", agentId: OTHER_ID, agent_id: AGENT_ID },
      ],
    };
    const estimate = await estimateExportSize(runtimeWith(adapter));
    expect(estimate).toEqual({
      memoriesCount: 3,
      entitiesCount: 2,
      roomsCount: 2,
      worldsCount: 1,
      tasksCount: 2,
      estimatedBytes: 3 * 500 + 2 * 200 + 2 * 300 + 1 * 200 + 2 * 400 + 2000,
    });
  });
});

describe("exportAgent missing agent", () => {
  it("rejects when the adapter has no row for the runtime agentId", async () => {
    const adapter = {
      getAgentsByIds: async () => [],
    };
    await expect(
      exportAgent(runtimeWith(adapter), PASSWORD, {}),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(AgentExportError);
      expect((err as AgentExportError).message).toMatch(
        new RegExp(`Agent ${AGENT_ID} not found in database`),
      );
      return true;
    });
  });
});

describe("importAgent binary unpack", () => {
  const adapter = {};

  it("rejects a buffer smaller than the 79-byte header", async () => {
    await expect(
      importAgent(runtimeWith(adapter), Buffer.alloc(78), PASSWORD),
    ).rejects.toThrow(/File is too small to be a valid \.eliza-agent export/);
  });

  it("rejects a buffer whose magic header does not match ELIZA_AGENT_V1", async () => {
    const buf = packHeader({
      iterations: 1,
      ciphertext: Buffer.from("x"),
      magic: Buffer.from("ELIZA_AGENT_V0\n", "utf-8"),
    });
    await expect(
      importAgent(runtimeWith(adapter), buf, PASSWORD),
    ).rejects.toThrow(/Invalid file format/);
  });

  it("rejects a zero PBKDF2 iteration count", async () => {
    const buf = packHeader({ iterations: 0, ciphertext: Buffer.from("x") });
    await expect(
      importAgent(runtimeWith(adapter), buf, PASSWORD),
    ).rejects.toThrow(/Invalid PBKDF2 iteration count \(0\)/);
  });

  it("rejects an iteration count above the 1_200_000 ceiling", async () => {
    const buf = packHeader({
      iterations: 1_200_001,
      ciphertext: Buffer.from("x"),
    });
    await expect(
      importAgent(runtimeWith(adapter), buf, PASSWORD),
    ).rejects.toThrow(/Invalid PBKDF2 iteration count \(1200001\)/);
  });

  it("rejects a well-sized header with no ciphertext", async () => {
    const buf = packHeader({ iterations: 1 });
    expect(buf.length).toBe(79);
    await expect(
      importAgent(runtimeWith(adapter), buf, PASSWORD),
    ).rejects.toThrow(/Export file contains no encrypted data/);
  });
});

describe("importAgent decrypt, decompress, schema, and version gates", () => {
  it("maps an authenticatable-looking ciphertext with the wrong contents to Incorrect password", async () => {
    const buf = packHeader({
      iterations: 1,
      ciphertext: Buffer.from("not-really-ciphertext"),
    });
    await expect(importAgent(runtimeWith({}), buf, PASSWORD)).rejects.toThrow(
      /Incorrect password — decryption failed/,
    );
  });

  it("rejects a decrypted payload that is not gzip", async () => {
    const buf = await packEncrypted(Buffer.from("this is not gzip"), PASSWORD);
    await expect(importAgent(runtimeWith({}), buf, PASSWORD)).rejects.toThrow(
      /Decompression failed — the file may be corrupt/,
    );
  });

  it("rejects decompressed bytes that are not JSON", async () => {
    const buf = await packEncrypted(
      gzipSync(Buffer.from("not-json", "utf-8")),
      PASSWORD,
    );
    await expect(importAgent(runtimeWith({}), buf, PASSWORD)).rejects.toThrow(
      /JSON parse failed — the export data is malformed/,
    );
  });

  it("rejects a JSON object that fails PayloadSchema", async () => {
    const buf = await packEncrypted(
      gzipJson({ version: 1, exportedAt: "x", agent: {} }),
      PASSWORD,
    );
    await expect(importAgent(runtimeWith({}), buf, PASSWORD)).rejects.toThrow(
      /Export file schema validation failed/,
    );
  });

  it("rejects a schema-valid payload whose version is newer than this build", async () => {
    const buf = await packEncrypted(
      gzipJson(payload({ version: 2 })),
      PASSWORD,
    );
    await expect(importAgent(runtimeWith({}), buf, PASSWORD)).rejects.toThrow(
      /Unsupported export version 2/,
    );
  });

  it("rejects a present integrity manifest that does not match the collections", async () => {
    const buf = await packEncrypted(
      gzipJson(
        payload({
          memories: [{ id: "m1" }],
          manifest: {
            algorithm: "sha256",
            components: {
              memories: { sha256: "deadbeef", count: 99 },
            },
          },
        }),
      ),
      PASSWORD,
    );
    await expect(importAgent(runtimeWith({}), buf, PASSWORD)).rejects.toThrow(
      /Integrity check failed — export payload is inconsistent with its manifest/,
    );
  });
});

describe("importAgent restore", () => {
  it("throws when createAgents returns no ids", async () => {
    const { adapter } = restoreAdapter({
      createAgents: async () => [],
    });
    const buf = await packEncrypted(gzipJson(payload()), PASSWORD);
    await expect(
      importAgent(runtimeWith(adapter), buf, PASSWORD),
    ).rejects.toThrow(/Failed to create agent in database/);
  });

  it("imports an older payload with no manifest and reports Unknown when agent.name is missing", async () => {
    const { adapter, createdAgents } = restoreAdapter();
    const buf = await packEncrypted(
      gzipJson(
        payload({
          agent: { bio: "no name field" },
          characterConfig: {
            topics: ["backups"],
            secrets: { apiKey: "must-not-land" },
          },
        }),
      ),
      PASSWORD,
    );
    const result = await importAgent(runtimeWith(adapter), buf, PASSWORD);
    expect(result.success).toBe(true);
    expect(result.agentName).toBe("Unknown");
    expect(result.agentId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(result.agentId).not.toBe(AGENT_ID);
    expect(result.counts).toEqual({
      memories: 0,
      entities: 0,
      components: 0,
      rooms: 0,
      participants: 0,
      relationships: 0,
      worlds: 0,
      tasks: 0,
      logs: 0,
      media: 0,
    });
    expect(createdAgents).toHaveLength(1);
    expect(createdAgents[0]?.topics).toEqual(["backups"]);
    expect(createdAgents[0]?.secrets).toBeUndefined();
    expect(createdAgents[0]?.id).toBe(result.agentId);
    expect(createdAgents[0]?.enabled).toBe(true);
  });

  it("remaps a single world/room/entity/participant/task and records FOLLOWED state", async () => {
    const worlds: Array<Record<string, unknown>> = [];
    const rooms: Array<Record<string, unknown>> = [];
    const entities: Array<Record<string, unknown>> = [];
    const participants: Array<{
      entityId: string;
      roomId: string;
      state: string | null;
    }> = [];
    const memories: Array<{
      tableName: string;
      memory: Record<string, unknown>;
    }> = [];
    const { adapter } = restoreAdapter({
      createWorlds: async (rows: Array<Record<string, unknown>>) => {
        worlds.push(...rows);
      },
      createRooms: async (rows: Array<Record<string, unknown>>) => {
        rooms.push(...rows);
      },
      createEntities: async (rows: Array<Record<string, unknown>>) => {
        entities.push(...rows);
        return true;
      },
      createRoomParticipants: async (entityIds: string[], roomId: string) => {
        for (const entityId of entityIds) {
          participants.push({ entityId, roomId, state: null });
        }
        return true;
      },
      updateParticipantUserStates: async (
        updates: Array<{ roomId: string; entityId: string; state: string }>,
      ) => {
        for (const update of updates) {
          const row = participants.find(
            (p) => p.roomId === update.roomId && p.entityId === update.entityId,
          );
          if (row) row.state = update.state;
        }
      },
      createMemories: async (
        rows: Array<{ memory: Record<string, unknown>; tableName: string }>,
      ) => {
        memories.push(...rows);
      },
    });

    const buf = await packEncrypted(
      gzipJson(
        payload({
          worlds: [{ id: "w1", name: "Home" }],
          rooms: [{ id: "r1", worldId: "w1", name: "general" }],
          entities: [{ id: "e1", names: ["Ada"] }],
          participants: [
            { entityId: "e1", roomId: "r1", userState: "FOLLOWED" },
            { entityId: "e1", roomId: "r1", userState: "IGNORED" },
          ],
          memories: [
            {
              id: "m1",
              content: { text: "hello" },
              metadata: { type: "document" },
            },
            {
              id: "m2",
              content: { text: "fact" },
              type: "facts",
            },
            {
              id: "m3",
              content: { text: "fallback" },
            },
          ],
        }),
      ),
      PASSWORD,
    );

    const result = await importAgent(runtimeWith(adapter), buf, PASSWORD);
    expect(result.success).toBe(true);
    expect(result.counts.worlds).toBe(1);
    expect(result.counts.rooms).toBe(1);
    expect(result.counts.entities).toBe(1);
    expect(result.counts.participants).toBe(2);
    expect(result.counts.memories).toBe(3);

    expect(worlds[0]?.id).not.toBe("w1");
    expect(worlds[0]?.agentId).toBe(result.agentId);
    expect(rooms[0]?.id).not.toBe("r1");
    expect(rooms[0]?.worldId).toBe(worlds[0]?.id);
    expect(entities[0]?.id).not.toBe("e1");
    expect(entities[0]?.components).toBeUndefined();

    expect(participants).toHaveLength(2);
    expect(participants[0]?.state).toBe("FOLLOWED");
    // Only FOLLOWED/MUTED call updateParticipantUserStates
    expect(participants[1]?.state).toBeNull();

    expect(memories.map((row) => row.tableName).sort()).toEqual([
      "documents",
      "facts",
      "messages",
    ]);
    for (const row of memories) {
      expect(row.memory.embedding).toBeUndefined();
      expect(row.memory.agentId).toBe(result.agentId);
    }
  });
});
