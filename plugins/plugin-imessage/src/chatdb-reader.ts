/**
 * macOS chat.db reader for @elizaos/plugin-imessage.
 *
 * iMessage stores every message in a SQLite database at
 * `~/Library/Messages/chat.db`. Reading it requires Full Disk Access on
 * whichever process hosts the plugin (the Eliza agent, typically). This
 * module opens that file read-only and exposes a single `fetchNewMessages`
 * method the polling loop uses to walk forward by ROWID.
 *
 * ---
 *
 * Backend: runtime SQLite built-ins. Bun exposes `bun:sqlite`; Node 22+
 * exposes `node:sqlite`. We normalize both to the small query surface this
 * module needs so live chat.db reads keep working in test runners and under
 * either runtime.
 *
 * Prior to this module, the plugin attempted to read messages by running
 * AppleScript against Messages.app's `get messages` verb — a verb that
 * does not exist in Messages.app's scripting dictionary. That code path
 * silently returned an empty list on every poll, so inbound messages
 * never reached the agent.
 */

import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { logger } from "@elizaos/core";
import type { IMessagePermissionAction } from "./types.js";

/**
 * Default path to macOS's iMessage database. Requires Full Disk Access
 * on whichever process opens it.
 */
export const DEFAULT_CHAT_DB_PATH = join(homedir(), "Library", "Messages", "chat.db");

export const MACOS_FULL_DISK_ACCESS_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles";

export interface ChatDbAccessIssue {
  code: "sqlite_unavailable" | "open_failed";
  path: string;
  reason: string;
  permissionAction: IMessagePermissionAction | null;
}

export function createFullDiskAccessAction(): IMessagePermissionAction {
  return {
    type: "full_disk_access",
    label: "Open Full Disk Access",
    url: MACOS_FULL_DISK_ACCESS_SETTINGS_URL,
    instructions: [
      "Open System Settings > Privacy & Security > Full Disk Access.",
      "Enable Eliza. If you run Eliza from a terminal, enable that terminal app too.",
      "Quit and relaunch Eliza after changing Full Disk Access.",
    ],
  };
}

/**
 * Apple Cocoa reference date: 2001-01-01T00:00:00Z. The `message.date`
 * column stores a delta from this instant. Modern macOS stores the delta
 * in nanoseconds; older macOS (< 10.13) stored it in seconds. We detect
 * which by magnitude — any plausible seconds-since-2001 value fits in ~10
 * digits, any nanoseconds-since-2001 value is at least 13 digits.
 */
const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1);

/**
 * Convert an Apple Cocoa date delta to JavaScript milliseconds since
 * epoch. Handles both legacy (seconds) and modern (nanoseconds) storage.
 */
export function appleDateToJsMs(appleDate: number | string | bigint): number {
  if (typeof appleDate === "string") {
    const trimmed = appleDate.trim();
    if (!trimmed) return 0;
    try {
      return appleDateToJsMs(BigInt(trimmed));
    } catch {
      const parsed = Number(trimmed);
      return Number.isFinite(parsed) ? appleDateToJsMs(parsed) : 0;
    }
  }
  if (typeof appleDate === "bigint") {
    if (appleDate <= 0n) return 0;
    if (appleDate > 1_000_000_000_000n) {
      return APPLE_EPOCH_MS + Number(appleDate / 1_000_000n);
    }
    return APPLE_EPOCH_MS + Number(appleDate) * 1000;
  }
  if (!appleDate || appleDate < 0) return 0;
  // Nanosecond-scale values are enormous (> 1e15 for any date after 2002).
  // Second-scale values top out around 1e9 for dates decades from now.
  // Split at 1e12 to be safe.
  const deltaMs = appleDate > 1e12 ? appleDate / 1e6 : appleDate * 1000;
  return APPLE_EPOCH_MS + deltaMs;
}

