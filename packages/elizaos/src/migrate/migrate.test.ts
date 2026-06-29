import * as path from "node:path";
// The CLI ships runtime-free (see package CLAUDE.md); `@elizaos/agent` is a
// DEV-only dependency used solely to drive the migration archive through the
// REAL importer, proving cross-package `.eliza-agent` format compatibility.
import { importAgent } from "@elizaos/agent/services/agent-export";
import { describe, expect, it } from "vitest";
import { buildElizaAgentArchive } from "./archive-format.js";
import { assemblePayload } from "./archive-writer.js";
import { mapToCharacter } from "./character-mapper.js";
import { buildMigrationPlan, emitSovereignArtifacts } from "./index.js";
import { tierMemories } from "./memory-tiering.js";
import { readOcAgentHome } from "./openclaw-reader.js";

const FIXTURE = path.join(__dirname, "__tests__", "fixtures", "oc-home");

/** Personal-context strings from the fixture that MUST never reach a firewalled archive. */
const PERSONAL_TEXT = [
  "Secret personal info", // USER.md (about the human)
  "This is my becoming", // tess-thoughts.md (SELF journal)
  "Current open thread", // tess-awareness.md (relationship/awareness state)
  "recent daily log content", // 2026-06-29.md (daily log)
  "Long-term fact", // MEMORY.md (curated long-term memory)
];

/**
 * Build a real `.eliza-agent` archive from the fixture home. Defaults to the
 * SOVEREIGN posture (firewall off) so the import-compatibility test exercises
 * the full memory corpus (CURRENT/LONGTERM/SELF/MARKER); the firewall security
 * guarantee is proven separately in its own suite.
 */
function buildArchive(
  password: string,
  firewall = false,
): {
  archive: Buffer;
  memoryCount: number;
} {
  const plan = buildMigrationPlan({ from: FIXTURE, agentId: "tess", firewall });
  const { payload } = assemblePayload({
    agentId: plan.ids.agentId,
    sourceSlug: "tess",
    character: plan.character,
    entityId: plan.ids.entityId,
    roomId: plan.ids.roomId,
    memories: plan.memories,
  });
  return {
    archive: buildElizaAgentArchive(payload, password),
    memoryCount: plan.memories.length,
  };
}

/**
 * A capturing in-memory database adapter. `importAgent` drives the REAL
 * unpack/decrypt/decompress/schema-validate/restore pipeline; only the terminal
 * persistence is captured here (the DB is infrastructure, not the unit under
 * test — the migration archive + its import compatibility is).
 */
function makeCapturingAdapter() {
  const captured = {
    agents: [] as Array<{ id: string; name?: string; bio?: unknown }>,
    worlds: [] as unknown[],
    rooms: [] as unknown[],
    entities: [] as unknown[],
    participants: [] as unknown[],
    components: [] as unknown[],
    memories: [] as Array<{ memory: { content: { text: string } } }>,
    relationships: [] as unknown[],
    tasks: [] as unknown[],
    logs: [] as unknown[],
  };
  const adapter = {
    createAgents: async (rows: Array<{ id: string }>) => {
      captured.agents.push(...(rows as (typeof captured.agents)[number][]));
      return rows.map((r) => r.id);
    },
    createWorlds: async (rows: unknown[]) => {
      captured.worlds.push(...rows);
    },
    createRooms: async (rows: unknown[]) => {
      captured.rooms.push(...rows);
    },
    createEntities: async (rows: unknown[]) => {
      captured.entities.push(...rows);
    },
    createRoomParticipants: async (entityIds: unknown, roomId: unknown) => {
      captured.participants.push({ entityIds, roomId });
    },
    updateParticipantUserStates: async (_rows: unknown[]) => {},
    createComponents: async (rows: unknown[]) => {
      captured.components.push(...rows);
    },
    createMemories: async (
      rows: Array<{ memory: { content: { text: string } } }>,
    ) => {
      captured.memories.push(...rows);
    },
    createRelationships: async (rows: unknown[]) => {
      captured.relationships.push(...rows);
    },
    createTasks: async (rows: unknown[]) => {
      captured.tasks.push(...rows);
    },
    createLogs: async (rows: unknown[]) => {
      captured.logs.push(...rows);
    },
  };
  return { adapter, captured };
}

type ImportRuntime = Parameters<typeof importAgent>[0];

