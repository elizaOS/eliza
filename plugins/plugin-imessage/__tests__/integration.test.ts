import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import imessagePlugin, {
  appleDateToJsMs,
  chatContextProvider,
  chatDbMessageToPublicShape,
  formatPhoneNumber,
  getLastChatDbAccessIssue,
  IMESSAGE_SERVICE_NAME,
  IMessageCliError,
  IMessageConfigurationError,
  // Event types
  IMessageEventTypes,
  IMessageNotSupportedError,
  // Error classes
  IMessagePluginError,
  IMessageService,
  isEmail,
  // Type utilities
  isPhoneNumber,
  isValidIMessageTarget,
  MAX_IMESSAGE_MESSAGE_LENGTH,
  normalizeContactHandle,
  normalizeIMessageTarget,
  openChatDb,
  parseChatsFromAppleScript,
  // Parsing functions
  parseContactsOutput,
  parseMessagesFromAppleScript,
  splitMessageForIMessage,
} from "../src/index";

const runtimeRequire = createRequire(import.meta.url);

// ============================================================
// Plugin exports
// ============================================================

describe("iMessage plugin exports", () => {
  it("exports plugin metadata", () => {
    expect(imessagePlugin.name).toBe("imessage");
    expect(imessagePlugin.description).toContain("iMessage");
    expect(Array.isArray(imessagePlugin.actions)).toBe(true);
    expect(Array.isArray(imessagePlugin.providers)).toBe(true);
    expect(Array.isArray(imessagePlugin.services)).toBe(true);
  });

  it("exports providers and service", () => {
    expect(chatContextProvider).toBeDefined();
    expect(IMessageService).toBeDefined();
  });

  it("exports parsing utility functions", () => {
    expect(parseMessagesFromAppleScript).toBeDefined();
    expect(parseChatsFromAppleScript).toBeDefined();
  });

  it("exports constants", () => {
    expect(IMESSAGE_SERVICE_NAME).toBe("imessage");
    expect(MAX_IMESSAGE_MESSAGE_LENGTH).toBe(4000);
    expect(IMessageEventTypes.MESSAGE_RECEIVED).toBe("IMESSAGE_MESSAGE_RECEIVED");
    expect(IMessageEventTypes.MESSAGE_SENT).toBe("IMESSAGE_MESSAGE_SENT");
    expect(IMessageEventTypes.CONNECTION_READY).toBe("IMESSAGE_CONNECTION_READY");
    expect(IMessageEventTypes.ERROR).toBe("IMESSAGE_ERROR");
  });
});

// ============================================================
// isPhoneNumber
// ============================================================

describe("isPhoneNumber", () => {
  it("accepts valid US phone numbers", () => {
    expect(isPhoneNumber("+15551234567")).toBe(true);
    expect(isPhoneNumber("15551234567")).toBe(true);
  });

  it("accepts formatted phone numbers", () => {
    expect(isPhoneNumber("1-555-123-4567")).toBe(true);
    expect(isPhoneNumber("(555) 123-4567")).toBe(true);
    expect(isPhoneNumber("555.123.4567")).toBe(true);
  });

  it("accepts international phone numbers", () => {
    expect(isPhoneNumber("+44 7700 900000")).toBe(true);
    expect(isPhoneNumber("+61412345678")).toBe(true);
  });

  it("rejects emails", () => {
    expect(isPhoneNumber("test@example.com")).toBe(false);
  });

  it("rejects too-short numbers", () => {
    expect(isPhoneNumber("12345")).toBe(false);
    expect(isPhoneNumber("123")).toBe(false);
  });

  it("rejects plain text", () => {
    expect(isPhoneNumber("hello world")).toBe(false);
    expect(isPhoneNumber("not a phone")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isPhoneNumber("")).toBe(false);
  });
});

// ============================================================
// isEmail
// ============================================================

describe("isEmail", () => {
  it("accepts valid email addresses", () => {
    expect(isEmail("test@example.com")).toBe(true);
    expect(isEmail("user.name@domain.co.uk")).toBe(true);
    expect(isEmail("admin@sub.domain.org")).toBe(true);
  });

  it("rejects phone numbers", () => {
    expect(isEmail("+15551234567")).toBe(false);
  });

  it("rejects plain text", () => {
    expect(isEmail("not an email")).toBe(false);
    expect(isEmail("hello")).toBe(false);
  });

  it("rejects partial addresses", () => {
    expect(isEmail("@domain.com")).toBe(false);
    expect(isEmail("user@")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isEmail("")).toBe(false);
  });
});

// ============================================================
// isValidIMessageTarget
// ============================================================