/**
 * Extract the plain UTF-8 text from an `attributedBody` BLOB.
 *
 * Modern macOS (~10.13+) stores message text as an `NSMutableAttributedString`
 * serialised via Apple's legacy `typedstream` / NSArchiver format, because
 * Messages.app wants to attach attributes (links, mentions, formatting)
 * that plain text can't carry. Empirically, on a fresh macOS chat.db,
 * ~97% of message rows have `text=NULL` and their actual readable content
 * only exists in `attributedBody`. Reading chat.db without decoding this
 * blob means being blind to almost every real message.
 *
 * Full typedstream parsing is complex (class inheritance chains, object
 * references, multiple string encodings) and worth ~500 lines of code.
 * The good news: Messages.app uses a narrow, stable subset for its own
 * message text, and the text always appears after the same marker
 * sequence: `NSString\x00\x01\x94\x84\x01\x2b` (class name, object flags,
 * then `+` which is typedstream's "cstring" verb), followed by a length
 * byte, followed by the UTF-8 bytes. For strings longer than 254 bytes
 * typedstream escapes the length with `0x81` followed by a little-endian
 * uint16 length, then the bytes. Everything else we don't care about.
 *
 * Verified against real blobs from a live chat.db — hit rate is ~100% on
 * the messages checked, including short replies like "Yo" and longer
 * messages with emoji. Returns null if no marker is found, which the
 * caller uses as a signal to fall back to the raw `text` column or
 * skip the row.
 *
 * References:
 *   - Apple's typedstream format: see darling-gnustep-base, GSTypedStream.m
 *   - imessage-exporter's Rust implementation (MIT) for the full parser
 *   - NSAttributedString serialisation in Cocoa Foundation
 */
export function decodeAttributedBody(blob: Uint8Array | Buffer | null | undefined): string | null {
  if (!blob) return null;
  const buf = blob instanceof Buffer ? blob : Buffer.from(blob as Uint8Array);
  if (buf.length < 20) return null;

  // Locate the NSString class marker. Messages.app uses either "NSString"
  // or (rarely) "NSMutableString" depending on whether the attributed
  // string wraps a mutable backing store. Try both.
  const MARKERS = [Buffer.from("NSString", "latin1"), Buffer.from("NSMutableString", "latin1")];

  let start = -1;
  for (const marker of MARKERS) {
    const idx = buf.indexOf(marker);
    if (idx !== -1) {
      start = idx + marker.length;
      break;
    }
  }
  if (start === -1) return null;

  // After the class name is a short preamble: the byte sequence varies
  // slightly depending on object graph position but always ends with
  // `\x2b` (the typedstream `+` cstring verb). We scan forward a small
  // bounded window for the `+` so the decoder doesn't drift into the
  // attributes dictionary if Apple changes the exact preamble length.
  const MAX_PREAMBLE = 16;
  let plusAt = -1;
  for (let i = start; i < Math.min(start + MAX_PREAMBLE, buf.length); i++) {
    if (buf[i] === 0x2b) {
      plusAt = i;
      break;
    }
  }
  if (plusAt === -1) return null;

  // Read the length. Typedstream uses:
  //   - single byte length for 0..254
  //   - 0x81 + little-endian uint16 for 255..65535
  //   - 0x82 + little-endian uint32 for larger (rare in chat.db)
  let cursor = plusAt + 1;
  if (cursor >= buf.length) return null;

  let length: number;
  const first = buf[cursor];
  if (first < 0x80 || first === 0xff) {
    // Direct length byte
    length = first;
    cursor += 1;
  } else if (first === 0x81 && cursor + 2 < buf.length) {
    length = buf.readUInt16LE(cursor + 1);
    cursor += 3;
  } else if (first === 0x82 && cursor + 4 < buf.length) {
    length = buf.readUInt32LE(cursor + 1);
    cursor += 5;
  } else {
    // Unknown length encoding; give up.
    return null;
  }

  if (length === 0) return "";
  if (cursor + length > buf.length) {
    // Truncated blob — return what we can without overrunning.
    length = buf.length - cursor;
    if (length <= 0) return null;
  }

  // The bytes are UTF-8. Buffer.toString("utf8") silently replaces
  // invalid sequences with U+FFFD, which is the right behaviour here —
  // the agent would rather see a slightly-mangled message than nothing.
  return buf.slice(cursor, cursor + length).toString("utf8");
}

/**
 * Parse the reaction fields out of a chat.db row when `associated_message_type`
 * is in the reaction range (2000-3005). Returns null for non-reaction rows.
 */
