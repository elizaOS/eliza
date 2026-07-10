/**
 * End-to-end Signal collector test. Builds a real SQLite database with Signal's
 * `messages`/`conversations` schema, writes it where the collector expects the
 * encrypted db, and injects a plaintext opener that runs the production query
 * (the SQLCipher `PRAGMA key` step is the only owner-gated difference). This
 * drives the full path — key resolve, db copy, real query, normalization, shard
 * write, checkpoint — against a real query engine, then asserts the output
 * validates, resumes idempotently, and that the decrypted copy is wiped even
 * when the read fails.
 *
 * Runs under whichever SQLite runtime the harness provides (`node:sqlite` on
 * Node 24, `bun:sqlite` under Bun); it skips only if neither exists.
 */

import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CORPUS_CUTOFF_MS } from "../schema.ts";
import { validateCorpusTarget } from "../validator.ts";
import { isCollectorError } from "./errors.ts";
import { collectSignal } from "./signal.ts";
import {
  createSignalDatabase,
  openSqlcipherDatabase,
  type SignalDatabase,
  type SignalDatabaseOpener,
} from "./signal-db.ts";

const runtimeRequire = createRequire(import.meta.url);
const SAMPLE_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const JULY = Date.parse("2024-07-10T12:00:00.000Z");

interface FixtureDb {
  exec(sql: string): void;
  run(sql: string, params: unknown[]): void;
  openReadonly(): {
    all(sql: string, params: unknown[]): unknown[];
    close(): void;
  };
  close(): void;
}

/** Resolve a SQLite runtime (Node built-in preferred, then Bun) or null. */
async function loadSqlite(): Promise<
  ((filePath: string, readOnly: boolean) => FixtureDb) | null
> {
  try {
    const mod = (await import("node:sqlite")) as {
      DatabaseSync?: new (
        p: string,
        o?: { readOnly?: boolean },
      ) => {
        exec(sql: string): void;
        prepare(sql: string): {
          all(...p: unknown[]): unknown[];
          run(...p: unknown[]): unknown;
        };
        close(): void;
      };
    };
    const DatabaseSync = mod.DatabaseSync;
    if (DatabaseSync) {
      return (filePath, readOnly) => {
        const db = new DatabaseSync(filePath, { readOnly });
        return {
          exec: (sql) => db.exec(sql),
          run: (sql, params) => {
            db.prepare(sql).run(...params);
          },
          openReadonly: () => ({
            all: (sql, params) => db.prepare(sql).all(...params) as unknown[],
            close: () => db.close(),
          }),
          close: () => db.close(),
        };
      };
    }
  } catch {
    // fall through to Bun
  }
  try {
    const mod = runtimeRequire("bun:sqlite") as {
      Database?: new (
        p: string,
        o?: { readonly?: boolean },
      ) => {
        run(sql: string, ...p: unknown[]): unknown;
        query(sql: string): { all(...p: unknown[]): unknown[] };
        close(): void;
      };
    };
    const Database = mod.Database;
    if (Database) {
      return (filePath, readOnly) => {
        const db = new Database(filePath, { readonly: readOnly });
        return {
          exec: (sql) => {
            db.run(sql);
          },
          run: (sql, params) => {
            db.run(sql, ...params);
          },
          openReadonly: () => ({
            all: (sql, params) => db.query(sql).all(...params),
            close: () => db.close(),
          }),
          close: () => db.close(),
        };
      };
    }
  } catch {
    // neither runtime
  }
  return null;
}

const SCHEMA = `
  CREATE TABLE conversations (
    id TEXT PRIMARY KEY,
    json TEXT,
    type TEXT,
    name TEXT,
    e164 TEXT,
    serviceId TEXT
  );
  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    json TEXT,
    sent_at INTEGER,
    received_at INTEGER,
    conversationId TEXT,
    type TEXT,
    body TEXT,
    source TEXT,
    sourceServiceId TEXT
  );
`;

async function seedSignalDir(
  openDb: (filePath: string, readOnly: boolean) => FixtureDb,
): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "signal-e2e-"));
  await writeFile(
    path.join(dir, "config.json"),
    JSON.stringify({ key: SAMPLE_KEY }),
    "utf8",
  );
  await mkdir(path.join(dir, "sql"), { recursive: true });
  const dbPath = path.join(dir, "sql", "db.sqlite");
  const db = openDb(dbPath, false);
  db.exec(SCHEMA);
  db.run(
    "INSERT INTO conversations (id, type, name, e164, serviceId) VALUES (?, ?, ?, ?, ?)",
    ["conv-1", "private", "Alice", "+15551230000", "peer-service"],
  );
  const insert = (row: {
    id: string;
    received_at: number;
    type: string;
    body: string | null;
    source: string;
    json?: string;
  }) =>
    db.run(
      "INSERT INTO messages (id, json, sent_at, received_at, conversationId, type, body, source, sourceServiceId) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        row.id,
        row.json ?? null,
        row.received_at - 50,
        row.received_at,
        "conv-1",
        row.type,
        row.body,
        row.source,
        null,
      ],
    );
  insert({
    id: "m1",
    received_at: JULY,
    type: "incoming",
    body: "hi there",
    source: "peer-uuid",
  });
  insert({
    id: "m2",
    received_at: JULY + 1000,
    type: "outgoing",
    body: "reply",
    source: "",
  });
  // Attachment-only row (no body) — must be skipped, not fabricated.
  insert({
    id: "m3",
    received_at: JULY + 2000,
    type: "incoming",
    body: null,
    source: "peer-uuid",
  });
  // Body only in the json column.
  insert({
    id: "m4",
    received_at: JULY + 3000,
    type: "incoming",
    body: null,
    source: "peer-uuid",
    json: JSON.stringify({
      body: "from json",
      type: "incoming",
      received_at: JULY + 3000,
    }),
  });
  // Pre-cutoff row — must be excluded by the query bound / normalizer.
  insert({
    id: "m0",
    received_at: CORPUS_CUTOFF_MS - 5000,
    type: "incoming",
    body: "ancient",
    source: "peer-uuid",
  });
  db.close();
  return dir;
}

