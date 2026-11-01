/**
 * A failed chat.db read must not be reported as an empty inbox.
 *
 * `fetchNewMessages` drives the inbound poll cursor: the service treats `[]` as
 * "nothing new this tick" and leaves the cursor where it is. When the query
 * itself fails (locked database, I/O error, or a schema the reader no longer
 * matches), `[]` is indistinguishable from a quiet inbox, so every incoming
 * message is dropped and nothing but a reader-local log line says so.
 * `listMessages` and `listChats` in the same reader already throw
 * {@link IMESSAGE_CHATDB_READ_FAILED}; this pins the polling path to the same
 * contract so the poll loop's own error handler reports it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { IMESSAGE_CHATDB_READ_FAILED, openChatDb } from "./chatdb-reader";

// The tables/columns openChatDb's prepared statements read, in the shape macOS
// Messages ships them; empty columns are enough to prepare and run the queries.
const SCHEMA = `
  CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT, service TEXT);
  CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, chat_identifier TEXT, display_name TEXT,
    service_name TEXT, style INTEGER, last_read_message_timestamp INTEGER);
  CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB,
    date INTEGER, date_read INTEGER, date_edited INTEGER, date_retracted INTEGER,
    is_from_me INTEGER, is_read INTEGER, is_sent INTEGER, is_delivered INTEGER, item_type INTEGER,
    reply_to_guid TEXT, associated_message_guid TEXT, associated_message_type INTEGER,
    associated_message_emoji TEXT, cache_has_attachments INTEGER, service TEXT, handle_id INTEGER);
  CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
  CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
  CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY, guid TEXT, transfer_name TEXT, filename TEXT,
    mime_type TEXT, uti TEXT, total_bytes INTEGER, is_sticker INTEGER);
  CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
  INSERT INTO handle (ROWID, id, service) VALUES (1, '+155****4567', 'iMessage');
  INSERT INTO chat (ROWID, chat_identifier, service_name, style, last_read_message_timestamp)
    VALUES (1, 'iMessage;-;+155****4567', 'iMessage', 45, 0);
  INSERT INTO message (ROWID, guid, text, date, is_from_me, handle_id, service)
    VALUES (10, 'guid-10', 'hello', 1000, 0, 1, 'iMessage');
  INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 10);
`;

type FixtureDatabase = { exec(sql: string): unknown; close(): void };

async function loadDatabase(): Promise<((path: string) => FixtureDatabase) | null> {
  try {
    const mod = (await import("node:sqlite")) as {
      DatabaseSync?: new (path: string) => FixtureDatabase;
      default?: { DatabaseSync?: new (path: string) => FixtureDatabase };
    };
    const DatabaseSync = mod.DatabaseSync ?? mod.default?.DatabaseSync;
    if (!DatabaseSync) return null;
    return (path) => {
      const db = new DatabaseSync(path);
      return { exec: (sql: string) => db.exec(sql), close: () => db.close() };
    };
  } catch {
    // No node:sqlite in this runtime; the caller skips the test.
    return null;
  }
}

describe("chat.db read failure reporting", () => {
  it("throws instead of returning [] when the polled query fails", async ({ skip }) => {
    const openDatabase = await loadDatabase();
    if (!openDatabase) {
      skip("No supported SQLite runtime is available for this test");
      return;
    }

    const dir = mkdtempSync(join(tmpdir(), "imessage-read-failure-"));
    const path = join(dir, "chat.db");
    try {
      const seed = openDatabase(path);
      seed.exec("PRAGMA journal_mode = MEMORY");
      seed.exec(SCHEMA);
      seed.close();

      const reader = await openChatDb(path);
      expect(reader).not.toBeNull();
      if (!reader) return;

      // Sanity: the reader works, and a cursor at the tip really is "nothing new".
      expect(reader.fetchNewMessages(0, 100).map((row) => row.rowId)).toEqual([10]);
      expect(reader.fetchNewMessages(10, 100)).toEqual([]);

      // Make the opened reader's polled query unusable, the way a schema the
      // reader no longer matches (or an unreadable table) would.
      const mutate = openDatabase(path);
      mutate.exec("ALTER TABLE message RENAME TO message_replaced");
      mutate.close();

      let thrown: unknown;
      try {
        reader.fetchNewMessages(0, 100);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as { code?: string }).code).toBe(IMESSAGE_CHATDB_READ_FAILED);
      expect((thrown as Error).cause).toBeInstanceOf(Error);

      reader.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
