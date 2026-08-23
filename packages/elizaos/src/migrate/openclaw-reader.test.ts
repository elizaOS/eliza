/**
 * Coverage for the OpenClaw agent-home reader beside the utc-year suite that
 * already lives next to it: home-layout resolution (flat / workspace /
 * workspace.default, with flat winning), persona and curated-memory reads,
 * awareness preference order, daily/named memory classification and ordering,
 * non-file and non-markdown skips, CRLF normalization at the read boundary,
 * secrets-dir flagging, sqlite-store detection plus the detect-vs-ingest
 * warning contract, and the key-classification predicates.
 *
 * Drives the real exported reader against real temp directories (and real
 * sqlite bytes when this runtime exposes node:sqlite) — no mocks.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  isPlaybookMemory,
  isSelfMemory,
  PLAYBOOK_MEMORY_KEYS,
  readOcAgentHome,
  SELF_MEMORY_KEYS,
} from "./openclaw-reader.js";

const made: string[] = [];

function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "oc-reader-"));
  made.push(home);
  return home;
}

function write(root: string, relPath: string, text: string): void {
  const full = path.join(root, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text, "utf8");
}

/** Mirrors the reader's own lazy guard for the optional node:sqlite builtin. */
function sqliteReadable(): boolean {
  try {
    const mod = createRequire(import.meta.url)("node:sqlite") as {
      DatabaseSync?: unknown;
    };
    return typeof mod.DatabaseSync === "function";
  } catch {
    return false;
  }
}
const SQLITE_OK = sqliteReadable();

type MinimalDb = {
  prepare(sql: string): { run(...params: unknown[]): unknown };
  close(): void;
};

function writeSqliteStore(
  memoryDir: string,
  name: string,
  rows: Array<[p: string, startLine: number, text: string]>,
): void {
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
    DatabaseSync: new (file: string) => MinimalDb;
  };
  const file = path.join(memoryDir, `${name}.sqlite`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    db.prepare(
      "CREATE TABLE chunks (path TEXT, start_line INTEGER, text TEXT)",
    ).run();
    for (const [p, line, text] of rows) {
      db.prepare(
        "INSERT INTO chunks (path, start_line, text) VALUES (?, ?, ?)",
      ).run(p, line, text);
    }
  } finally {
    db.close();
  }
}