describe("isValidIMessageTarget", () => {
  it("accepts phone numbers", () => {
    expect(isValidIMessageTarget("+15551234567")).toBe(true);
  });

  it("accepts email addresses", () => {
    expect(isValidIMessageTarget("user@example.com")).toBe(true);
  });

  it("accepts chat_id: prefixed targets", () => {
    expect(isValidIMessageTarget("chat_id:iMessage;+;chat12345")).toBe(true);
  });

  it("rejects invalid targets", () => {
    expect(isValidIMessageTarget("hello world")).toBe(false);
    expect(isValidIMessageTarget("123")).toBe(false);
  });

  it("handles whitespace", () => {
    expect(isValidIMessageTarget("  +15551234567  ")).toBe(true);
  });
});

// ============================================================
// normalizeIMessageTarget
// ============================================================

describe("normalizeIMessageTarget", () => {
  it("returns null for empty string", () => {
    expect(normalizeIMessageTarget("")).toBeNull();
    expect(normalizeIMessageTarget("   ")).toBeNull();
  });

  it("preserves chat_id: prefix", () => {
    expect(normalizeIMessageTarget("chat_id:12345")).toBe("chat_id:12345");
  });

  it("strips imessage: prefix", () => {
    const result = normalizeIMessageTarget("imessage:+15551234567");
    expect(result).toBe("+15551234567");
  });

  it("trims whitespace", () => {
    expect(normalizeIMessageTarget("  +15551234567  ")).toBe("+15551234567");
  });

  it("returns phone/email as-is", () => {
    expect(normalizeIMessageTarget("+15551234567")).toBe("+15551234567");
    expect(normalizeIMessageTarget("user@example.com")).toBe("user@example.com");
  });
});

// ============================================================
// formatPhoneNumber
// ============================================================

describe("formatPhoneNumber", () => {
  it("removes formatting characters", () => {
    expect(formatPhoneNumber("+1 (555) 123-4567")).toBe("+15551234567");
  });

  it("adds + prefix for international numbers > 10 digits", () => {
    expect(formatPhoneNumber("15551234567")).toBe("+15551234567");
  });

  it("preserves existing + prefix", () => {
    expect(formatPhoneNumber("+15551234567")).toBe("+15551234567");
  });

  it("does not add + for 10-digit numbers", () => {
    expect(formatPhoneNumber("5551234567")).toBe("5551234567");
  });

  it("handles dots and spaces", () => {
    expect(formatPhoneNumber("555.123.4567")).toBe("5551234567");
  });
});

// ============================================================
// splitMessageForIMessage
// ============================================================

describe("splitMessageForIMessage", () => {
  it("returns single chunk for short messages", () => {
    const result = splitMessageForIMessage("Hello world");
    expect(result).toEqual(["Hello world"]);
  });

  it("returns single chunk for exactly max-length messages", () => {
    const text = "a".repeat(MAX_IMESSAGE_MESSAGE_LENGTH);
    const result = splitMessageForIMessage(text);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(text);
  });

  it("splits long messages at word boundaries", () => {
    const words = Array.from({ length: 500 }, (_, i) => `word${i}`).join(" ");
    const result = splitMessageForIMessage(words, 100);
    expect(result.length).toBeGreaterThan(1);
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(100);
    }
  });

  it("prefers newline break points", () => {
    const text = `${"a".repeat(60)}\n${"b".repeat(30)}`;
    const result = splitMessageForIMessage(text, 80);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe("a".repeat(60));
    expect(result[1]).toBe("b".repeat(30));
  });

  it("handles text with no break points", () => {
    const text = "a".repeat(200);
    const result = splitMessageForIMessage(text, 100);
    expect(result.length).toBeGreaterThan(1);
    // All text should be preserved
    expect(result.join("")).toBe(text);
  });

  it("returns empty array for empty string", () => {
    const result = splitMessageForIMessage("");
    expect(result).toEqual([""]);
  });
});

// ============================================================
// parseMessagesFromAppleScript
// ============================================================

