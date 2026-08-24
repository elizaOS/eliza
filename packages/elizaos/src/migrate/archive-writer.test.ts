/**
 * Coverage for the migration archive writer against the real module: payload
 * assembly (world/room/entity naming, agent record defaults, characterConfig
 * settings stripping, memory passthrough, per-call world ids) and the
 * encrypted .eliza-agent buffer, verified by decrypting with node built-ins.
 */
import { createDecipheriv, pbkdf2Sync, randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { MIN_PASSWORD_LENGTH } from "./archive-format.js";
import {
  assemblePayload,
  type BuildArchiveInput,
  buildAgentArchive,
} from "./archive-writer.js";
import type {
  MigratedCharacter,
  MigratedExportPayload,
  MigratedMemory,
} from "./types.js";

const MAGIC = Buffer.from("ELIZA_AGENT_V1\n", "utf-8");
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function makeCharacter(
  overrides: Partial<MigratedCharacter> = {},
): MigratedCharacter {
  return {
    name: "Test Agent",
    username: "test-agent",
    system: "You are helpful.",
    bio: ["curious", "concise"],
    adjectives: ["witty"],
    topics: ["testing"],
    style: { all: ["be brief"], chat: ["friendly"] },
    messageExamples: [],
    knowledge: [{ case: "", value: { text: "knows testing" } }],
    settings: { model: "test-model", secrets: { KEY: "value" } },
    ...overrides,
  };
}

function makeMemory(overrides: Partial<MigratedMemory> = {}): MigratedMemory {
  return {
    id: randomUUID(),
    entityId: randomUUID(),
    agentId: randomUUID(),
    roomId: randomUUID(),
    createdAt: 1_700_000_000_000,
    content: { text: "remembered fact" },
    metadata: { type: "custom", source: "openclaw", tier: "base" },
    unique: true,
    ...overrides,
  };
}

function makeInput(
  overrides: Partial<BuildArchiveInput> = {},
): BuildArchiveInput {
  return {
    agentId: randomUUID(),
    sourceSlug: "old-claw",
    character: makeCharacter(),
    entityId: randomUUID(),
    roomId: randomUUID(),
    memories: [],
    ...overrides,
  };
}

function parseArchive(buffer: Buffer) {
  const iterations = buffer.readUInt32BE(MAGIC.length);
  const salt = buffer.subarray(MAGIC.length + 4, MAGIC.length + 4 + 32);
  const iv = buffer.subarray(MAGIC.length + 4 + 32, MAGIC.length + 4 + 32 + 12);
  const tag = buffer.subarray(
    MAGIC.length + 4 + 32 + 12,
    MAGIC.length + 4 + 32 + 12 + 16,
  );
  const ciphertext = buffer.subarray(MAGIC.length + 4 + 32 + 12 + 16);
  return { ciphertext, iterations, iv, salt, tag };
}

describe("assemblePayload", () => {
  it("names the world and room after the source slug and wires the ids together", () => {
    const input = makeInput();
    const { payload, worldId } = assemblePayload(input);

    expect(worldId).toMatch(UUID_PATTERN);

    const room = payload.rooms[0] as Record<string, unknown>;
    expect(room).toEqual({
      id: input.roomId,
      name: "old-claw memory",
      agentId: input.agentId,
      source: "openclaw-migration",
      type: "SELF",
      worldId,
    });

    const [world] = payload.worlds as Array<Record<string, unknown>>;
    expect(world.id).toBe(worldId);
    expect(world.name).toBe("old-claw (migrated)");
    expect(world.agentId).toBe(input.agentId);

    const metadata = world.metadata as Record<string, unknown>;
    expect(metadata.type).toBe("migration");
    expect(metadata.description).toBe("Imported from an OpenClaw agent home.");

    const ownership = metadata.ownership as Record<string, unknown>;
    expect(ownership.ownerId).toBe(String(input.entityId));
    expect(metadata.roles).toEqual({ [String(input.entityId)]: "OWNER" });
  });

  it("stamps the agent DB record as active with identity fields from the character", () => {
    const input = makeInput();
    const before = Date.now();
    const { payload } = assemblePayload(input);
    const after = Date.now();

    const agent = payload.agent;
    expect(agent.id).toBe(input.agentId);
    expect(agent.name).toBe("Test Agent");
    expect(agent.username).toBe("test-agent");
    expect(agent.system).toBe("You are helpful.");
    expect(agent.bio).toEqual(["curious", "concise"]);
    expect(agent.status).toBe("active");
    expect(agent.enabled).toBe(true);

    const createdAt = agent.createdAt as number;
    expect(createdAt).toBeGreaterThanOrEqual(before);
    expect(createdAt).toBeLessThanOrEqual(after);
    expect(agent.updatedAt).toBe(createdAt);
    expect(payload.exportedAt).toBe(new Date(createdAt).toISOString());
  });

  it("falls back entity names and agent username to the source slug when absent", () => {
    const input = makeInput({
      character: makeCharacter({ name: undefined, username: undefined }),
    });
    const { payload } = assemblePayload(input);

    const entity = payload.entities[0] as Record<string, unknown>;
    expect(entity.id).toBe(input.entityId);
    expect(entity.names).toEqual(["old-claw"]);
    expect(entity.agentId).toBe(input.agentId);
    expect(entity.metadata).toEqual({ source: "openclaw-migration" });
    expect(payload.agent.name).toBeUndefined();
    expect(payload.agent.username).toBe("old-claw");
  });

  it("keeps the character name on the entity when present", () => {
    const { payload } = assemblePayload(makeInput());
    const entity = payload.entities[0] as Record<string, unknown>;
    expect(entity.names).toEqual(["Test Agent"]);
  });

  it("strips settings from characterConfig while keeping every other character field", () => {
    const character = makeCharacter();
    const { payload } = assemblePayload(makeInput({ character }));

    const { settings: _settings, ...expected } = character;
    expect(payload.characterConfig).toEqual(expected);
    expect(Object.hasOwn(payload.characterConfig ?? {}, "settings")).toBe(
      false,
    );
  });

  it("passes memories through unchanged, in order, including an empty set", () => {
    const empty = assemblePayload(makeInput({ memories: [] }));
    expect(empty.payload.memories).toEqual([]);

    const first = makeMemory({ content: { text: "first" } });
    const second = makeMemory({ content: { text: "second" } });
    const populated = assemblePayload(makeInput({ memories: [first, second] }));
    expect(populated.payload.memories).toEqual([first, second]);
  });

  it("emits version 1 provenance, a single participant, and empty collections", () => {
    const input = makeInput();
    const { payload } = assemblePayload(input);

    expect(payload.version).toBe(1);
    expect(payload.sourceAgentId).toBe("old-claw");
    expect(payload.participants).toEqual([
      {
        entityId: String(input.entityId),
        roomId: String(input.roomId),
        userState: null,
      },
    ]);
    expect(payload.components).toEqual([]);
    expect(payload.relationships).toEqual([]);
    expect(payload.tasks).toEqual([]);
    expect(payload.logs).toEqual([]);
  });

  it("generates a fresh world id per call", () => {
    const a = assemblePayload(makeInput());
    const b = assemblePayload(makeInput());

    expect(a.worldId).toMatch(UUID_PATTERN);
    expect(b.worldId).toMatch(UUID_PATTERN);
    expect(a.worldId).not.toBe(b.worldId);
  });
});

describe("buildAgentArchive", () => {
  it("propagates the writer's password policy before doing any crypto work", () => {
    const tooShort = "x".repeat(MIN_PASSWORD_LENGTH - 1);
    expect(() => buildAgentArchive(makeInput(), tooShort)).toThrow(
      new RegExp(`at least ${MIN_PASSWORD_LENGTH} characters`),
    );
  });

  it("encrypts the assembled payload into a V1 archive that decrypts back to it", () => {
    const password = "correct-horse-battery";
    const memories = [
      makeMemory({ content: { text: "archived memory one" } }),
      makeMemory({ content: { text: "archived memory two" } }),
    ];
    const archive = buildAgentArchive(makeInput({ memories }), password);

    expect(Buffer.isBuffer(archive)).toBe(true);
    expect(archive.subarray(0, MAGIC.length)).toEqual(MAGIC);

    const { ciphertext, iterations, iv, salt, tag } = parseArchive(archive);
    expect(iterations).toBe(600_000);

    const key = pbkdf2Sync(password, salt, iterations, 32, "sha256");
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    const payload = JSON.parse(
      gunzipSync(decrypted).toString("utf-8"),
    ) as MigratedExportPayload;

    expect(payload.version).toBe(1);
    expect(payload.sourceAgentId).toBe("old-claw");

    const worldId = (payload.worlds[0] as Record<string, unknown>).id;
    const room = payload.rooms[0] as Record<string, unknown>;
    expect(room.name).toBe("old-claw memory");
    expect(room.type).toBe("SELF");
    expect(room.worldId).toBe(worldId);

    const entity = payload.entities[0] as Record<string, unknown>;
    expect(entity.names).toEqual(["Test Agent"]);

    expect(payload.agent.name).toBe("Test Agent");
    expect(payload.agent.username).toBe("test-agent");
    expect(payload.agent.status).toBe("active");
    expect(payload.exportedAt).toBe(
      new Date(payload.agent.createdAt as string).toISOString(),
    );

    expect(payload.characterConfig).toBeTruthy();
    expect(Object.hasOwn(payload.characterConfig ?? {}, "settings")).toBe(
      false,
    );
    expect(payload.characterConfig?.topics).toEqual(["testing"]);

    expect(payload.memories).toEqual(memories);
    expect(payload.participants[0]?.userState).toBeNull();
  });
});
