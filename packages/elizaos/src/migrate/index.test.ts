/**
 * Coverage for the migration orchestrator: plan assembly over the real
 * fixture home (ids, summary provenance, memoryDays window, firewall default),
 * archiveFromPlan encryption round-trip through real AES-256-GCM, and the
 * sovereign-local artifact emission boundary.
 */
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import * as path from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  archiveFromPlan,
  buildMigrationPlan,
  emitSovereignArtifacts,
  MIN_PASSWORD_LENGTH,
  type MigratePlan,
} from "./index.js";
import type { MigratedMemory } from "./types.js";

const FIXTURE = path.join(__dirname, "__tests__", "fixtures", "oc-home");
const MAGIC = Buffer.from("ELIZA_AGENT_V1\n", "utf-8");
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Decrypt a V1 archive back to its payload JSON using the framing it carries. */
function decryptPayload(archive: Buffer, password: string): unknown {
  expect(archive.subarray(0, MAGIC.length)).toEqual(MAGIC);
  const iterations = archive.readUInt32BE(MAGIC.length);
  expect(iterations).toBeGreaterThan(0);
  let off = MAGIC.length + 4;
  const salt = archive.subarray(off, off + 32);
  off += 32;
  const iv = archive.subarray(off, off + 12);
  off += 12;
  const tag = archive.subarray(off, off + 16);
  off += 16;
  const ciphertext = archive.subarray(off);
  const key = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(gunzipSync(plain).toString("utf-8"));
}

describe("buildMigrationPlan", () => {
  it("defaults to the firewalled portable posture with persona intact", () => {
    const plan = buildMigrationPlan({ from: FIXTURE, agentId: "tess" });
    // Omitting `firewall` must behave like firewall: true (#10283 posture).
    expect(plan.summary.firewalled).toBe(true);
    expect(plan.counts).toEqual({
      CURRENT: 0,
      LONGTERM: 0,
      SELF: 0,
      MARKER: 1,
    });
    expect(plan.memories).toHaveLength(1);
    expect(plan.memories[0]?.content.text.startsWith("[MARKER]")).toBe(true);
    // The persona itself still migrates; USER.md text never does.
    expect(plan.character.name).toBe("Tess");
    const blob = JSON.stringify(plan.character) + JSON.stringify(plan.memories);
    expect(blob).not.toContain("Secret personal info");
  });

  it("mints fresh UUIDs per plan and threads them into every memory", () => {
    const a = buildMigrationPlan({
      from: FIXTURE,
      agentId: "tess",
      firewall: false,
    });
    const b = buildMigrationPlan({
      from: FIXTURE,
      agentId: "tess",
      firewall: false,
    });
    for (const key of ["agentId", "entityId", "roomId"] as const) {
      expect(a.ids[key]).toMatch(UUID_RE);
      expect(b.ids[key]).not.toBe(a.ids[key]);
    }
    expect(new Set(Object.values(a.ids)).size).toBe(3);
    for (const m of a.memories) {
      expect(m.agentId).toBe(a.ids.agentId);
      expect(m.entityId).toBe(a.ids.entityId);
      expect(m.roomId).toBe(a.ids.roomId);
    }
  });

  it("memoryDays widens the daily-log CURRENT window over the same home", () => {
    const wide = buildMigrationPlan({
      from: FIXTURE,
      agentId: "tess",
      firewall: false,
      memoryDays: 10_000,
    });
    const narrow = buildMigrationPlan({
      from: FIXTURE,
      agentId: "tess",
      firewall: false,
      memoryDays: 0,
    });
    expect(wide.summary.dailyLogsTotal).toBe(2);
    expect(narrow.summary.dailyLogsTotal).toBe(2);
    const wideText = wide.memories.map((m) => m.content.text).join("\n");
    expect(wideText).toContain("daily log 2026-06-29");
    expect(wideText).toContain("recent daily log content");
    expect(wideText).toContain("daily log 2024-01-01");
    const narrowText = narrow.memories.map((m) => m.content.text).join("\n");
    // Outside the window logs are NOT flat-seeded; only the older-history
    // marker stands in for them.
    expect(narrowText).not.toContain("recent daily log content");
    expect(narrowText).toContain("[MARKER] Older history");
  });

  it("summary mirrors the source home provenance", () => {
    const plan = buildMigrationPlan({
      from: FIXTURE,
      agentId: "tess",
      firewall: false,
      memoryDays: 10_000,
    });
    expect(plan.summary).toMatchObject({
      dailyLogsTotal: 2,
      namedMemoryTotal: 3,
      hasUser: true,
      firewalled: false,
      hasSecretsDir: true,
      duplicatesDropped: 0,
      clipped: 0,
      sqliteStores: 0,
      sqliteUningested: false,
    });
    // A healthy persona home yields no reader warnings.
    expect(plan.summary.warnings).toEqual([]);
  });

  it("forwards currentContext into the character system prompt", () => {
    const plan = buildMigrationPlan({
      from: FIXTURE,
      agentId: "tess",
      currentContext: "right now: index coverage run",
    });
    expect(plan.character.system).toContain("CURRENT CONTEXT");
    expect(plan.character.system).toContain("right now: index coverage run");
  });

  it("builds an empty-but-valid plan for a missing home, with a warning", () => {
    const plan = buildMigrationPlan({
      from: path.join(FIXTURE, "does-not-exist"),
      agentId: "ghost",
    });
    expect(plan.summary.dailyLogsTotal).toBe(0);
    expect(plan.summary.namedMemoryTotal).toBe(0);
    // The firewalled marker is still seeded so downstream never gets silence.
    expect(plan.memories).toHaveLength(1);
    expect(plan.summary.warnings.some((w) => /No persona/i.test(w))).toBe(true);
  });
});