function parseReaction(row: {
  associated_message_type: number | null;
  associated_message_guid: string | null;
  associated_message_emoji: string | null;
}): ChatDbReaction | null {
  const type = row.associated_message_type ?? 0;
  if (type < 2000 || type >= 4000) return null;

  const isRemove = type >= 3000;
  const baseType = isRemove ? type - 1000 : type;

  const kind: ChatDbReaction["kind"] =
    baseType === 2000
      ? "love"
      : baseType === 2001
        ? "like"
        : baseType === 2002
          ? "dislike"
          : baseType === 2003
            ? "laugh"
            : baseType === 2004
              ? "emphasis"
              : baseType === 2005
                ? "question"
                : baseType === 2006
                  ? "sticker"
                  : "unknown";

  // associated_message_guid comes back as either a plain guid or prefixed
  // with `p:<partIndex>/<guid>` for messages that target a specific part
  // of a multipart message. Strip the prefix so downstream handlers get
  // a clean guid they can match against other rows.
  let targetGuid = row.associated_message_guid ?? "";
  const slashIdx = targetGuid.lastIndexOf("/");
  if (slashIdx !== -1) targetGuid = targetGuid.slice(slashIdx + 1);

  return {
    kind,
    add: !isRemove,
    rawType: type,
    targetGuid,
    emoji: row.associated_message_emoji,
  };
}

/** A single attachment attached to a message. */
export interface ChatDbAttachment {
  /** chat.db `attachment.guid`. */
  guid: string;
  /** Filename as stored, if known. */
  filename: string | null;
  /** Apple UTI (e.g. `public.jpeg`, `com.apple.quicktime-movie`). */
  uti: string | null;
  /** Best-available MIME type (may be null for some UTIs). */
  mimeType: string | null;
  /** Total size in bytes. */
  totalBytes: number | null;
  /** True when the attachment is a Messages sticker. */
  isSticker: boolean;
}

/**
 * A reaction / tapback signal. iMessage stores reactions as their own
 * `message` rows with a non-zero `associated_message_type` and an
 * `associated_message_guid` pointing at the original message.
 *
 * Type codes (empirically from chat.db):
 *   2000 = love, 2001 = like, 2002 = dislike, 2003 = laugh,
 *   2004 = emphasis, 2005 = question, 2006 = sticker-reply.
 *   3000+ = the matching "remove" for each.
 */
export interface ChatDbReaction {
  kind: "love" | "like" | "dislike" | "laugh" | "emphasis" | "question" | "sticker" | "unknown";
  /** Whether this is an add (+) or remove (-) tapback. */
  add: boolean;
  /** Raw numeric type for callers that want the full taxonomy. */
  rawType: number;
  /** GUID of the message being reacted to. */
  targetGuid: string;
  /** Genmoji / custom emoji when the reaction is a sticker-like reaction. */
  emoji: string | null;
}

/**
 * A normalized iMessage, ready to be turned into an agent Memory. Unlike
 * the first version of this reader, rows whose `text` column is NULL are
 * NOT skipped — the reader falls back to decoding the `attributedBody`
 * blob, which covers the ~97% of messages on modern macOS that store
 * their text there. If both paths yield nothing, `text` is an empty
 * string and the row is flagged via `kind`.
 */
export interface ChatDbMessage {
  /** chat.db `message.ROWID`. Monotonic, used as the polling cursor. */
  rowId: number;
  /** chat.db `message.guid`. Stable across devices, used for deduplication. */
  guid: string;
  /** Plain text of the message. May be the empty string for reactions, system events, or undecodable blobs. */
  text: string;
  /**
   * Classification of the row. Most conversation turns are `"text"`.
   * `"reaction"` rows carry no text — their payload is in `reaction`.
   * `"system"` covers group add/remove/rename events.
   */
  kind: "text" | "reaction" | "system" | "other";
  /** Sender identity: phone number (E.164) or email address. Empty for outbound. */
  handle: string;
  /** `chat.chat_identifier`. Stable room key for 1:1 and group conversations. */
  chatId: string;
  /** Classification derived from `chat.style` (45 = 1:1, 43 = group). */
  chatType: "direct" | "group";
  /** Group name if set by users; always null for 1:1 chats. */
  displayName: string | null;
  /** JavaScript milliseconds since epoch, converted from Apple's Cocoa date. */
  timestamp: number;
  /** True if the message was sent by the local Apple ID (the agent's account). */
  isFromMe: boolean;
  /** Delivery service as reported by Apple: `iMessage`, `SMS`, `RCS`, etc. */
  service: string | null;
  /** Sent flag — reliable for outbound, always 1 for delivered. */
  isSent: boolean;
  /** Delivered flag — Apple confirmed delivery to the recipient's device. */
  isDelivered: boolean;
  /** Read flag — the recipient opened the thread. Only meaningful for outbound. */
  isRead: boolean;
  /** When the recipient read this message, or 0 if unread/never. */
  dateRead: number;
  /** When the message was edited (modern macOS), or 0 if never edited. */
  dateEdited: number;
  /** When the message was unsent/retracted, or 0 if still live. */
  dateRetracted: number;
  /** GUID of the message this one is an inline reply to, if any. */
  replyToGuid: string | null;
  /** Reaction payload when `kind === "reaction"`. */
  reaction: ChatDbReaction | null;
  /** Zero or more attachments bound to this message. */
  attachments: ChatDbAttachment[];
}