afterEach(() => {
  while (made.length > 0) {
    const dir = made.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("missing and bare homes", () => {
  it("returns a tolerated empty source for a home that does not exist", () => {
    const missing = path.join(makeHome(), "no-such-agent");
    const source = readOcAgentHome(missing, "kai");
    expect(source.agentId).toBe("kai");
    expect(source.home).toBe(missing);
    expect(source.soul).toBeUndefined();
    expect(source.identity).toBeUndefined();
    expect(source.agents).toBeUndefined();
    expect(source.user).toBeUndefined();
    expect(source.tools).toBeUndefined();
    expect(source.curatedMemory).toBeUndefined();
    expect(source.curatedMemoryFile).toBeUndefined();
    expect(source.awareness).toBeUndefined();
    expect(source.dailyLogs).toEqual([]);
    expect(source.namedMemory).toEqual([]);
    expect(source.sqliteStores).toEqual([]);
    expect(source.sqliteUningested).toBe(false);
    expect(source.hasSecretsDir).toBe(false);
    expect(source.warnings).toHaveLength(1);
    expect(source.warnings[0]).toContain("No persona");
    expect(source.warnings[0]).toContain(missing);
  });

  it("warns exactly once for an existing but completely bare home", () => {
    const home = makeHome();
    const source = readOcAgentHome(home, "kai");
    expect(source.home).toBe(home);
    expect(source.warnings).toHaveLength(1);
    expect(source.warnings[0]).toContain("No persona");
  });
});

describe("flat homes", () => {
  it("reads every persona file, curated memory, and classifies the memory dir", () => {
    const home = makeHome();
    write(home, "SOUL.md", "soul-text");
    write(home, "IDENTITY.md", "identity-text");
    write(home, "AGENTS.md", "agents-text");
    write(home, "USER.md", "user-text");
    write(home, "TOOLS.md", "tools-text");
    write(home, "MEMORY.md", "curated-text");
    write(home, "memory/2026-05-01.md", "may-day");
    write(home, "memory/2026-04-01.md", "april-day");
    write(home, "memory/conversation-playbook.md", "playbook-text");
    write(home, "memory/grocery-list.md", "grocery-text");
    write(home, "memory/kai-awareness.md", "awareness-text");
    write(home, "memory/notes.txt", "ignored");

    const source = readOcAgentHome(home, "kai");
    expect(source.home).toBe(home);
    expect(source.soul).toBe("soul-text");
    expect(source.identity).toBe("identity-text");
    expect(source.agents).toBe("agents-text");
    expect(source.user).toBe("user-text");
    expect(source.tools).toBe("tools-text");
    expect(source.curatedMemory).toBe("curated-text");
    expect(source.curatedMemoryFile).toBe("MEMORY.md");
    expect(source.awareness).toBe("awareness-text");
    expect(source.dailyLogs.map((log) => log.filename)).toEqual([
      "2026-05-01.md",
      "2026-04-01.md",
    ]);
    expect(source.dailyLogs.map((log) => log.text)).toEqual([
      "may-day",
      "april-day",
    ]);
    // The awareness file is also classified into namedMemory; only its
    // promotion to `awareness` is keyed by the agent slug.
    expect(source.namedMemory.map((m) => m.key)).toEqual([
      "conversation-playbook",
      "grocery-list",
      "kai-awareness",
    ]);
    expect(source.namedMemory[0]).toMatchObject({
      key: "conversation-playbook",
      filename: "conversation-playbook.md",
      text: "playbook-text",
    });
    expect(source.hasSecretsDir).toBe(false);
    expect(source.warnings).toEqual([]);
  });

  it("orders daily logs newest-first regardless of directory iteration order", () => {
    const home = makeHome();
    write(home, "SOUL.md", "soul");
    write(home, "memory/2026-03-01.md", "third-written-first");
    write(home, "memory/2026-01-01.md", "first");
    write(home, "memory/2026-02-01.md", "second");
    const source = readOcAgentHome(home, "kai");
    expect(source.dailyLogs.map((log) => log.date)).toEqual([
      "2026-03-01",
      "2026-02-01",
      "2026-01-01",
    ]);
  });

  it("sorts named memory by key, not by on-disk order", () => {
    const home = makeHome();
    write(home, "memory/zebra.md", "z");
    write(home, "memory/alpha.md", "a");
    write(home, "memory/mike.md", "m");
    const source = readOcAgentHome(home, "kai");
    expect(source.namedMemory.map((m) => m.key)).toEqual([
      "alpha",
      "mike",
      "zebra",
    ]);
    expect(source.dailyLogs).toEqual([]);
  });

  it("handles single-element memory queues in both classes", () => {
    const onlyDaily = makeHome();
    write(onlyDaily, "memory/2026-05-05.md", "one-log");
    const dailySource = readOcAgentHome(onlyDaily, "kai");
    expect(dailySource.dailyLogs).toHaveLength(1);
    expect(dailySource.namedMemory).toEqual([]);

    const onlyNamed = makeHome();
    write(onlyNamed, "memory/journal.md", "one-named");
    const namedSource = readOcAgentHome(onlyNamed, "kai");
    expect(namedSource.namedMemory).toHaveLength(1);
    expect(namedSource.dailyLogs).toEqual([]);
  });

  it("skips non-markdown entries and directories whose name ends in .md", () => {
    const home = makeHome();
    write(home, "memory/notes.txt", "not markdown");
    fs.mkdirSync(path.join(home, "memory", "folder.md"));
    write(home, "memory/folder.md/inner.txt", "inside a dir");
    const source = readOcAgentHome(home, "kai");
    expect(source.dailyLogs).toEqual([]);
    expect(source.namedMemory).toEqual([]);
  });

  it("normalizes CRLF and lone CR line endings to LF", () => {
    const home = makeHome();
    write(home, "SOUL.md", "first\r\nsecond\rlast\r");
    write(home, "memory/2026-01-02.md", "d1\r\nd2\r");
    const source = readOcAgentHome(home, "kai");
    expect(source.soul).toBe("first\nsecond\nlast\n");
    expect(source.dailyLogs[0]?.text).toBe("d1\nd2\n");
  });

  it("reports the legacy lowercase curated file under its on-disk name", () => {
    const home = makeHome();
    write(home, "memory.md", "legacy-brain");
    const source = readOcAgentHome(home, "kai");
    expect(source.curatedMemory).toBe("legacy-brain");
    expect(source.curatedMemoryFile).toBe("memory.md");
  });

  it("flags an existing secrets/ directory without exposing its contents", () => {
    const home = makeHome();
    write(home, "secrets/key.txt", "topsecret");
    const source = readOcAgentHome(home, "kai");
    expect(source.hasSecretsDir).toBe(true);
    expect(JSON.stringify(source)).not.toContain("topsecret");
  });
});

describe("nested homes", () => {
  it("resolves a workspace/ subroot and reads persona + memory from it", () => {
    const home = makeHome();
    write(home, "workspace/SOUL.md", "nested-soul");
    write(home, "workspace/memory/2026-06-15.md", "nested-day");
    const source = readOcAgentHome(home, "kai");
    expect(source.home).toBe(path.join(home, "workspace"));
    expect(source.soul).toBe("nested-soul");
    expect(source.dailyLogs.map((log) => log.filename)).toEqual([
      "2026-06-15.md",
    ]);
    expect(source.warnings).toEqual([]);
  });

  it("falls back to workspace.default when no other root matches", () => {
    const home = makeHome();
    write(home, "workspace.default/SOUL.md", "default-soul");
    const source = readOcAgentHome(home, "kai");
    expect(source.home).toBe(path.join(home, "workspace.default"));
    expect(source.soul).toBe("default-soul");
  });

  it("prefers the flat root once it holds any recognizable persona file", () => {
    const home = makeHome();
    write(home, "AGENTS.md", "flat-agents");
    write(home, "workspace/SOUL.md", "nested-soul");
    const source = readOcAgentHome(home, "kai");
    expect(source.home).toBe(home);
    expect(source.agents).toBe("flat-agents");
    expect(source.soul).toBeUndefined();
  });

  it("resolves via the memory dir alone and skips the empty-home warning", () => {
    const home = makeHome();
    write(home, "workspace/memory/2026-07-04.md", "day");
    const source = readOcAgentHome(home, "kai");
    expect(source.home).toBe(path.join(home, "workspace"));
    expect(source.dailyLogs).toHaveLength(1);
    expect(source.warnings.some((w) => w.includes("No persona"))).toBe(false);
  });
});

describe("awareness resolution", () => {
  it("prefers <agentId>-awareness.md over any other *-awareness.md", () => {
    const home = makeHome();
    write(home, "memory/zoe-awareness.md", "ZOE");
    write(home, "memory/kai-awareness.md", "KAI");
    const source = readOcAgentHome(home, "kai");
    expect(source.awareness).toBe("KAI");
  });

  it("falls back to another *-awareness.md when the preferred one is absent", () => {
    const home = makeHome();
    write(home, "memory/zoe-awareness.md", "ZOE");
    expect(readOcAgentHome(home, "kai").awareness).toBe("ZOE");
    expect(readOcAgentHome(home, "zoe").awareness).toBe("ZOE");
  });

  it("leaves awareness undefined when no awareness file exists", () => {
    const home = makeHome();
    write(home, "memory/journal.md", "plain named memory");
    expect(readOcAgentHome(home, "kai").awareness).toBeUndefined();
  });
});

describe("sqlite memory stores", () => {
  it("detects every *.sqlite store sorted by name with byte sizes", () => {
    const home = makeHome();
    write(home, "SOUL.md", "soul");
    write(home, "memory/builder.sqlite", "1234567");
    write(home, "memory/aardvark.sqlite", "123");
    const source = readOcAgentHome(home, "kai");
    expect(source.sqliteStores.map((s) => s.name)).toEqual([
      "aardvark",
      "builder",
    ]);
    expect(source.sqliteStores[0]?.bytes).toBe(3);
    expect(source.sqliteStores[1]?.bytes).toBe(7);
    expect(source.sqliteStores[0]?.file).toBe(
      path.join(home, "memory", "aardvark.sqlite"),
    );
  });

  it("surfaces unreadable sqlite stores loudly instead of emitting silence", () => {
    const home = makeHome();
    write(home, "SOUL.md", "soul");
    write(home, "memory/broken.sqlite", "this is not a database");
    const source = readOcAgentHome(home, "kai");
    expect(source.sqliteUningested).toBe(true);
    expect(source.dailyLogs).toEqual([]);
    expect(source.namedMemory).toEqual([]);
    expect(source.warnings).toHaveLength(1);
    expect(source.warnings[0]).toContain("DETECTED 1 sqlite memory store(s)");
    expect(source.warnings[0]).toContain("[broken]");
    expect(source.warnings[0]).toContain("could NOT read");
  });

  it.runIf(SQLITE_OK)(
    "ingests chunked prose from a real store and merges it with markdown",
    () => {
      const home = makeHome();
      write(home, "memory/2026-06-01.md", "markdown-day");
      writeSqliteStore(path.join(home, "memory"), "store-a", [
        ["2026-07-01.md", 0, "day one"],
        ["2026-07-01.md", 0, "DUPLICATE CHUNK SAME LINE"],
        ["2026-07-01.md", 1, "more day"],
        ["journal.md", 0, "JB"],
        ["kai-awareness.md", 0, "AW"],
      ]);

      const source = readOcAgentHome(home, "kai");
      expect(source.sqliteUningested).toBe(false);
      expect(source.awareness).toBe("AW");
      expect(source.dailyLogs.map((log) => log.filename)).toEqual([
        "2026-07-01.md",
        "2026-06-01.md",
      ]);
      const ingested = source.dailyLogs.find(
        (log) => log.filename === "2026-07-01.md",
      );
      expect(ingested?.text).toBe("day one\nmore day");
      expect(ingested?.text).not.toContain("DUPLICATE");
      expect(source.namedMemory.find((m) => m.key === "journal")).toMatchObject(
        { filename: "journal.md", text: "JB" },
      );
      expect(source.warnings[0]).toContain(
        "Read sqlite memory (best-effort) from store-a.sqlite",
      );
    },
  );

  it.runIf(SQLITE_OK)(
    "targets the store matching the agent slug and leaves others unattempted",
    () => {
      const home = makeHome();
      writeSqliteStore(path.join(home, "memory"), "kai", [
        ["2026-08-01.md", 0, "kai-day"],
      ]);
      writeSqliteStore(path.join(home, "memory"), "other", [
        ["2026-08-02.md", 0, "other-day"],
      ]);

      const source = readOcAgentHome(home, "kai");
      expect(source.sqliteStores.map((s) => s.name)).toEqual(["kai", "other"]);
      expect(source.dailyLogs.map((log) => log.filename)).toEqual([
        "2026-08-01.md",
      ]);
      expect(source.warnings.join("\n")).toContain("kai.sqlite");
      expect(source.warnings.join("\n")).not.toContain("other.sqlite");
    },
  );
});

describe("key classification predicates", () => {
  it("classifies every declared self-memory key, case-insensitively", () => {
    for (const key of SELF_MEMORY_KEYS) {
      expect(isSelfMemory(key)).toBe(true);
      expect(isSelfMemory(key.toUpperCase())).toBe(true);
    }
  });

  it("classifies every declared playbook key, case-insensitively", () => {
    for (const key of PLAYBOOK_MEMORY_KEYS) {
      expect(isPlaybookMemory(key)).toBe(true);
      expect(isPlaybookMemory(key.toUpperCase())).toBe(true);
    }
  });

  it("rejects unrelated keys and keeps the two classes disjoint", () => {
    expect(isSelfMemory("grocery-list")).toBe(false);
    expect(isPlaybookMemory("grocery-list")).toBe(false);
    expect(isSelfMemory("channel-guide")).toBe(false);
    expect(isPlaybookMemory("journal")).toBe(false);
    expect(isSelfMemory("weekly-inner-state-dump")).toBe(true);
    expect(isPlaybookMemory("the-conversation-playbook-doc")).toBe(true);
  });
});