describe("parseMessagesFromAppleScript", () => {
  it("parses a single message line", () => {
    const input = "msg001\tHello there\t1700000000000\t0\tchat123\t+15551234567";
    const result = parseMessagesFromAppleScript(input);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("msg001");
    expect(result[0].text).toBe("Hello there");
    expect(result[0].timestamp).toBe(1700000000000);
    expect(result[0].isFromMe).toBe(false);
    expect(result[0].chatId).toBe("chat123");
    expect(result[0].handle).toBe("+15551234567");
    expect(result[0].hasAttachments).toBe(false);
  });

  it("parses multiple message lines", () => {
    const input = [
      "msg001\tHello\t1700000000000\t0\tchat1\t+15551111111",
      "msg002\tWorld\t1700000001000\t1\tchat1\t+15552222222",
      "msg003\tTest\t1700000002000\ttrue\tchat2\tuser@test.com",
    ].join("\n");

    const result = parseMessagesFromAppleScript(input);
    expect(result).toHaveLength(3);
    expect(result[0].text).toBe("Hello");
    expect(result[0].isFromMe).toBe(false);
    expect(result[1].text).toBe("World");
    expect(result[1].isFromMe).toBe(true);
    expect(result[2].text).toBe("Test");
    expect(result[2].isFromMe).toBe(true);
  });

  it("returns empty array for empty string", () => {
    expect(parseMessagesFromAppleScript("")).toEqual([]);
  });

  it("returns empty array for whitespace-only input", () => {
    expect(parseMessagesFromAppleScript("   \n  \n  ")).toEqual([]);
  });

  it("skips lines with fewer than 6 fields", () => {
    const input = "partial\tdata\n" + "msg001\tHello\t1700000000000\t0\tchat1\t+15551234567";
    const result = parseMessagesFromAppleScript(input);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("msg001");
  });

  it("handles is_from_me variations", () => {
    const lines = [
      "m1\ttext\t1000\t1\tchat\tsender",
      "m2\ttext\t1000\ttrue\tchat\tsender",
      "m3\ttext\t1000\tTrue\tchat\tsender",
      "m4\ttext\t1000\t0\tchat\tsender",
      "m5\ttext\t1000\tfalse\tchat\tsender",
    ].join("\n");

    const result = parseMessagesFromAppleScript(lines);
    expect(result[0].isFromMe).toBe(true);
    expect(result[1].isFromMe).toBe(true);
    expect(result[2].isFromMe).toBe(true);
    expect(result[3].isFromMe).toBe(false);
    expect(result[4].isFromMe).toBe(false);
  });

  it("handles invalid date by setting timestamp to 0", () => {
    const input = "msg001\tHello\tinvalid_date\t0\tchat1\tsender";
    const result = parseMessagesFromAppleScript(input);
    expect(result).toHaveLength(1);
    expect(result[0].timestamp).toBe(0);
  });

  it("handles empty fields gracefully", () => {
    // Use boundary placeholders so trim() doesn't strip leading/trailing tabs
    const input = ".\t\t1000\t0\t\t.";
    const result = parseMessagesFromAppleScript(input);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(".");
    expect(result[0].text).toBe("");
    expect(result[0].chatId).toBe("");
    expect(result[0].handle).toBe(".");
  });

  it("returns empty for all-tab line (tabs trimmed as whitespace)", () => {
    const input = "\t\t1000\t0\t\t";
    const result = parseMessagesFromAppleScript(input);
    expect(result).toHaveLength(0);
  });

  it("handles extra tab-separated fields (forward compat)", () => {
    const input = "msg001\tHello\t1000\t1\tchat1\tsender\textra1\textra2";
    const result = parseMessagesFromAppleScript(input);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("msg001");
  });
});

// ============================================================
// parseChatsFromAppleScript
// ============================================================

describe("parseChatsFromAppleScript", () => {
  it("parses a single chat line", () => {
    const input = "chat123\tWork Group\t5\t1700000000000";
    const result = parseChatsFromAppleScript(input);

    expect(result).toHaveLength(1);
    expect(result[0].chatId).toBe("chat123");
    expect(result[0].displayName).toBe("Work Group");
    expect(result[0].chatType).toBe("group");
    expect(result[0].participants).toEqual([]);
  });

  it("parses multiple chat lines", () => {
    const input = [
      "chat1\tWork\t5\t1700000000000",
      "chat2\tFamily\t3\t1700000001000",
      "chat3\t\t1\t1700000002000",
    ].join("\n");

    const result = parseChatsFromAppleScript(input);
    expect(result).toHaveLength(3);
    expect(result[0].chatType).toBe("group");
    expect(result[1].chatType).toBe("group");
    expect(result[2].chatType).toBe("direct");
  });

  it("returns empty array for empty string", () => {
    expect(parseChatsFromAppleScript("")).toEqual([]);
  });

  it("returns empty array for whitespace-only input", () => {
    expect(parseChatsFromAppleScript("  \n  \n  ")).toEqual([]);
  });

  it("classifies direct chats (participant_count <= 1)", () => {
    const input = "chat1\tJohn\t1\t1700000000000";
    const result = parseChatsFromAppleScript(input);
    expect(result[0].chatType).toBe("direct");
  });

  it("classifies group chats (participant_count > 1)", () => {
    const input = "chat1\tTeam\t2\t1700000000000";
    const result = parseChatsFromAppleScript(input);
    expect(result[0].chatType).toBe("group");
  });

  it("handles empty display name", () => {
    const input = "chat1\t\t1\t1700000000000";
    const result = parseChatsFromAppleScript(input);
    expect(result[0].displayName).toBeUndefined();
  });

  it("handles invalid participant count", () => {
    const input = "chat1\tTest\tnotanumber\t1700000000000";
    const result = parseChatsFromAppleScript(input);
    expect(result).toHaveLength(1);
    expect(result[0].chatType).toBe("direct");
  });

  it("skips lines with fewer than 4 fields", () => {
    const input = "incomplete\tdata\n" + "chat1\tTest\t3\t1700000000000";
    const result = parseChatsFromAppleScript(input);
    expect(result).toHaveLength(1);
    expect(result[0].chatId).toBe("chat1");
  });

  it("handles extra tab-separated fields (forward compat)", () => {
    const input = "chat1\tTest\t3\t1700000000000\textra";
    const result = parseChatsFromAppleScript(input);
    expect(result).toHaveLength(1);
    expect(result[0].chatId).toBe("chat1");
  });

  it("parses AppleScript list output from getChats()", () => {
    const input =
      '{"iMessage;+;chat123", "Work Group"}, {"iMessage;-;+15551234567", missing value}';
    const result = parseChatsFromAppleScript(input);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      chatId: "iMessage;+;chat123",
      chatType: "group",
      displayName: "Work Group",
      participants: [],
    });
    expect(result[1]).toEqual({
      chatId: "iMessage;-;+15551234567",
      chatType: "direct",
      displayName: undefined,
      participants: [],
    });
  });
});