/**
 * Read-only handle for a live chat.db. Created via {@link openChatDb}.
 * The service owns the lifetime: opens on start, closes on stop.
 */
/** A single chat (conversation room) as surfaced by `listChats`. */
export interface ChatDbChatSummary {
  chatId: string;
  chatType: "direct" | "group";
  displayName: string | null;
  serviceName: string | null;
  participants: string[];
  lastReadMessageTimestamp: number;
}

export interface ChatDbReader {
  /**
   * Fetch messages with ROWID strictly greater than `sinceRowId`, up to
   * `limit` rows. Rows are returned in ascending ROWID order so the
   * caller can advance its cursor to the last row's `rowId`.
   *
   * Returns an empty array when the database has no new messages or
   * when the reader has been closed.
   */
  fetchNewMessages(sinceRowId: number, limit: number): ChatDbMessage[];
  /**
   * Return the largest `message.ROWID` currently in the database. Used
   * on service start to seed the polling cursor at the tip so a fresh
   * launch does not replay the entire backlog. Returns 0 on empty dbs
   * or if the query fails.
   */
  getLatestRowId(): number;
  /**
   * Return the timestamp of the most recent outbound message authored by the
   * local Apple account, converted to JavaScript epoch milliseconds.
   */
  getLatestOwnMessageTimestamp(): number | null;
  /**
   * Return the newest messages in chronological order, optionally scoped
   * to a single chat identifier. Unlike `fetchNewMessages`, this is for
   * ad-hoc inspection and UI reads rather than cursor-based polling.
   */
  listMessages(options?: { chatId?: string; limit?: number }): ChatDbMessage[];
  /**
   * List every chat the database knows about, joined with participant
   * handles. Reads from `chat`, `chat_handle_join`, and `handle`. This
   * is the replacement for the old AppleScript-based `getChats` path,
   * which was slower and returned less data.
   */
  listChats(): ChatDbChatSummary[];
  /** Close the underlying SQLite handle. Idempotent. */
  close(): void;
}

/**
 * Minimal shape of `bun:sqlite`'s `Database` class we rely on. Declared
 * here so the rest of the module can stay strictly typed without a
 * transitive dependency on `@types/bun`.
 */
interface SqliteDatabaseInstance {
  query(sql: string): BunStatement;
  close(): void;
}

interface BunStatement {
  all(...params: unknown[]): unknown[];
}

interface ChatDbDiagnosticsLogger {
  warn(message: string): void;
  debug(message: string): void;
}

export interface OpenChatDbOptions {
  diagnosticsLogger?: ChatDbDiagnosticsLogger;
}

const runtimeRequire = createRequire(import.meta.url);
const loggedChatDbOpenFailures = new Set<string>();
const lastChatDbAccessIssues = new Map<string, ChatDbAccessIssue>();
let loggedSqliteUnavailable = false;

export function getLastChatDbAccessIssue(
  dbPath: string = DEFAULT_CHAT_DB_PATH
): ChatDbAccessIssue | null {
  return lastChatDbAccessIssues.get(dbPath) ?? null;
}

/**
 * Dynamically resolve a SQLite backend. We keep the specifiers opaque so the
 * module still loads under runtimes that only support one of them.
 */
async function tryLoadSqlite(): Promise<
  ((path: string, options?: { readonly?: boolean }) => SqliteDatabaseInstance) | null
