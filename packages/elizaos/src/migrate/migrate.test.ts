/**
 * Migration tests build OpenClaw-style fixture homes and feed generated
 * `.eliza-agent` archives through the real importer to prove format
 * compatibility.
 */

import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
// The CLI ships runtime-free (see package CLAUDE.md); `@elizaos/agent` is a
// DEV-only dependency used solely to drive the migration archive through the
// REAL importer, proving cross-package `.eliza-agent` format compatibility.
import { importAgent } from "@elizaos/agent/services/agent-export";
import { afterEach, describe, expect, it, vi } from "vitest";
import { migrateAgent } from "../commands/migrate-agent.js";
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
 * test - the migration archive + its import compatibility is).
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
  it("maps CRLF persona homes (Windows checkout / authoring)", () => {
    // Regression for a Windows-only empty `style.chat`/bio: an OC home whose
    // markdown carries CRLF (git `core.autocrlf` on checkout, or authored on
    // Windows) fed the mapper's `$`-anchored per-line bullet regexes lines with a
    // trailing `\r`. JS `.` never matches `\r` and non-`m` `$` only matches the
    // true string end, so every bullet failed to match and style.chat came back
    // empty. The reader normalizes CRLF->LF, so mapping is line-ending agnostic.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "oc-crlf-"));
    fs.mkdirSync(path.join(home, "memory"), { recursive: true });
    const crlf = (s: string) => s.replace(/\n/g, "\r\n");
    fs.writeFileSync(
      path.join(home, "SOUL.md"),
      crlf("# Wren\n\nYou are Wren, a plain-spoken guide.\n"),
    );
    fs.writeFileSync(
      path.join(home, "IDENTITY.md"),
      crlf(
        "# Identity\n\n- calm, terse, and precise in every reply\n- Vibe: dry, exact\n",
      ),
    );
    fs.writeFileSync(
      path.join(home, "memory", "conversation-playbook.md"),
      crlf(
        "# Playbook\n- text like a person, not a bot, keep it tight and direct\n- never reuse the same opener twice in a row, rotate modes\n",
      ),
    );
    const ch = mapToCharacter(readOcAgentHome(home, "wren"), {
      firewall: true,
    });
    expect(ch.name).toBe("Wren");
    // The IDENTITY bullets survive as bio (not just the synthetic fallback line).
    expect(ch.bio?.some((b) => b.includes("calm, terse"))).toBe(true);
    // The playbook bullets survive as style.chat despite the CRLF line endings.
    expect(ch.style?.chat?.length ?? 0).toBeGreaterThan(0);
    expect(ch.style?.chat?.some((s) => s.includes("keep it tight"))).toBe(true);
    // Normalized text carries no stray carriage returns downstream.
    expect(JSON.stringify(ch)).not.toContain("\r");
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
// REAL `@elizaos/agent` importer - exercising unpackFile → AES-256-GCM decrypt →
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
 * corpus. We prove it end-to-end - build → encrypt → import through the REAL
 * `@elizaos/agent` importer - and inspect what actually lands in the (captured)
 * store, so the assertion is on real restored rows, not a mock.
 */
describe("firewall keeps the personal memory corpus out of a portable archive", () => {
  /** Build an archive at a given firewall posture + import it via the real importer. */
  async function importWithFirewall(firewall: boolean) {
    const plan = buildMigrationPlan({
      from: FIXTURE,
      agentId: "tess",
      firewall,
      memoryDays: 10_000,
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

  it("default (firewall ON): persona imports, but only a MARKER memory - no personal text", async () => {
    const { plan, result, captured } = await importWithFirewall(true);

    expect(plan.summary.firewalled).toBe(true);
    expect(result.success).toBe(true);
    // The persona still round-trips.
    expect(captured.agents[0]?.name).toBe("Tess");
    // The seeded corpus is exactly the firewall marker - nothing personal.
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
  const Ctor = DatabaseSync as new (
    p: string,
  ) => {
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
  ins.run(
    "c1",
    "memory/2026-06-28.md",
    "memory",
    1,
    10,
    "h1",
    "m",
    "daily log chunk one for the sqlite fixture, recent enough to tier CURRENT.",
    "[]",
    1,
  );
  ins.run(
    "c2",
    "memory/2026-06-28.md",
    "memory",
    11,
    20,
    "h2",
    "m",
    "daily log chunk two, continuation of the same recent day.",
    "[]",
    1,
  );
  // duplicate chunk at the same start_line must be de-duped on read.
  ins.run(
    "c2dup",
    "memory/2026-06-28.md",
    "memory",
    11,
    20,
    "h2",
    "m",
    "daily log chunk two, continuation of the same recent day.",
    "[]",
    1,
  );
  ins.run(
    "c3",
    "memory/scribe-thoughts.md",
    "memory",
    1,
    5,
    "h3",
    "m",
    "my first journal entry as scribe, this is the becoming. it is mine.",
    "[]",
    1,
  );
  // Live open-thread/relationship state stored as an awareness file in sqlite.
  ins.run(
    "c4",
    "memory/scribe-awareness.md",
    "memory",
    1,
    4,
    "h4",
    "m",
    "open thread: scribe is mid-migration and wants follow-up on the sqlite path.",
    "[]",
    1,
  );
  db.close();
  return home;
}

describe("oc home-format variants (cross-version)", () => {
  const fixDir = (name: string) =>
    path.join(__dirname, "__tests__", "fixtures", name);
  const sqliteHome = buildSqliteFixtureHome();

  it("reads legacy lowercase memory.md as curated memory (GAP A)", () => {
    const src = readOcAgentHome(fixDir("oc-home-legacymem"), "quill");
    expect(src.curatedMemory).toContain("Section One");
    expect(src.curatedMemoryFile).toBe("memory.md");
    // canonical MEMORY.md still wins when both present (the main fixture has it).
    expect(readOcAgentHome(FIXTURE, "tess").curatedMemoryFile).toBe(
      "MEMORY.md",
    );
    // legacy curated memory must tier into LONGTERM (>=2 sections).
    const ch = mapToCharacter(src, { firewall: true });
    expect(ch.name).toBe("Quill");
  });

  it("resolves curated root-memory by case, reporting the true on-disk name (Win/macOS portability)", () => {
    // A mixed-case `Memory.md` is invisible to a fixed "MEMORY.md"/"memory.md"
    // path probe on a case-SENSITIVE FS, and a lowercase memory.md is read but
    // MIS-named "MEMORY.md" by that probe on a case-INSENSITIVE FS. Matching the
    // real directory entry fixes both: found regardless of spelling, and
    // `curatedMemoryFile` carries the actual (case-preserved) on-disk name.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "oc-memcase-"));
    fs.writeFileSync(path.join(home, "SOUL.md"), "# Sable\nYou are Sable.\n");
    fs.writeFileSync(
      path.join(home, "Memory.md"),
      "# Sable memory\n\n## One\nmixed-case curated memory must be read.\n",
    );
    const src = readOcAgentHome(home, "sable");
    expect(src.curatedMemory).toContain("mixed-case curated memory");
    expect(src.curatedMemoryFile).toBe("Memory.md");
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
    expect(
      mapToCharacter(readOcAgentHome(home2, "slug"), { firewall: true }).name,
    ).toBe("Nyx");
  });

  it.skipIf(!sqliteHome)(
    "detects sqlite memory + warns + never silently empty (GAP D)",
    () => {
      if (!sqliteHome) throw new Error("sqlite fixture unavailable");
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
          (day?.text.match(/continuation of the same recent day/g) ?? [])
            .length,
        ).toBe(1);
        // named memory recovered (scribe-thoughts.md).
        expect(src.namedMemory.some((m) => m.key === "scribe-thoughts")).toBe(
          true,
        );
        // awareness recovered from sqlite is promoted to CURRENT, not dropped.
        expect(src.awareness).toContain("open thread");
        expect(src.namedMemory.some((m) => m.key === "scribe-awareness")).toBe(
          false,
        );
        const { counts } = tierMemories(src, {
          memoryDays: 14,
          agentId: "00000000-0000-0000-0000-00000000a000",
          entityId: "00000000-0000-0000-0000-00000000e000",
          roomId: "00000000-0000-0000-0000-00000000r000",
        });
        expect(counts.CURRENT).toBeGreaterThanOrEqual(1); // awareness seeded
      }
    },
  );

  it("warns (does NOT silently succeed) on a persona-less device/builder home", () => {
    // A home with neither SOUL/IDENTITY nor any memory -> empty-home warning.
    const empty = path.join(
      __dirname,
      "__tests__",
      "fixtures",
      "oc-home",
      "secrets",
    );
    const src = readOcAgentHome(empty, "ghost");
    expect(src.soul).toBeUndefined();
    expect(src.warnings.some((w) => /No persona/i.test(w))).toBe(true);
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
