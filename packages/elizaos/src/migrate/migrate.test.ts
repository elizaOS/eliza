import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { migrateAgent } from "../commands/migrate-agent.js";
import { buildElizaAgentArchive } from "./archive-format.js";
import { assemblePayload } from "./archive-writer.js";
import { mapToCharacter } from "./character-mapper.js";
import { buildMigrationPlan, emitSovereignArtifacts } from "./index.js";
import { tierMemories } from "./memory-tiering.js";
import { readOcAgentHome } from "./ocplatform-reader.js";

const FIXTURE = path.join(__dirname, "__tests__", "fixtures", "oc-home");

/**
 * Reverse the self-contained V1 `.eliza-agent` format (inverse of
 * archive-format.ts) so the test can assert a true crypto round-trip without
 * importing the agent runtime. Layout: magic(15) iter(4) salt(32) iv(12)
 * tag(16) ciphertext(rest).
 */
function decryptArchive(buf: Buffer, password: string): unknown {
  let off = 15; // skip "ELIZA_AGENT_V1\n"
  const iterations = buf.readUInt32BE(off);
  off += 4;
  const salt = buf.subarray(off, off + 32);
  off += 32;
  const iv = buf.subarray(off, off + 12);
  off += 12;
  const tag = buf.subarray(off, off + 16);
  off += 16;
  const ciphertext = buf.subarray(off);
  const key = crypto.pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const compressed = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return JSON.parse(gunzipSync(compressed).toString("utf-8"));
}

describe("ocplatform-reader", () => {
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

/**
 * Build a sqlite memory fixture at test-time (matching OC's chunks/files
 * schema) so we don't commit a binary (*.sqlite is gitignored) and don't pin
 * the fixture to a node version. Returns the home dir, or null if node:sqlite
 * isn't available in this runtime (older Node) so the test can soft-skip the
 * read assertions while still exercising DETECT+WARN paths.
 */
function buildSqliteFixtureHome(): string | null {
  let DatabaseSync: unknown;
  try {
    DatabaseSync = (
      createRequire(import.meta.url)("node:sqlite") as {
        DatabaseSync?: unknown;
      }
    ).DatabaseSync;
  } catch {
    return null;
  }
  if (typeof DatabaseSync !== "function") return null;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "oc-sqlite-"));
  const memDir = path.join(home, "memory");
  fs.mkdirSync(memDir, { recursive: true });
  const Ctor = DatabaseSync as new (p: string) => {
    exec(sql: string): void;
    prepare(sql: string): { run(...args: unknown[]): unknown };
    close(): void;
  };
  const db = new Ctor(path.join(memDir, "scribe.sqlite"));
  db.exec(
    "CREATE TABLE files (path TEXT PRIMARY KEY, source TEXT NOT NULL DEFAULT 'memory', hash TEXT NOT NULL, mtime INTEGER NOT NULL, size INTEGER NOT NULL);" +
      "CREATE TABLE chunks (id TEXT PRIMARY KEY, path TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'memory', start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, hash TEXT NOT NULL, model TEXT NOT NULL, text TEXT NOT NULL, embedding TEXT NOT NULL, updated_at INTEGER NOT NULL);",
  );
  const ins = db.prepare(
    "INSERT INTO chunks (id,path,source,start_line,end_line,hash,model,text,embedding,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
  );
  ins.run("c1", "memory/2026-06-28.md", "memory", 1, 10, "h1", "m", "daily log chunk one for the sqlite fixture, recent enough to tier CURRENT.", "[]", 1);
  ins.run("c2", "memory/2026-06-28.md", "memory", 11, 20, "h2", "m", "daily log chunk two, continuation of the same recent day.", "[]", 1);
  // duplicate chunk at the same start_line must be de-duped on read.
  ins.run("c2dup", "memory/2026-06-28.md", "memory", 11, 20, "h2", "m", "daily log chunk two, continuation of the same recent day.", "[]", 1);
  ins.run("c3", "memory/scribe-thoughts.md", "memory", 1, 5, "h3", "m", "my first journal entry as scribe, this is the becoming. it is mine.", "[]", 1);
  // Live open-thread/relationship state stored as an awareness file in sqlite.
  ins.run("c4", "memory/scribe-awareness.md", "memory", 1, 4, "h4", "m", "open thread: scribe is mid-migration and wants follow-up on the sqlite path.", "[]", 1);
  db.close();
  return home;
}