describe("openclaw-reader", () => {
  it("classifies a home into typed source, tolerant of layout", () => {
    const src = readOcAgentHome(FIXTURE, "tess");
    expect(src.soul).toContain("Tess");
    expect(src.user).toContain("firewalled");
    expect(src.curatedMemory).toContain("Section One");
    expect(src.awareness).toContain("open thread");
    expect(src.hasSecretsDir).toBe(true);
    expect(src.dailyLogs.length).toBeGreaterThanOrEqual(2);
    expect(src.namedMemory.some((m) => m.key === "conversation-playbook")).toBe(
      true,
    );
    expect(src.namedMemory.some((m) => /^\d{4}-\d{2}-\d{2}$/.test(m.key))).toBe(
      false,
    );
  });
  it("returns empty for a missing home without throwing", () => {
    const src = readOcAgentHome(path.join(FIXTURE, "nope"), "ghost");
    expect(src.soul).toBeUndefined();
    expect(src.dailyLogs).toEqual([]);
  });
});

describe("character-mapper", () => {
  it("maps persona + firewalls USER by default", () => {
    const src = readOcAgentHome(FIXTURE, "tess");
    const ch = mapToCharacter(src, { firewall: true });
    expect(ch.name).toBe("Tess");
    expect(ch.system).toContain("Tess");
    expect(ch.bio?.length ?? 0).toBeGreaterThan(0);
    expect(JSON.stringify(ch.knowledge ?? [])).not.toContain("firewalled");
    expect(ch.style?.chat?.length ?? 0).toBeGreaterThan(0);
  });
  it("includes USER only when firewall disabled", () => {
    const ch = mapToCharacter(readOcAgentHome(FIXTURE, "tess"), {
      firewall: false,
    });
    expect(JSON.stringify(ch.knowledge ?? [])).toContain("firewalled");
  });
  it("appends CURRENT CONTEXT when provided", () => {
    const ch = mapToCharacter(readOcAgentHome(FIXTURE, "tess"), {
      firewall: true,
      currentContext: "right now: running the test suite",
    });
    expect(ch.system).toContain("CURRENT CONTEXT");
  });
});

describe("memory-tiering", () => {
  const ids = {
    agentId: "00000000-0000-0000-0000-00000000a000",
    entityId: "00000000-0000-0000-0000-00000000e000",
    roomId: "00000000-0000-0000-0000-00000000r000",
  } as const;
  it("tiers CURRENT + LONGTERM + SELF + older marker", () => {
    const src = readOcAgentHome(FIXTURE, "tess");
    const { memories, counts } = tierMemories(src, { memoryDays: 14, ...ids });
    expect(counts.CURRENT).toBeGreaterThan(0);
    expect(counts.LONGTERM).toBeGreaterThanOrEqual(2);
    expect(counts.SELF).toBeGreaterThanOrEqual(1);
    expect(counts.MARKER).toBe(1);
    expect(memories.length).toBe(
      counts.CURRENT + counts.LONGTERM + counts.SELF + counts.MARKER,
    );
    for (const m of memories) {
      expect(m.metadata.source).toBe("openclaw-migration");
      expect(m.content.text.startsWith(`[${m.metadata.tier}]`)).toBe(true);
    }
    const all = memories.map((m) => m.content.text).join("\n");
    expect(all).not.toContain("old daily log that should NOT be flat-seeded");
    expect(all).toContain("Older history");
  });
  it("firewall excludes ALL personal-context memory (marker only)", () => {
    const src = readOcAgentHome(FIXTURE, "tess");
    const { memories, counts } = tierMemories(src, {
      memoryDays: 14,
      firewall: true,
      ...ids,
    });
    expect(counts.CURRENT).toBe(0);
    expect(counts.LONGTERM).toBe(0);
    expect(counts.SELF).toBe(0);
    expect(counts.MARKER).toBe(1);
    expect(memories.length).toBe(1);
    const all = memories.map((m) => m.content.text).join("\n");
    for (const needle of PERSONAL_TEXT) {
      expect(all, needle).not.toContain(needle);
    }
  });
});

describe("archive format", () => {
  it("produces a V1-magic archive", () => {
    const { archive } = buildArchive("test-password");
    expect(archive.subarray(0, 15).toString("utf8")).toBe("ELIZA_AGENT_V1\n");
    expect(archive.length).toBeGreaterThan(79);
  });
  it("rejects a too-short password", () => {
    expect(() => buildElizaAgentArchive({ a: 1 }, "")).toThrow();
  });
});