describe("archiveFromPlan", () => {
  it("encrypts the plan so real decryption restores its ids and memories", async () => {
    const plan = buildMigrationPlan({
      from: FIXTURE,
      agentId: "tess",
      firewall: false,
      memoryDays: 10_000,
    });
    const archive = await archiveFromPlan(
      plan,
      "tess",
      "correct-horse-battery",
    );
    expect(archive).toBeInstanceOf(Buffer);

    interface ArchivePayload {
      sourceAgentId: string;
      agent: { id?: string };
      characterConfig?: { name?: string };
      rooms: Array<{ id?: string }>;
      participants: Array<{ entityId?: string }>;
      memories: MigratedMemory[];
    }
    const payload = decryptPayload(
      archive,
      "correct-horse-battery",
    ) as ArchivePayload;

    expect(payload.sourceAgentId).toBe("tess");
    expect(payload.agent.id).toBe(plan.ids.agentId);
    expect(payload.rooms[0]?.id).toBe(plan.ids.roomId);
    expect(payload.participants[0]?.entityId).toBe(plan.ids.entityId);
    expect(payload.characterConfig?.name).toBe("Tess");
    // Every migrated memory rides along unchanged.
    expect(payload.memories.length).toBeGreaterThan(3);
    expect(payload.memories).toEqual(plan.memories);
  });

  it("enforces the shared MIN_PASSWORD_LENGTH policy", async () => {
    const plan = buildMigrationPlan({
      from: FIXTURE,
      agentId: "tess",
      firewall: false,
    });
    await expect(archiveFromPlan(plan, "tess", "")).rejects.toThrow(
      new RegExp(`at least ${MIN_PASSWORD_LENGTH} characters`),
    );
    const short = "x".repeat(MIN_PASSWORD_LENGTH - 1);
    await expect(archiveFromPlan(plan, "tess", short)).rejects.toThrow(
      new RegExp(`at least ${MIN_PASSWORD_LENGTH} characters`),
    );
    const ok = await archiveFromPlan(
      plan,
      "tess",
      "y".repeat(MIN_PASSWORD_LENGTH),
    );
    expect(ok.length).toBeGreaterThan(MAGIC.length + 4 + 32 + 12 + 16);
  });
});

describe("emitSovereignArtifacts", () => {
  it("emits compact character JSON and ordered JSONL rows with tier provenance", () => {
    const plan = buildMigrationPlan({
      from: FIXTURE,
      agentId: "tess",
      firewall: false,
      memoryDays: 10_000,
    });
    const { characterJson, memoriesJsonl } = emitSovereignArtifacts(plan);
    expect(JSON.parse(characterJson)).toEqual(plan.character);
    const rows = memoriesJsonl
      .split("\n")
      .map((line) => JSON.parse(line) as { text: string; tier?: string });
    expect(rows).toHaveLength(plan.memories.length);
    rows.forEach((row, i) => {
      expect(row.text).toBe(plan.memories[i]?.content.text);
      expect(row.tier).toBe(plan.memories[i]?.metadata.tier);
    });
    // A wide sovereign window seeds all three corpus tiers.
    const tiers = new Set(rows.map((r) => r.tier));
    expect(tiers.has("CURRENT")).toBe(true);
    expect(tiers.has("LONGTERM")).toBe(true);
    expect(tiers.has("SELF")).toBe(true);
  });

  it("coerces non-string bodies and absent tiers at the seed boundary", () => {
    const weirdMemory = {
      id: "00000000-0000-0000-0000-000000000001",
      entityId: "00000000-0000-0000-0000-00000000e001",
      agentId: "00000000-0000-0000-0000-00000000a001",
      roomId: "00000000-0000-0000-0000-00000000r001",
      createdAt: 0,
      content: { text: 42 },
      metadata: {},
    } as unknown as MigratedMemory;
    const synthetic = {
      character: { name: "Edge" },
      memories: [weirdMemory],
    } as unknown as MigratePlan;

    const { characterJson, memoriesJsonl } = emitSovereignArtifacts(synthetic);
    expect(JSON.parse(characterJson)).toEqual({ name: "Edge" });
    const row = JSON.parse(memoriesJsonl) as { text?: string; tier?: string };
    // Non-string body -> empty string; missing tier -> dropped by JSON.
    expect(row.text).toBe("");
    expect(row.tier).toBeUndefined();
  });
});
