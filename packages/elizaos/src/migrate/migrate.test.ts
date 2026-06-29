import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { buildElizaAgentArchive } from "./archive-format.js";
import { assemblePayload } from "./archive-writer.js";
import { mapToCharacter } from "./character-mapper.js";
import { buildMigrationPlan, emitSovereignArtifacts } from "./index.js";
import { tierMemories } from "./memory-tiering.js";
import { readOcAgentHome } from "./openclaw-reader.js";

const FIXTURE = path.join(__dirname, "__tests__", "fixtures", "oc-home");

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
  it("resolves a NESTED workspace/ home layout (GAP 1)", () => {
    const nested = path.join(
      __dirname,
      "__tests__",
      "fixtures",
      "oc-home-nested",
    );
    const src = readOcAgentHome(nested, "nyx");
    // Persona + memory must be found under <home>/workspace/, not <home>/.
    expect(src.soul).toContain("Nyx");
    expect(src.identity).toContain("Nyx");
    expect(src.curatedMemory).toContain("Section A");
    expect(src.awareness).toContain("nested layout");
    expect(src.dailyLogs.length).toBeGreaterThanOrEqual(1);
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
  it("drops cross-tier duplicates keeping the highest-priority tier (GAP 3)", () => {
    // Synthesize a source where the SAME chunk body lands in LONGTERM (MEMORY.md
    // section) and CURRENT (awareness). Dedup normalizes the [TIER] prefix +
    // whitespace, so identical bodies collide; CURRENT (higher priority) wins.
    const dupBody =
      "Sol ships the migration tool this week, no shortcuts whatsoever.";
    const src = {
      agentId: "dup",
      home: "/tmp/x",
      // awareness is seeded verbatim as CURRENT (no heading prefix added).
      awareness: dupBody,
      // a single-section MEMORY.md whose ONLY chunk body equals dupBody after
      // the heading line is stripped by chunkBySection? chunkBySection keeps the
      // heading, so make the heading-free section equal dupBody by using no
      // heading at all (chunk = the raw body).
      curatedMemory: dupBody,
      dailyLogs: [],
      namedMemory: [],
      hasSecretsDir: false,
    } as unknown as Parameters<typeof tierMemories>[0];
    const { memories, counts, duplicatesDropped } = tierMemories(src, {
      memoryDays: 14,
      ...ids,
    });
    expect(duplicatesDropped).toBe(1);
    // The surviving copy is the CURRENT (awareness) one.
    const survivors = memories.filter((m) => m.content.text.includes(dupBody));
    expect(survivors.length).toBe(1);
    expect(survivors[0].metadata.tier).toBe("CURRENT");
    // counts decremented for the dropped LONGTERM entry.
    expect(counts.CURRENT).toBe(1);
    expect(counts.LONGTERM).toBe(0);
  });
  it("reports clipped memories when a chunk exceeds maxChunkLen (GAP 6)", () => {
    const big = "x".repeat(500);
    const src = {
      agentId: "big",
      home: "/tmp/x",
      awareness: big,
      dailyLogs: [],
      namedMemory: [],
      hasSecretsDir: false,
    } as unknown as Parameters<typeof tierMemories>[0];
    const { clipped } = tierMemories(src, {
      memoryDays: 14,
      maxChunkLen: 100,
      ...ids,
    });
    expect(clipped).toBe(1);
  });
});

describe("archive round-trip", () => {
  it("assembles + encrypts a V1 archive", () => {
    const plan = buildMigrationPlan({ from: FIXTURE, agentId: "tess" });
    const { payload } = assemblePayload({
      agentId: plan.ids.agentId,
      sourceSlug: "tess",
      character: plan.character,
      entityId: plan.ids.entityId,
      roomId: plan.ids.roomId,
      memories: plan.memories,
    });
    expect(payload.version).toBe(1);
    expect(payload.memories.length).toBe(plan.memories.length);
    const archive = buildElizaAgentArchive(payload, "test-password");
    expect(archive.subarray(0, 15).toString("utf8")).toBe("ELIZA_AGENT_V1\n");
    expect(archive.length).toBeGreaterThan(79);
  });
  it("rejects a too-short password", () => {
    expect(() => buildElizaAgentArchive({ a: 1 }, "")).toThrow();
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