describe("oc home-format variants (cross-version)", () => {
  const fixDir = (name: string) =>
    path.join(__dirname, "__tests__", "fixtures", name);
  let sqliteHome: string | null = null;
  beforeAll(() => {
    sqliteHome = buildSqliteFixtureHome();
  });

  it("reads legacy lowercase memory.md as curated memory (GAP A)", () => {
    const src = readOcAgentHome(fixDir("oc-home-legacymem"), "quill");
    expect(src.curatedMemory).toContain("Section One");
    expect(src.curatedMemoryFile).toBe("memory.md");
    // canonical MEMORY.md still wins when both present (the main fixture has it).
    expect(readOcAgentHome(FIXTURE, "tess").curatedMemoryFile).toBe("MEMORY.md");
    // legacy curated memory must tier into LONGTERM (>=2 sections).
    const ch = mapToCharacter(src, { firewall: true });
    expect(ch.name).toBe("Quill");
  });

  it("derives name + sane character from a LEANER hermes-style home (GAP B/C)", () => {
    // Lean home: SOUL + AGENTS only, NO IDENTITY/USER/TOOLS/MEMORY.
    const src = readOcAgentHome(fixDir("oc-home-lean"), "someslug");
    expect(src.identity).toBeUndefined();
    expect(src.user).toBeUndefined();
    expect(src.curatedMemory).toBeUndefined();
    // Name must come from SOUL '# vesper' heading, NOT the --agent-id slug.
    const ch = mapToCharacter(src, { firewall: true });
    expect(ch.name).toBe("Vesper");
    // Character is non-empty: SOUL drives system, AGENTS appends ops rules.
    expect((ch.system ?? "").length).toBeGreaterThan(50);
    expect(ch.system).toContain("vesper");
    // AGENTS.md content is appended under an Operating-rules section.
    expect(ch.system).toContain("Operating rules (from AGENTS.md)");
    expect(ch.system).toContain("you say it straight");
    // awareness (slug-agnostic *-awareness.md) + thoughts (SELF) are found.
    expect(src.awareness).toContain("open thread");
    const { counts } = tierMemories(src, {
      memoryDays: 14,
      agentId: "00000000-0000-0000-0000-00000000a000",
      entityId: "00000000-0000-0000-0000-00000000e000",
      roomId: "00000000-0000-0000-0000-00000000r000",
    });
    expect(counts.CURRENT).toBeGreaterThanOrEqual(1); // awareness
    expect(counts.SELF).toBeGreaterThanOrEqual(1); // vesper-thoughts.md
  });

  it("only names from a LEADING SOUL H1, not a later section heading", () => {
    // SOUL opens with prose then has a '# Voice' section: the name must fall
    // back to the agent-id slug, NOT become "Voice".
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "oc-soulhead-"));
    fs.writeFileSync(
      path.join(home, "SOUL.md"),
      "You are a careful assistant who speaks plainly.\n\n# Voice\n\nlowercase, direct.\n",
    );
    const src = readOcAgentHome(home, "atlas");
    const ch = mapToCharacter(src, { firewall: true });
    expect(ch.name).toBe("Atlas");
    expect(ch.name).not.toBe("Voice");

    // A genuine leading '# nyx' title is still used as the name.
    const home2 = fs.mkdtempSync(path.join(os.tmpdir(), "oc-soulhead2-"));
    fs.writeFileSync(
      path.join(home2, "SOUL.md"),
      "# nyx\n\nYou are nyx, a sharp companion.\n\n# Voice\n\nterse.\n",
    );
    expect(mapToCharacter(readOcAgentHome(home2, "slug"), { firewall: true }).name).toBe(
      "Nyx",
    );
  });

  it("detects sqlite memory + warns + never silently empty (GAP D)", () => {
    if (!sqliteHome) {
      // node:sqlite unavailable in this runtime: can't build the fixture, but
      // the production DETECT+WARN-without-read path is still covered by the
      // reader's own guard. Soft-skip the read assertions.
      expect(true).toBe(true);
      return;
    }
    const src = readOcAgentHome(sqliteHome, "scribe");
    // Detection ALWAYS happens regardless of node:sqlite availability.
    expect(src.sqliteStores.length).toBeGreaterThanOrEqual(1);
    expect(src.sqliteStores.some((s) => s.name === "scribe")).toBe(true);
    // A warning is ALWAYS present for a sqlite home (read-ok OR not-ported).
    expect(src.warnings.length).toBeGreaterThanOrEqual(1);
    expect(src.warnings.join(" ")).toMatch(/sqlite/i);

    if (src.sqliteUningested) {
      // node:sqlite unavailable (older Node): DETECT + WARN, no silent empty.
      expect(src.warnings.join(" ")).toMatch(/NOT ported|could NOT read/i);
    } else {
      // node:sqlite available: prose reconstructed from chunks.text.
      expect(src.dailyLogs.length).toBe(1); // 2 chunks merged, dup dropped
      const day = src.dailyLogs.find((d) => d.date === "2026-06-28");
      expect(day).toBeDefined();
      expect(day?.text).toContain("daily log chunk one");
      expect(day?.text).toContain("daily log chunk two");
      // dedup: chunk-two appears once despite the duplicate row.
      expect(
        (day?.text.match(/continuation of the same recent day/g) ?? []).length,
      ).toBe(1);
      // named memory recovered (scribe-thoughts.md).
      expect(src.namedMemory.some((m) => m.key === "scribe-thoughts")).toBe(
        true,
      );
      // awareness recovered from sqlite is promoted to CURRENT, not dropped.
      expect(src.awareness).toContain("open thread");
      expect(
        src.namedMemory.some((m) => m.key === "scribe-awareness"),
      ).toBe(false);
      const { counts } = tierMemories(src, {
        memoryDays: 14,
        agentId: "00000000-0000-0000-0000-00000000a000",
        entityId: "00000000-0000-0000-0000-00000000e000",
        roomId: "00000000-0000-0000-0000-00000000r000",
      });
      expect(counts.CURRENT).toBeGreaterThanOrEqual(1); // awareness seeded
    }
  });

  it("warns (does NOT silently succeed) on a persona-less device/builder home", () => {
    // A home with neither SOUL/IDENTITY nor any memory -> empty-home warning.
    const empty = path.join(__dirname, "__tests__", "fixtures", "oc-home", "secrets");
    const src = readOcAgentHome(empty, "ghost");
    expect(src.soul).toBeUndefined();
    expect(src.warnings.some((w) => /No persona/i.test(w))).toBe(true);
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
      expect(m.metadata.source).toBe("ocplatform-migration");
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
  it("round-trips: decrypt+decompress+parse yields a PayloadSchema-shaped object", () => {
    const plan = buildMigrationPlan({ from: FIXTURE, agentId: "tess" });
    const { payload } = assemblePayload({
      agentId: plan.ids.agentId,
      sourceSlug: "tess",
      character: plan.character,
      entityId: plan.ids.entityId,
      roomId: plan.ids.roomId,
      memories: plan.memories,
    });
    const archive = buildElizaAgentArchive(payload, "round-trip-password");
    const decoded = decryptArchive(archive, "round-trip-password") as Record<
      string,
      unknown
    >;

    // All PayloadSchema top-level fields importAgent expects must be present.
    for (const field of [
      "version",
      "exportedAt",
      "sourceAgentId",
      "agent",
      "entities",
      "memories",
      "components",
      "rooms",
      "participants",
      "relationships",
      "worlds",
      "tasks",
      "logs",
    ]) {
      expect(decoded).toHaveProperty(field);
    }
    expect(decoded.version).toBe(1);
    const agent = decoded.agent as Record<string, unknown>;
    expect(agent.name).toBe("Tess");
    const memories = decoded.memories as Array<Record<string, unknown>>;
    expect(memories.length).toBe(plan.memories.length);

    // Referential integrity: every memory points at the exported room/entity/agent.
    const room = (decoded.rooms as Array<Record<string, unknown>>)[0];
    const entity = (decoded.entities as Array<Record<string, unknown>>)[0];
    const world = (decoded.worlds as Array<Record<string, unknown>>)[0];
    for (const m of memories) {
      expect(m.roomId).toBe(room.id);
      expect(m.entityId).toBe(entity.id);
      expect(m.agentId).toBe(agent.id);
      const meta = m.metadata as Record<string, unknown>;
      expect(meta.source).toBe("ocplatform-migration");
    }
    expect(world.agentId).toBe(agent.id);

    // Firewall holds inside the archive too (default firewall=true).
    const blob =
      JSON.stringify(decoded.characterConfig) + JSON.stringify(agent);
    expect(blob).not.toContain("firewalled");
  });
  it("round-trip fails with a wrong password (auth-tag mismatch)", () => {
    const plan = buildMigrationPlan({ from: FIXTURE, agentId: "tess" });
    const { payload } = assemblePayload({
      agentId: plan.ids.agentId,
      sourceSlug: "tess",
      character: plan.character,
      entityId: plan.ids.entityId,
      roomId: plan.ids.roomId,
      memories: plan.memories,
    });
    const archive = buildElizaAgentArchive(payload, "correct-password");
    expect(() => decryptArchive(archive, "wrong-password")).toThrow();
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

describe("migrate-agent --json stdout purity (GAP E)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits ONLY parseable JSON to stdout (clack chrome suppressed)", async () => {
    let out = "";
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: unknown) => {
        out += String(chunk);
        return true;
      });
    // stderr swallowed (warnings/chrome are allowed there).
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await migrateAgent({
      from: FIXTURE,
      agentId: "tess",
      dryRun: true,
      json: true,
    });

    stdoutSpy.mockRestore();
    // The ENTIRE stdout must parse as JSON (no banner, no box-drawing).
    expect(out).not.toContain("migrate-agent:");
    expect(out).not.toContain("Migration plan");
    const parsed = JSON.parse(out);
    expect(parsed.character.name).toBe("Tess");
    expect(parsed.memoryCount).toBeGreaterThan(0);
    expect(parsed.summary).toHaveProperty("sqliteStores");
    expect(parsed.summary).toHaveProperty("warnings");
  });
});