> {
  try {
    const mod = runtimeRequire("bun:sqlite") as {
      Database?: new (path: string, options?: { readonly?: boolean }) => SqliteDatabaseInstance;
      default?: new (path: string, options?: { readonly?: boolean }) => SqliteDatabaseInstance;
    };
    const Database = mod.Database ?? mod.default;
    if (Database) {
      return (path, options) => new Database(path, options);
    }
  } catch {
    // Fall through to Node's built-in SQLite runtime.
  }

  try {
    const mod = (await import("node:sqlite")) as {
      DatabaseSync?: new (
        path: string,
        options?: { readOnly?: boolean }
      ) => {
        prepare: (sql: string) => BunStatement;
        close: () => void;
      };
      default?: {
        DatabaseSync?: new (
          path: string,
          options?: { readOnly?: boolean }
        ) => {
          prepare: (sql: string) => BunStatement;
          close: () => void;
        };
      };
    };
    const DatabaseSync = mod.DatabaseSync ?? mod.default?.DatabaseSync;
    if (!DatabaseSync) {
      return null;
    }

    return (path, options) => {
      const db = new DatabaseSync(path, {
        readOnly: options?.readonly ?? false,
      });
      return {
        query(sql: string): BunStatement {
          const statement = db.prepare(sql);
          return {
            all(...params: unknown[]): unknown[] {
              return statement.all(...params) as unknown[];
            },
          };
        },
        close(): void {
          db.close();
        },
      };
    };
  } catch {
    return null;
  }
}

/**
 * Open macOS chat.db read-only and return a reader bound to it.
 *
 * Returns `null` — and logs a human-readable reason — in every failure
 * mode so the caller can degrade to send-only operation instead of
 * crashing the runtime:
 *
 * - Not running under Bun (bun:sqlite built-in unavailable)
 * - chat.db does not exist at the given path
 * - chat.db exists but cannot be opened (missing Full Disk Access, etc.)
 */