// ============================================================
// Error classes
// ============================================================

describe("Error classes", () => {
  it("IMessagePluginError has correct properties", () => {
    const error = new IMessagePluginError("test error", "TEST_CODE", {
      key: "value",
    });
    expect(error.message).toBe("test error");
    expect(error.code).toBe("TEST_CODE");
    expect(error.details).toEqual({ key: "value" });
    expect(error.name).toBe("IMessagePluginError");
    expect(error instanceof Error).toBe(true);
  });

  it("IMessageConfigurationError sets correct code", () => {
    const error = new IMessageConfigurationError("bad config", "cli_path");
    expect(error.code).toBe("CONFIGURATION_ERROR");
    expect(error.details).toEqual({ setting: "cli_path" });
    expect(error.name).toBe("IMessageConfigurationError");
    expect(error instanceof IMessagePluginError).toBe(true);
  });

  it("IMessageNotSupportedError has default message", () => {
    const error = new IMessageNotSupportedError();
    expect(error.message).toBe("iMessage is only supported on macOS");
    expect(error.code).toBe("NOT_SUPPORTED");
    expect(error.name).toBe("IMessageNotSupportedError");
  });

  it("IMessageNotSupportedError accepts custom message", () => {
    const error = new IMessageNotSupportedError("custom msg");
    expect(error.message).toBe("custom msg");
  });

  it("IMessageCliError includes exit code", () => {
    const error = new IMessageCliError("command failed", 1);
    expect(error.code).toBe("CLI_ERROR");
    expect(error.details).toEqual({ exitCode: 1 });
    expect(error.name).toBe("IMessageCliError");
  });

  it("IMessageCliError handles undefined exit code", () => {
    const error = new IMessageCliError("command failed");
    expect(error.details).toBeUndefined();
  });
});

// ============================================================
// Action validation
// ============================================================

// IMESSAGE_SEND_MESSAGE used to be a standalone action; now the iMessage
// MessageConnector (registered by IMessageService.registerSendHandlers) is
// the canonical send path through SEND_MESSAGE. The plugin no longer ships a
// dedicated send action, so the action-shape and validate/handler tests that
// lived here have been retired with the action.

// ============================================================
// Chat context provider
// ============================================================

describe("chatContextProvider", () => {
  it("has correct provider metadata", () => {
    expect(chatContextProvider.name).toBe("imessageChatContext");
    expect(chatContextProvider.description).toContain("iMessage");
  });
});

// ============================================================
// chat.db reader (bun:sqlite) — inbound polling
// ============================================================

describe("appleDateToJsMs", () => {
  it("returns 0 for 0 or negative input", () => {
    expect(appleDateToJsMs(0)).toBe(0);
    expect(appleDateToJsMs(-100)).toBe(0);
  });

  it("converts a seconds-scale Apple date to JS ms", () => {
    // 1 second past Apple epoch → 2001-01-01T00:00:01Z
    const ms = appleDateToJsMs(1);
    expect(new Date(ms).toISOString()).toBe("2001-01-01T00:00:01.000Z");
  });

  it("converts a nanoseconds-scale Apple date to JS ms", () => {
    // 1e15 ns is clearly past the 1e12 split point, so the implementation
    // takes the nanoseconds branch: deltaMs = 1e15 / 1e6 = 1e9 ms past
    // the Apple epoch (≈ 11.6 days).
    expect(appleDateToJsMs(1e15)).toBe(Date.UTC(2001, 0, 1) + 1e9);
  });

  it("handles a realistic modern timestamp", () => {
    // 2024-06-15T12:00:00Z in nanoseconds since Apple epoch:
    // (2024-06-15 - 2001-01-01) in ms * 1_000_000
    const targetMs = Date.UTC(2024, 5, 15, 12, 0, 0);
    const deltaNs = (targetMs - Date.UTC(2001, 0, 1)) * 1_000_000;
    expect(appleDateToJsMs(deltaNs)).toBe(targetMs);
  });
});

