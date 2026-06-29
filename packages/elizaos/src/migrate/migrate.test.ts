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
    expect(src.namedMemory.some((m) => m.key === "conversation-playbook")).toBe(true);
    expect(src.namedMemory.some((m) => /^\d{4}-\d{2}-\d{2}$/.test(m.key))).toBe(false);
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
    const ch = mapToCharacter(readOcAgentHome(FIXTURE, "tess"), { firewall: false });
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
    expect(memories.length).toBe(counts.CURRENT + counts.LONGTERM + counts.SELF + counts.MARKER);
    for (const m of memories) {
      expect(m.metadata.source).toBe("openclaw-migration");
      expect(m.content.text.startsWith(`[${m.metadata.tier}]`)).toBe(true);
    }
    const all = memories.map((m) => m.content.text).join("\n");
    expect(all).not.toContain("old daily log that should NOT be flat-seeded");
    expect(all).toContain("Older history");
  });
});

describe("archive round-trip", () => {
  it("assembles + encrypts a V1 archive", () => {
    const plan = buildMigrationPlan({ from: FIXTURE, agentId: "tess" });
    const { payload } = assemblePayload({
      agentId: plan.ids.agentId, sourceSlug: "tess", character: plan.character,
      entityId: plan.ids.entityId, roomId: plan.ids.roomId, memories: plan.memories,
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
    expect(memoriesJsonl.split("\n").filter(Boolean).length).toBe(plan.memories.length);
  });
  it("honors firewall flag in dry-run summary", () => {
    expect(buildMigrationPlan({ from: FIXTURE, agentId: "tess", firewall: true }).summary.firewalled).toBe(true);
    expect(buildMigrationPlan({ from: FIXTURE, agentId: "tess", firewall: false }).summary.firewalled).toBe(false);
  });
});