export async function openChatDb(
  dbPath: string = DEFAULT_CHAT_DB_PATH,
  options: OpenChatDbOptions = {}
): Promise<ChatDbReader | null> {
  const diagnosticsLogger = options.diagnosticsLogger ?? logger;
  const openDatabase = await tryLoadSqlite();
  if (!openDatabase) {
    lastChatDbAccessIssues.set(dbPath, {
      code: "sqlite_unavailable",
      path: dbPath,
      reason: "No supported SQLite runtime is available.",
      permissionAction: null,
    });
    if (!loggedSqliteUnavailable) {
      loggedSqliteUnavailable = true;
      diagnosticsLogger.warn(
        "[imessage] no supported SQLite runtime is available — inbound polling is disabled. " +
          "Run the agent under Bun or Node 22+, or disable polling with IMESSAGE_POLL_INTERVAL_MS=0. " +
          "Outbound send via AppleScript still works regardless. Further identical startup checks will log at debug."
      );
    } else {
      diagnosticsLogger.debug(
        "[imessage] SQLite runtime still unavailable; inbound polling remains disabled"
      );
    }
    return null;
  }

  let db: SqliteDatabaseInstance;
  try {
    db = openDatabase(dbPath, { readonly: true });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    lastChatDbAccessIssues.set(dbPath, {
      code: "open_failed",
      path: dbPath,
      reason,
      permissionAction: createFullDiskAccessAction(),
    });
    const failureKey = `${dbPath}\0${reason}`;
    if (!loggedChatDbOpenFailures.has(failureKey)) {
      loggedChatDbOpenFailures.add(failureKey);
      diagnosticsLogger.warn(
        `[imessage] Failed to open chat.db at ${dbPath}: ${reason}. ` +
          "Ensure the path is correct and the host process has Full Disk Access " +
          "(macOS → System Settings → Privacy & Security → Full Disk Access). " +
          `Open it directly with ${MACOS_FULL_DISK_ACCESS_SETTINGS_URL}. ` +
          "Plugin will continue in send-only mode. Further identical startup failures will log at debug."
      );
    } else {
      diagnosticsLogger.debug(
        `[imessage] chat.db at ${dbPath} is still unavailable (${reason}); continuing in send-only mode`
      );
    }
    return null;
  }
  lastChatDbAccessIssues.delete(dbPath);

  // Prepared statement reused on every poll. We join `message` to
  // `handle` (for the sender identity) and to `chat` (for the room
  // identity and display name) via the `chat_message_join` edge table.
  // We also pull `attributedBody` so the reader can recover the text for
  // the ~97% of messages that store their content there instead of in
  // the plain `text` column, and enough status columns to surface
  // reactions, replies, edits, and read receipts to the caller.
  const pollStmt = db.query(`
    SELECT
      m.ROWID AS row_id,
      m.guid AS guid,
      m.text AS text,
      m.attributedBody AS attributed_body,
      m.date AS apple_date,
      m.date_read AS apple_date_read,
      m.date_edited AS apple_date_edited,
      m.date_retracted AS apple_date_retracted,
      m.is_from_me AS is_from_me,
      m.is_read AS is_read,
      m.is_sent AS is_sent,
      m.is_delivered AS is_delivered,
      m.item_type AS item_type,
      m.reply_to_guid AS reply_to_guid,
      m.associated_message_guid AS associated_message_guid,
      m.associated_message_type AS associated_message_type,
      m.associated_message_emoji AS associated_message_emoji,
      m.cache_has_attachments AS cache_has_attachments,
      m.service AS message_service,
      h.id AS handle,
      h.service AS handle_service,
      c.chat_identifier AS chat_identifier,
      c.display_name AS display_name,
      c.style AS chat_style
    FROM message m
    LEFT JOIN handle h ON m.handle_id = h.ROWID
    LEFT JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
    LEFT JOIN chat c ON cmj.chat_id = c.ROWID
    WHERE m.ROWID > ?
    ORDER BY m.ROWID ASC
    LIMIT ?
  `);

  // Secondary statement: fetch every attachment row attached to a given
  // message ROWID. Called lazily per-message when `cache_has_attachments`
  // is set, so zero-attachment polls pay nothing.
  const attachmentsStmt = db.query(`
    SELECT
      a.guid AS guid,
      a.transfer_name AS transfer_name,
      a.filename AS filename,
      a.mime_type AS mime_type,
      a.uti AS uti,
      a.total_bytes AS total_bytes,
      a.is_sticker AS is_sticker
    FROM attachment a
    JOIN message_attachment_join maj ON a.ROWID = maj.attachment_id
    WHERE maj.message_id = ?
  `);

  // Separate prepared statement for the cheap "what's the tip?" query.
  // Used once on service start to seed the polling cursor.
  const tipStmt = db.query("SELECT MAX(ROWID) AS max_row_id FROM message");
  const latestOwnMessageStmt = db.query(
    "SELECT CAST(MAX(date) AS TEXT) AS max_apple_date FROM message WHERE is_from_me = 1"
  );
  const recentMessagesStmt = db.query(`
    SELECT
      m.ROWID AS row_id,
      m.guid AS guid,
      m.text AS text,
      m.attributedBody AS attributed_body,
      m.date AS apple_date,
      m.date_read AS apple_date_read,
      m.date_edited AS apple_date_edited,
      m.date_retracted AS apple_date_retracted,
      m.is_from_me AS is_from_me,
      m.is_read AS is_read,
      m.is_sent AS is_sent,
      m.is_delivered AS is_delivered,
      m.item_type AS item_type,
      m.reply_to_guid AS reply_to_guid,
      m.associated_message_guid AS associated_message_guid,
      m.associated_message_type AS associated_message_type,
      m.associated_message_emoji AS associated_message_emoji,
      m.cache_has_attachments AS cache_has_attachments,
      m.service AS message_service,
      h.id AS handle,
      h.service AS handle_service,
      c.chat_identifier AS chat_identifier,
      c.display_name AS display_name,
      c.style AS chat_style
    FROM message m
    LEFT JOIN handle h ON m.handle_id = h.ROWID
    LEFT JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
    LEFT JOIN chat c ON cmj.chat_id = c.ROWID
    ORDER BY m.ROWID DESC
    LIMIT ?
  `);
  const recentMessagesByChatStmt = db.query(`
    SELECT
      m.ROWID AS row_id,
      m.guid AS guid,
      m.text AS text,
      m.attributedBody AS attributed_body,
      m.date AS apple_date,
      m.date_read AS apple_date_read,
      m.date_edited AS apple_date_edited,
      m.date_retracted AS apple_date_retracted,
      m.is_from_me AS is_from_me,
      m.is_read AS is_read,
      m.is_sent AS is_sent,
      m.is_delivered AS is_delivered,
      m.item_type AS item_type,
      m.reply_to_guid AS reply_to_guid,
      m.associated_message_guid AS associated_message_guid,
      m.associated_message_type AS associated_message_type,
      m.associated_message_emoji AS associated_message_emoji,
      m.cache_has_attachments AS cache_has_attachments,
      m.service AS message_service,
      h.id AS handle,
      h.service AS handle_service,
      c.chat_identifier AS chat_identifier,
      c.display_name AS display_name,
      c.style AS chat_style
    FROM message m
    LEFT JOIN handle h ON m.handle_id = h.ROWID
    LEFT JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
    LEFT JOIN chat c ON cmj.chat_id = c.ROWID
    WHERE c.chat_identifier = ?
    ORDER BY m.ROWID DESC
    LIMIT ?
  `);

  // List-chats statement: every chat joined to handles via
  // chat_handle_join, grouped so each chat returns one row with an
  // aggregated participant list.
  const chatsStmt = db.query(`
    SELECT
      c.ROWID AS row_id,
      c.chat_identifier AS chat_identifier,
      c.display_name AS display_name,
      c.service_name AS service_name,
      c.style AS chat_style,
      c.last_read_message_timestamp AS last_read_apple_date,
      GROUP_CONCAT(h.id, ',') AS participant_handles
    FROM chat c
    LEFT JOIN chat_handle_join chj ON c.ROWID = chj.chat_id
    LEFT JOIN handle h ON chj.handle_id = h.ROWID
    GROUP BY c.ROWID
    ORDER BY c.last_read_message_timestamp DESC
  `);

  let closed = false;

  type RawMessageRow = {
    row_id: number;
    guid: string;
    text: string | null;
    attributed_body: Uint8Array | null;
    apple_date: number;
    apple_date_read: number | null;
    apple_date_edited: number | null;
    apple_date_retracted: number | null;
    is_from_me: number;
    is_read: number | null;
    is_sent: number | null;
    is_delivered: number | null;
    item_type: number | null;
    reply_to_guid: string | null;
    associated_message_guid: string | null;
    associated_message_type: number | null;
    associated_message_emoji: string | null;
    cache_has_attachments: number | null;
    message_service: string | null;
    handle: string | null;
    handle_service: string | null;
    chat_identifier: string | null;
    display_name: string | null;
    chat_style: number | null;
  };

  function materializeMessages(rows: RawMessageRow[]): ChatDbMessage[] {
    const out: ChatDbMessage[] = [];
    let undecodable = 0;

    for (const row of rows) {
      // Resolve the visible text: prefer the plain `text` column, fall
      // back to decoding `attributedBody`, then empty string.
      let text = "";
      if (row.text && row.text.length > 0) {
        text = row.text;
      } else if (row.attributed_body) {
        const decoded = decodeAttributedBody(row.attributed_body);
        if (decoded != null) {
          text = decoded;
        } else {
          undecodable++;
        }
      }

      // Classify the row. Reactions get their own kind + a parsed
      // reaction payload; system messages (group add/remove/rename)
      // surface as `"system"` so the caller can log or ignore.
      const assocType = row.associated_message_type ?? 0;
      let kind: ChatDbMessage["kind"] = "text";
      let reaction: ChatDbReaction | null = null;
      if (assocType >= 2000 && assocType < 4000) {
        kind = "reaction";
        reaction = parseReaction(row);
      } else if (row.item_type != null && row.item_type !== 0) {
        kind = "system";
      }

      // Attachments — only fetched when the cache bit indicates any.
      let attachments: ChatDbAttachment[] = [];
      if (row.cache_has_attachments === 1) {
        try {
          const attRows = attachmentsStmt.all(row.row_id) as Array<{
            guid: string;
            transfer_name: string | null;
            filename: string | null;
            mime_type: string | null;
            uti: string | null;
            total_bytes: number | null;
            is_sticker: number | null;
          }>;
          attachments = attRows.map((a) => ({
            guid: a.guid,
            filename: a.transfer_name ?? a.filename ?? null,
            uti: a.uti,
            mimeType: a.mime_type,
            totalBytes: a.total_bytes,
            isSticker: a.is_sticker === 1,
          }));
        } catch (error) {
          logger.debug(
            `[imessage] attachment query failed for rowid=${row.row_id}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }

      // Service resolution: prefer the message row's own service field,
      // fall back to the handle's service (stable across messages from
      // the same sender), else unknown.
      const service = row.message_service ?? row.handle_service ?? null;

      out.push({
        rowId: row.row_id,
        guid: row.guid,
        text,
        kind,
        handle: row.handle ?? "",
        chatId: row.chat_identifier ?? "",
        chatType: row.chat_style === 43 ? "group" : "direct",
        displayName: row.display_name,
        timestamp: appleDateToJsMs(row.apple_date),
        isFromMe: row.is_from_me === 1,
        service,
        isSent: row.is_sent === 1,
        isDelivered: row.is_delivered === 1,
        isRead: row.is_read === 1,
        dateRead: appleDateToJsMs(row.apple_date_read ?? 0),
        dateEdited: appleDateToJsMs(row.apple_date_edited ?? 0),
        dateRetracted: appleDateToJsMs(row.apple_date_retracted ?? 0),
        replyToGuid: row.reply_to_guid,
        reaction,
        attachments,
      });
    }

    if (undecodable > 0) {
      logger.debug(
        `[imessage] chat.db poll: ${undecodable} row(s) had attributedBody that could not be decoded; their text is empty`
      );
    }

    return out;
  }

  return {
    fetchNewMessages(sinceRowId: number, limit: number): ChatDbMessage[] {
      if (closed) return [];

      let rows: RawMessageRow[];
      try {
        rows = pollStmt.all(sinceRowId, limit) as typeof rows;
      } catch (error) {
        logger.error(
          `[imessage] chat.db query failed: ${error instanceof Error ? error.message : String(error)}`
        );
        return [];
      }

      return materializeMessages(rows);
    },
    getLatestRowId(): number {
      if (closed) return 0;
      try {
        const rows = tipStmt.all() as Array<{ max_row_id: number | null }>;
        return rows[0]?.max_row_id ?? 0;
      } catch (error) {
        logger.error(
          `[imessage] chat.db tip query failed: ${error instanceof Error ? error.message : String(error)}`
        );
        return 0;
      }
    },
    getLatestOwnMessageTimestamp(): number | null {
      if (closed) return null;
      try {
        const rows = latestOwnMessageStmt.all() as Array<{
          max_apple_date: string | null;
        }>;
        const appleDate = rows[0]?.max_apple_date ?? null;
        return appleDate === null ? null : appleDateToJsMs(appleDate);
      } catch (error) {
        logger.error(
          `[imessage] chat.db latest own message query failed: ${error instanceof Error ? error.message : String(error)}`
        );
        return null;
      }
    },
    listMessages(options = {}): ChatDbMessage[] {
      if (closed) return [];
      const chatId = options.chatId?.trim();
      const requestedLimit =
        typeof options.limit === "number" && Number.isFinite(options.limit) ? options.limit : 50;
      const limit = Math.max(1, Math.trunc(requestedLimit));

      let rows: RawMessageRow[];
      try {
        rows = chatId
          ? (recentMessagesByChatStmt.all(chatId, limit) as RawMessageRow[])
          : (recentMessagesStmt.all(limit) as RawMessageRow[]);
      } catch (error) {
        logger.error(
          `[imessage] chat.db listMessages query failed: ${error instanceof Error ? error.message : String(error)}`
        );
        return [];
      }

      // Queries run DESC for efficiency on "latest N" reads. Reverse
      // back to chronological order so API/UI callers can render in the
      // natural oldest→newest sequence without a second sort.
      return materializeMessages(rows).reverse();
    },
    listChats(): ChatDbChatSummary[] {
      if (closed) return [];
      try {
        const rows = chatsStmt.all() as Array<{
          row_id: number;
          chat_identifier: string | null;
          display_name: string | null;
          service_name: string | null;
          chat_style: number | null;
          last_read_apple_date: number | null;
          participant_handles: string | null;
        }>;
        return rows.map((row) => ({
          chatId: row.chat_identifier ?? `chat-${row.row_id}`,
          chatType: row.chat_style === 43 ? "group" : "direct",
          displayName: row.display_name,
          serviceName: row.service_name,
          participants: row.participant_handles
            ? row.participant_handles.split(",").filter(Boolean)
            : [],
          lastReadMessageTimestamp: appleDateToJsMs(row.last_read_apple_date ?? 0),
        }));
      } catch (error) {
        logger.error(
          `[imessage] chat.db listChats query failed: ${error instanceof Error ? error.message : String(error)}`
        );
        return [];
      }
    },
    close(): void {
      if (closed) return;
      closed = true;
      try {
        db.close();
      } catch {
        // Closing a read-only handle on a file we don't own should
        // never throw in practice, but we swallow to stay idempotent.
      }
    },
  };
}