// The decisive compatibility proof: a migration archive must import through the
// REAL `@elizaos/agent` importer — exercising unpackFile → AES-256-GCM decrypt →
// gunzip → JSON.parse → PayloadSchema (zod) validation → restoreAgentData. If
// migrate's format/crypto params or payload shape ever drift from what
// `importAgent` accepts, this fails. Only DB persistence is captured in-memory.
describe("archive round-trips through the real importAgent", () => {
  it("decrypts, schema-validates, and restores the migrated agent + memories", async () => {
    const { archive, memoryCount } = buildArchive("test-password");
    const { adapter, captured } = makeCapturingAdapter();
    const runtime = { adapter } as unknown as ImportRuntime;

    const result = await importAgent(runtime, archive, "test-password");

    expect(result.success).toBe(true);
    expect(result.agentName).toBe("Tess");
    expect(result.counts.memories).toBe(memoryCount);
    expect(result.counts.entities).toBe(1);
    expect(result.counts.rooms).toBe(1);
    expect(result.counts.worlds).toBe(1);
    expect(result.counts.participants).toBe(1);

    // Domain artifacts actually landed in the (captured) store.
    expect(captured.agents).toHaveLength(1);
    expect(captured.agents[0]?.name).toBe("Tess");
    expect(captured.memories).toHaveLength(memoryCount);
    const memText = captured.memories
      .map((m) => m.memory.content.text)
      .join("\n");
    // Tier prefixes (added by memory-tiering) survive the full round-trip.
    expect(memText).toContain("[CURRENT]");
  });

  it("rejects an archive opened with the wrong password (GCM auth failure)", async () => {
    const { archive } = buildArchive("correct-password");
    const { adapter } = makeCapturingAdapter();
    const runtime = { adapter } as unknown as ImportRuntime;
    await expect(
      importAgent(runtime, archive, "wrong-password"),
    ).rejects.toThrow();
  });
});

describe("sovereign artifacts + plan", () => {
  it("emits character JSON + memories JSONL", () => {
    const plan = buildMigrationPlan({ from: FIXTURE, agentId: "tess" });
    const { characterJson, memoriesJsonl } = emitSovereignArtifacts(plan);
    expect(JSON.parse(characterJson).name).toBe("Tess");
    expect(memoriesJsonl.split("\n").filter(Boolean).length).toBe(
      plan.memories.length,
    );
  });
  it("honors firewall flag in dry-run summary", () => {
    expect(
      buildMigrationPlan({ from: FIXTURE, agentId: "tess", firewall: true })
        .summary.firewalled,
    ).toBe(true);
    expect(
      buildMigrationPlan({ from: FIXTURE, agentId: "tess", firewall: false })
        .summary.firewalled,
    ).toBe(false);
  });
});

/**
 * The firewall is the headline privacy guarantee: a PORTABLE archive (the
 * default posture) must carry the persona but NOT the owner's personal memory
 * corpus. We prove it end-to-end — build → encrypt → import through the REAL
 * `@elizaos/agent` importer — and inspect what actually lands in the (captured)
 * store, so the assertion is on real restored rows, not a mock.
 */
describe("firewall keeps the personal memory corpus out of a portable archive", () => {
  /** Build an archive at a given firewall posture + import it via the real importer. */
  async function importWithFirewall(firewall: boolean) {
    const plan = buildMigrationPlan({
      from: FIXTURE,
      agentId: "tess",
      firewall,
    });
    const { payload } = assemblePayload({
      agentId: plan.ids.agentId,
      sourceSlug: "tess",
      character: plan.character,
      entityId: plan.ids.entityId,
      roomId: plan.ids.roomId,
      memories: plan.memories,
    });
    const archive = buildElizaAgentArchive(payload, "fw-password");
    const { adapter, captured } = makeCapturingAdapter();
    const runtime = { adapter } as unknown as ImportRuntime;
    const result = await importAgent(runtime, archive, "fw-password");
    return { plan, result, captured };
  }

  it("default (firewall ON): persona imports, but only a MARKER memory — no personal text", async () => {
    const { plan, result, captured } = await importWithFirewall(true);

    expect(plan.summary.firewalled).toBe(true);
    expect(result.success).toBe(true);
    // The persona still round-trips.
    expect(captured.agents[0]?.name).toBe("Tess");
    // The seeded corpus is exactly the firewall marker — nothing personal.
    expect(
      captured.memories.every((m) =>
        m.memory.content.text.startsWith("[MARKER]"),
      ),
    ).toBe(true);
    // Not a single byte of personal context anywhere in the restored store.
    const blob = JSON.stringify(captured);
    for (const needle of PERSONAL_TEXT) {
      expect(blob, needle).not.toContain(needle);
    }
  });

  it("sovereign (firewall OFF): the SAME personal text DOES round-trip", async () => {
    const { captured } = await importWithFirewall(false);
    const memText = captured.memories
      .map((m) => m.memory.content.text)
      .join("\n");
    // Proof the firewall (not absence of source data) is what removed the text
    // above: with it off, the journal / awareness / daily / MEMORY content lands.
    expect(memText).toContain("This is my becoming"); // SELF journal
    expect(memText).toContain("Current open thread"); // awareness
    expect(memText).toContain("recent daily log content"); // daily log
    expect(memText).toContain("Long-term fact"); // MEMORY.md
  });
});