function plaintextOpener(
  openDb: (filePath: string, readOnly: boolean) => FixtureDb,
): SignalDatabaseOpener {
  return async (dbPath: string): Promise<SignalDatabase> => {
    const handle = openDb(dbPath, true).openReadonly();
    return createSignalDatabase(handle);
  };
}

describe("collectSignal (real SQLite path)", () => {
  it("collects, normalizes, shards, checkpoints, and wipes the copy", async () => {
    const openDb = await loadSqlite();
    if (!openDb) {
      // No SQLite runtime available; the pure key/normalize/shard suites still
      // cover the collector logic keyless.
      return;
    }
    const signalDir = await seedSignalDir(openDb);
    const outputDir = await mkdtemp(path.join(tmpdir(), "signal-out-"));
    const stateDir = await mkdtemp(path.join(tmpdir(), "signal-state-"));

    const result = await collectSignal({
      signalDir,
      outputDir,
      stateDir,
      accountId: "primary",
      ownerId: "owner-uuid",
      ownerDisplay: "Owner",
      openDatabase: plaintextOpener(openDb),
    });

    expect(result.messagesAdded).toBe(3); // m1, m2, m4
    expect(result.skipped["empty-body"]).toBe(1); // m3 has no body
    // m0 is excluded at the SQL cutoff bound, so it never reaches the normalizer.
    expect(result.skipped["before-cutoff"]).toBe(0);
    expect(result.dbCopyDeleted).toBe(true);
    expect(result.checkpoint.lastTs).toBe(JULY + 3000);
    expect(result.checkpoint.messageCount).toBe(3);

    const validation = await validateCorpusTarget(outputDir);
    expect(validation.ok).toBe(true);
    expect(validation.manifest.totals.messages).toBe(3);

    // No leftover decrypted copies in the state dir.
    const stateEntries = await readdir(stateDir);
    expect(stateEntries.some((name) => name.startsWith("signal-db-"))).toBe(
      false,
    );

    // Rerun is idempotent: nothing new added, output unchanged.
    const rerun = await collectSignal({
      signalDir,
      outputDir,
      stateDir,
      accountId: "primary",
      ownerId: "owner-uuid",
      ownerDisplay: "Owner",
      openDatabase: plaintextOpener(openDb),
    });
    expect(rerun.messagesAdded).toBe(0);
    expect(rerun.checkpoint.messageCount).toBe(3);
    const revalidation = await validateCorpusTarget(outputDir);
    expect(revalidation.manifest.totals.messages).toBe(3);

    await rm(signalDir, { recursive: true, force: true });
    await rm(outputDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  });

  it("wipes the decrypted copy even when the read fails", async () => {
    const openDb = await loadSqlite();
    if (!openDb) return;
    const signalDir = await seedSignalDir(openDb);
    const outputDir = await mkdtemp(path.join(tmpdir(), "signal-out-"));
    const stateDir = await mkdtemp(path.join(tmpdir(), "signal-state-"));

    const failingOpener: SignalDatabaseOpener = async () => {
      throw new Error("boom decrypt");
    };

    await expect(
      collectSignal({
        signalDir,
        outputDir,
        stateDir,
        accountId: "primary",
        ownerId: "owner-uuid",
        ownerDisplay: "Owner",
        openDatabase: failingOpener,
      }),
    ).rejects.toThrow(/boom decrypt/);

    const stateEntries = await readdir(stateDir);
    expect(stateEntries.some((name) => name.startsWith("signal-db-"))).toBe(
      false,
    );

    await rm(signalDir, { recursive: true, force: true });
    await rm(outputDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  });
});

describe("openSqlcipherDatabase", () => {
  it("fails closed on a non-database file (or absent cipher)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "signal-bad-"));
    const notADb = path.join(dir, "db.sqlite");
    await writeFile(notADb, "this is not sqlcipher", "utf8");
    try {
      await openSqlcipherDatabase(notADb, SAMPLE_KEY);
      throw new Error("expected a fail-closed error");
    } catch (error) {
      expect(
        isCollectorError(error, "sqlcipher_unavailable") ||
          isCollectorError(error, "db_open_failed"),
      ).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