describe("chatDbMessageToPublicShape", () => {
  it("maps every ChatDbMessage field onto the public IMessageMessage shape", () => {
    const result = chatDbMessageToPublicShape({
      rowId: 42,
      guid: "guid-42",
      text: "hey",
      kind: "text",
      handle: "+15551234567",
      chatId: "iMessage;-;+15551234567",
      chatType: "direct",
      displayName: null,
      timestamp: 1_700_000_000_000,
      isFromMe: false,
      service: "iMessage",
      isSent: true,
      isDelivered: true,
      isRead: false,
      dateRead: 0,
      dateEdited: 0,
      dateRetracted: 0,
      replyToGuid: null,
      reaction: null,
      attachments: [
        {
          guid: "att-1",
          filename: "/tmp/image.png",
          uti: "public.png",
          mimeType: "image/png",
          totalBytes: 123,
          isSticker: false,
        },
      ],
    });

    expect(result).toEqual({
      id: "42",
      text: "hey",
      handle: "+15551234567",
      chatId: "iMessage;-;+15551234567",
      timestamp: 1_700_000_000_000,
      isFromMe: false,
      hasAttachments: true,
      attachmentPaths: ["/tmp/image.png"],
    });
  });
});

describe("openChatDb + ChatDbReader (bun:sqlite backed)", () => {
  // These tests create a real SQLite file on disk and open it via the
  // same openChatDb() the service uses, so the entire query path —
  // prepared statements, joins, text filtering, ROWID cursor, and null
  // handling are exercised against a real SQLite engine under whichever
  // runtime is driving the suite.
  type FixtureDatabase = {
    run(sql: string): unknown;
    close(): void;
  };
  type SqlStatement = {
    all(...params: unknown[]): unknown[];
    run?(...params: unknown[]): unknown;
  };
  type BunFixtureDatabase = {
    run?(sql: string): unknown;
    exec?(sql: string): unknown;
    query?(sql: string): SqlStatement;
    close(): void;
  };

  let createDatabase: ((path: string) => FixtureDatabase) | null = null;

  async function getDatabase() {
    if (createDatabase) {
      return createDatabase;
    }

    try {
      const mod = (await import("node:sqlite")) as {
        DatabaseSync?: new (
          path: string
        ) => {
          exec(sql: string): unknown;
          close(): void;
        };
        default?: {
          DatabaseSync?: new (
            path: string
          ) => {
            exec(sql: string): unknown;
            close(): void;
          };
        };
      };
      const DatabaseSync = mod.DatabaseSync ?? mod.default?.DatabaseSync;
      if (DatabaseSync) {
        createDatabase = (path: string) => {
          const db = new DatabaseSync(path);
          return {
            run(sql: string) {
              return db.exec(sql);
            },
            close() {
              db.close();
            },
          };
        };
        return createDatabase;
      }
    } catch {
      // Fall through to Bun's SQLite runtime.
    }

    try {
      const mod = runtimeRequire("bun:sqlite") as {
        Database?: new (path: string) => BunFixtureDatabase;
        default?: new (path: string) => BunFixtureDatabase;
      };
      const Database = mod.Database ?? mod.default;
      if (!Database) {
        return null;
      }
      createDatabase = (path: string) => {
        const db = new Database(path);
        return {
          run(sql: string) {
            if (typeof db.run === "function") {
              return db.run(sql);
            }
            if (typeof db.exec === "function") {
              return db.exec(sql);
            }
            if (typeof db.query === "function") {
              const statement = db.query(sql);
              if (typeof statement.run === "function") {
                return statement.run();
              }
              return statement.all();
            }

            throw new Error("SQLite runtime does not expose a fixture-compatible execute method");
          },
          close() {
            db.close();
          },
        };
      };
      return createDatabase;
    } catch {
      return null;
    }
  }

  async function makeFixtureDb(
    skip: (reason?: string) => void
  ): Promise<{ path: string; cleanup: () => void }> {
    const dir = mkdtempSync(join(tmpdir(), "imessage-chatdb-test-"));
    const path = join(dir, "chat.db");
    const openDatabase = await getDatabase();
    if (!openDatabase) {
      rmSync(dir, { recursive: true, force: true });
      skip("No supported SQLite runtime is available for iMessage fixture tests");
      throw new Error("unreachable");
    }
    const db = openDatabase(path);

    db.run(`
      CREATE TABLE handle (
        ROWID INTEGER PRIMARY KEY,
        id TEXT,
        service TEXT
      );
    `);
    db.run(`
      CREATE TABLE chat (
        ROWID INTEGER PRIMARY KEY,
        chat_identifier TEXT,
        display_name TEXT,
        service_name TEXT,
        style INTEGER,
        last_read_message_timestamp INTEGER
      );
    `);
    db.run(`
      CREATE TABLE message (
        ROWID INTEGER PRIMARY KEY,
        guid TEXT,
        text TEXT,
        attributedBody BLOB,
        date INTEGER,
        date_read INTEGER,
        date_edited INTEGER,
        date_retracted INTEGER,
        is_from_me INTEGER,
        is_read INTEGER,
        is_sent INTEGER,
        is_delivered INTEGER,
        item_type INTEGER,
        reply_to_guid TEXT,
        associated_message_guid TEXT,
        associated_message_type INTEGER,
        associated_message_emoji TEXT,
        cache_has_attachments INTEGER,
        service TEXT,
        handle_id INTEGER
      );
    `);
    db.run(`
      CREATE TABLE chat_message_join (
        chat_id INTEGER,
        message_id INTEGER
      );
    `);
    db.run(`
      CREATE TABLE chat_handle_join (
        chat_id INTEGER,
        handle_id INTEGER
      );
    `);
    db.run(`
      CREATE TABLE attachment (
        ROWID INTEGER PRIMARY KEY,
        guid TEXT,
        transfer_name TEXT,
        filename TEXT,
        mime_type TEXT,
        uti TEXT,
        total_bytes INTEGER,
        is_sticker INTEGER
      );
    `);
    db.run(`
      CREATE TABLE message_attachment_join (
        message_id INTEGER,
        attachment_id INTEGER
      );
    `);

    // Two contacts: +15551234567 (DM) and a group with +15559999999 + sender.
    db.run("INSERT INTO handle (ROWID, id, service) VALUES (1, '+15551234567', 'iMessage')");
    db.run("INSERT INTO handle (ROWID, id, service) VALUES (2, '+15559999999', 'iMessage')");

    db.run(
      "INSERT INTO chat (ROWID, chat_identifier, display_name, service_name, style, last_read_message_timestamp) VALUES (1, 'iMessage;-;+15551234567', NULL, 'iMessage', 45, 2000)"
    );
    db.run(
      "INSERT INTO chat (ROWID, chat_identifier, display_name, service_name, style, last_read_message_timestamp) VALUES (2, 'iMessage;+;group-abc', 'Weekend Plans', 'iMessage', 43, 3000)"
    );
    db.run("INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (1, 1)");
    db.run("INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (2, 2)");

    // Seconds-scale Apple date for simplicity: 1000 = 2001-01-01 +1000s
    db.run(
      "INSERT INTO message (ROWID, guid, text, date, is_from_me, handle_id, service) VALUES (10, 'guid-10', 'first', 1000, 0, 1, 'iMessage')"
    );
    db.run(
      "INSERT INTO message (ROWID, guid, text, date, is_from_me, handle_id, service) VALUES (11, 'guid-11', 'outbound reply', 2000, 1, 1, 'iMessage')"
    );
    db.run(
      "INSERT INTO message (ROWID, guid, text, date, is_from_me, handle_id, service) VALUES (12, 'guid-12', 'group hello', 3000, 0, 2, 'iMessage')"
    );
    // Null-text row with no attributedBody — decoder miss, should be skipped.
    db.run(
      "INSERT INTO message (ROWID, guid, text, date, is_from_me, handle_id, service) VALUES (13, 'guid-13', NULL, 4000, 0, 1, 'iMessage')"
    );

    db.run("INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 10)");
    db.run("INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 11)");
    db.run("INSERT INTO chat_message_join (chat_id, message_id) VALUES (2, 12)");
    db.run("INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 13)");

    db.close();

    return {
      path,
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  }

  it("returns messages in ROWID order past the cursor", async ({ skip }) => {
    const { path, cleanup } = await makeFixtureDb(skip);
    try {
      const reader = await openChatDb(path);
      expect(reader).not.toBeNull();
      if (!reader) return;

      const rows = reader.fetchNewMessages(0, 100);
      const rowIds = rows.map((r) => r.rowId);
      // ROWID 13 has null text and no attributedBody; it's still returned
      // (with empty text) so the cursor can advance past it — the service
      // layer skips empty-text rows before dispatch.
      expect(rowIds).toEqual([10, 11, 12, 13]);

      reader.close();
    } finally {
      cleanup();
    }
  });

  it("classifies direct vs group chats via chat.style", async ({ skip }) => {
    const { path, cleanup } = await makeFixtureDb(skip);
    try {
      const reader = await openChatDb(path);
      if (!reader) return;

      const rows = reader.fetchNewMessages(0, 100);
      const direct = rows.find((r) => r.rowId === 10);
      const group = rows.find((r) => r.rowId === 12);

      expect(direct?.chatType).toBe("direct");
      expect(group?.chatType).toBe("group");
      expect(group?.displayName).toBe("Weekend Plans");

      reader.close();
    } finally {
      cleanup();
    }
  });

  it("marks outbound messages with isFromMe=true", async ({ skip }) => {
    const { path, cleanup } = await makeFixtureDb(skip);
    try {
      const reader = await openChatDb(path);
      if (!reader) return;

      const outbound = reader.fetchNewMessages(0, 100).find((r) => r.rowId === 11);

      expect(outbound?.isFromMe).toBe(true);
      expect(outbound?.text).toBe("outbound reply");

      reader.close();
    } finally {
      cleanup();
    }
  });

  it("respects the sinceRowId cursor", async ({ skip }) => {
    const { path, cleanup } = await makeFixtureDb(skip);
    try {
      const reader = await openChatDb(path);
      if (!reader) return;

      const afterTen = reader.fetchNewMessages(10, 100);
      expect(afterTen.map((r) => r.rowId)).toEqual([11, 12, 13]);

      const afterEleven = reader.fetchNewMessages(11, 100);
      expect(afterEleven.map((r) => r.rowId)).toEqual([12, 13]);

      reader.close();
    } finally {
      cleanup();
    }
  });

  it("listMessages returns the newest rows in chronological order", async ({ skip }) => {
    const { path, cleanup } = await makeFixtureDb(skip);
    try {
      const reader = await openChatDb(path);
      if (!reader) return;

      const rows = reader.listMessages({ limit: 3 });
      expect(rows.map((r) => r.rowId)).toEqual([11, 12, 13]);

      reader.close();
    } finally {
      cleanup();
    }
  });

  it("listMessages can scope reads to a single chat identifier", async ({ skip }) => {
    const { path, cleanup } = await makeFixtureDb(skip);
    try {
      const reader = await openChatDb(path);
      if (!reader) return;

      const rows = reader.listMessages({
        chatId: "iMessage;-;+15551234567",
        limit: 10,
      });
      expect(rows.map((r) => r.rowId)).toEqual([10, 11, 13]);
      expect(new Set(rows.map((r) => r.chatId))).toEqual(new Set(["iMessage;-;+15551234567"]));

      reader.close();
    } finally {
      cleanup();
    }
  });

  it("getLatestRowId returns the maximum ROWID in the table", async ({ skip }) => {
    const { path, cleanup } = await makeFixtureDb(skip);
    try {
      const reader = await openChatDb(path);
      if (!reader) return;

      // Max ROWID in the fixture is 13 (the null-text row), so
      // getLatestRowId must still see it — only fetchNewMessages filters it.
      expect(reader.getLatestRowId()).toBe(13);

      reader.close();
    } finally {
      cleanup();
    }
  });

  it("returns null-text rows with empty text so the service layer can advance its cursor", async ({
    skip,
  }) => {
    const { path, cleanup } = await makeFixtureDb(skip);
    try {
      const reader = await openChatDb(path);
      if (!reader) return;

      const rows = reader.fetchNewMessages(0, 100);
      // ROWID 13 is included so the service cursor can skip past it, but
      // its text is empty so the service will drop it before dispatch.
      const undecodable = rows.find((r) => r.rowId === 13);
      expect(undecodable).toBeDefined();
      expect(undecodable?.text).toBe("");

      reader.close();
    } finally {
      cleanup();
    }
  });

  it("limit parameter caps the batch size", async ({ skip }) => {
    const { path, cleanup } = await makeFixtureDb(skip);
    try {
      const reader = await openChatDb(path);
      if (!reader) return;

      const rows = reader.fetchNewMessages(0, 2);
      expect(rows.length).toBeLessThanOrEqual(2);

      reader.close();
    } finally {
      cleanup();
    }
  });

  it("close() is idempotent and subsequent reads return empty", async ({ skip }) => {
    const { path, cleanup } = await makeFixtureDb(skip);
    try {
      const reader = await openChatDb(path);
      if (!reader) return;

      reader.close();
      reader.close(); // should not throw

      const rows = reader.fetchNewMessages(0, 100);
      expect(rows).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("returns null when the chat.db path does not exist", async () => {
    const reader = await openChatDb("/nonexistent/path/to/chat.db");
    expect(reader).toBeNull();
  });

  it("logs one actionable warning for repeated failures on the same chat.db path", async ({
    skip,
  }) => {
    const openDatabase = await getDatabase();
    if (!openDatabase) {
      skip("No supported SQLite runtime is available for iMessage open-failure diagnostics");
      return;
    }

    const missingPath = join(
      tmpdir(),
      `imessage-missing-chatdb-${Date.now()}-${Math.random()}`,
      "chat.db"
    );
    const warnings: string[] = [];
    const debugs: string[] = [];
    const diagnosticsLogger = {
      warn: (message: string) => warnings.push(message),
      debug: (message: string) => debugs.push(message),
    };

    await openChatDb(missingPath, { diagnosticsLogger });

    // The runtime's tryLoadSqlite path is stricter than the test helper's:
    // it tries `bun:sqlite` via createRequire then `await import("node:sqlite")`.
    // On some CI configurations (notably bun-running-vitest where the worker
    // can't see bun:sqlite and node:sqlite ESM resolution differs from the
    // test helper's), tryLoadSqlite returns null even when our helper's
    // node:sqlite import succeeds. In that case the warning we're testing
    // for never fires — skip rather than fail.
    const accessIssueProbe = getLastChatDbAccessIssue(missingPath);
    if (accessIssueProbe?.code === "sqlite_unavailable") {
      skip(
        "Runtime tryLoadSqlite resolved to null in this worker — open-failure warning path is not exercised"
      );
      return;
    }

    await openChatDb(missingPath, { diagnosticsLogger });

    const matchingWarnings = warnings.filter((message) =>
      message.includes(`Failed to open chat.db at ${missingPath}`)
    );
    const matchingDebugs = debugs.filter((message) =>
      message.includes(`chat.db at ${missingPath} is still unavailable`)
    );

    expect(matchingWarnings).toHaveLength(1);
    expect(matchingWarnings[0]).toContain("Full Disk Access");
    expect(matchingDebugs).toHaveLength(1);

    const accessIssue = getLastChatDbAccessIssue(missingPath);
    expect(accessIssue?.code).toBe("open_failed");
    expect(accessIssue?.permissionAction?.type).toBe("full_disk_access");
    expect(accessIssue?.permissionAction?.url).toContain("Privacy_AllFiles");
  });
});

// ============================================================
// Contacts reader (AppleScript-backed)
// ============================================================

describe("normalizeContactHandle", () => {
  it("returns empty for empty input", () => {
    expect(normalizeContactHandle("")).toBe("");
    expect(normalizeContactHandle("   ")).toBe("");
  });

  it("lowercases emails", () => {
    expect(normalizeContactHandle("Alex@Example.COM")).toBe("alex@example.com");
  });

  it("strips formatting from phone numbers while preserving a leading +", () => {
    expect(normalizeContactHandle("+1 (555) 123-4567")).toBe("+15551234567");
    expect(normalizeContactHandle("(555) 123.4567")).toBe("5551234567");
    expect(normalizeContactHandle("555 123 4567")).toBe("5551234567");
  });

  it("trims whitespace around the input", () => {
    expect(normalizeContactHandle("  +15551234567  ")).toBe("+15551234567");
  });
});

describe("parseContactsOutput", () => {
  it("returns an empty map for empty or whitespace-only input", () => {
    expect(parseContactsOutput("").size).toBe(0);
    expect(parseContactsOutput("   \n\n  ").size).toBe(0);
  });

  it("parses phone and email rows with tab-delimited fields", () => {
    const input = [
      "phone\t+1 (555) 123-4567\tAlex Chen",
      "email\tmom@example.com\tMom",
      "phone\t+15550000000\tDad",
    ].join("\n");

    const map = parseContactsOutput(input);

    expect(map.size).toBe(3);
    expect(map.get("+15551234567")?.name).toBe("Alex Chen");
    expect(map.get("mom@example.com")?.name).toBe("Mom");
    expect(map.get("+15550000000")?.name).toBe("Dad");
  });

  it("skips rows with missing handle or name", () => {
    const input = [
      "phone\t\tNo handle here",
      "phone\t+15551234567\t",
      "phone\t+15559999999\tValid",
    ].join("\n");

    const map = parseContactsOutput(input);

    expect(map.size).toBe(1);
    expect(map.get("+15559999999")?.name).toBe("Valid");
  });

  it("keeps the first entry when the same handle appears twice", () => {
    const input = ["phone\t+15551234567\tFirst Name", "phone\t+15551234567\tSecond Name"].join(
      "\n"
    );

    const map = parseContactsOutput(input);

    expect(map.get("+15551234567")?.name).toBe("First Name");
  });

  it("ignores lines with fewer than three fields", () => {
    const input = [
      "phone\t+15551234567", // only 2 fields
      "just one field",
      "phone\t+15559999999\tOK",
    ].join("\n");

    const map = parseContactsOutput(input);

    expect(map.size).toBe(1);
    expect(map.get("+15559999999")?.name).toBe("OK");
  });
});
