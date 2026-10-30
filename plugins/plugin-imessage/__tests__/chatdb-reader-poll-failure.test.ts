/**
 * The polling reader must distinguish "the database has no new rows" from
 * "the poll query could not run". `listMessages` in the same module already
 * throws IMESSAGE_CHATDB_READ_FAILED so a locked or migrated chat.db is not
 * reported as an empty mailbox; this covers the cursor-based poll path.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ElizaError } from "@elizaos/core";
import { describe, expect, it } from "vitest";

import { IMESSAGE_CHATDB_READ_FAILED, openChatDb } from "../src/chatdb-reader";

const runtimeRequire = createRequire(import.meta.url);

type FixtureDatabase = { run(sql: string): unknown; close(): void };

async function getDatabase(): Promise<((path: string) => FixtureDatabase) | null> {
  type Ctor = new (path: string) => { exec(sql: string): unknown; close(): void };
  try {
    const mod = (await import("node:sqlite")) as {
      DatabaseSync?: Ctor;
      default?: { DatabaseSync?: Ctor };
    };
    const DatabaseSync = mod.DatabaseSync ?? mod.default?.DatabaseSync;
    if (DatabaseSync) {
      return (path) => {
        const db = new DatabaseSync(path);
        return { run: (sql) => db.exec(sql), close: () => db.close() };
      };
    }
  } catch {
    // Fall through to Bun's SQLite runtime.
  }
  try {
    type BunCtor = new (
      path: string
    ) => { run?: (sql: string) => unknown; exec?: (sql: string) => unknown; close(): void };
    const mod = runtimeRequire("bun:sqlite") as { Database?: BunCtor; default?: BunCtor };
    const Database = mod.Database ?? mod.default;
    if (!Database) return null;
    return (path) => {
      const db = new Database(path);
      return { run: (sql) => (db.run ?? db.exec)?.(sql), close: () => db.close() };
    };
  } catch {
    return null;
  }
}

// Every table `openChatDb` prepares statements against, so the reader opens.
const SCHEMA = [
  "CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT, service TEXT)",
  "CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, chat_identifier TEXT, display_name TEXT, service_name TEXT, style INTEGER, last_read_message_timestamp INTEGER)",
  "CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB, date INTEGER, date_read INTEGER, date_edited INTEGER, date_retracted INTEGER, is_from_me INTEGER, is_read INTEGER, is_sent INTEGER, is_delivered INTEGER, item_type INTEGER, reply_to_guid TEXT, associated_message_guid TEXT, associated_message_type INTEGER, associated_message_emoji TEXT, cache_has_attachments INTEGER, service TEXT, handle_id INTEGER)",
  "CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER)",
  "CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER)",
  "CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY, guid TEXT, transfer_name TEXT, filename TEXT, mime_type TEXT, uti TEXT, total_bytes INTEGER, is_sticker INTEGER)",
  "CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER)",
];

describe("chat.db poll query failures", { timeout: 60_000 }, () => {
  it("rejects instead of reporting an empty inbox when the poll query cannot run", async ({
    skip,
  }) => {
    const openDatabase = await getDatabase();
    if (!openDatabase) {
      skip("No supported SQLite runtime is available for iMessage fixture tests");
      return;
    }

    const dir = mkdtempSync(join(tmpdir(), "imessage-chatdb-poll-"));
    const path = join(dir, "chat.db");
    try {
      const setup = openDatabase(path);
      for (const statement of SCHEMA) setup.run(statement);
      setup.close();

      const reader = await openChatDb(path);
      expect(reader).not.toBeNull();
      if (!reader) return;

      // Intact schema, no rows yet: an empty batch is the correct answer.
      expect(reader.fetchNewMessages(0, 50)).toEqual([]);

      // Break the schema under the already-open reader — what a macOS update,
      // a dropped table, or a swapped database looks like to a live poller.
      const mutator = openDatabase(path);
      mutator.run("DROP TABLE chat_message_join");
      mutator.close();

      let resolved: unknown;
      let rejection: unknown;
      try {
        resolved = reader.fetchNewMessages(0, 50);
      } catch (error) {
        rejection = error;
      }
      if (resolved !== undefined) {
        // Before the fix this branch is taken: the failed query was reported
        // as an empty batch, so the poll tick returned as if the inbox were
        // idle and no caller could tell a broken read from "no new messages".
        throw new Error(
          `fetchNewMessages resolved with ${JSON.stringify(resolved)} instead of rejecting`
        );
      }

      expect(rejection).toBeInstanceOf(ElizaError);
      expect((rejection as ElizaError).code).toBe(IMESSAGE_CHATDB_READ_FAILED);
      expect((rejection as ElizaError).context).toEqual({ sinceRowId: 0, limit: 50 });

      reader.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
