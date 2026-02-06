import { describe, expect, it } from "vitest";

import imessagePlugin, {
  IMessageService,
  chatContextProvider,
  sendMessage,
  // Type utilities
  isPhoneNumber,
  isEmail,
  isValidIMessageTarget,
  normalizeIMessageTarget,
  formatPhoneNumber,
  splitMessageForIMessage,
  MAX_IMESSAGE_MESSAGE_LENGTH,
  // Parsing functions
  parseMessagesFromAppleScript,
  parseChatsFromAppleScript,
  // Error classes
  IMessagePluginError,
  IMessageConfigurationError,
  IMessageNotSupportedError,
  IMessageCliError,
  // Event types
  IMessageEventTypes,
  IMESSAGE_SERVICE_NAME,
} from "../src/index";

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

  it("exports actions, providers, and service", () => {
    expect(sendMessage).toBeDefined();
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
    expect(IMessageEventTypes.MESSAGE_RECEIVED).toBe(
      "IMESSAGE_MESSAGE_RECEIVED",
    );
    expect(IMessageEventTypes.MESSAGE_SENT).toBe("IMESSAGE_MESSAGE_SENT");
    expect(IMessageEventTypes.CONNECTION_READY).toBe(
      "IMESSAGE_CONNECTION_READY",
    );
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
    expect(normalizeIMessageTarget("user@example.com")).toBe(
      "user@example.com",
    );
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
    const text = "a".repeat(60) + "\n" + "b".repeat(30);
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
    const input =
      "msg001\tHello there\t1700000000000\t0\tchat123\t+15551234567";
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
    const input =
      "partial\tdata\n" +
      "msg001\tHello\t1700000000000\t0\tchat1\t+15551234567";
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
    const input = "\t\t1000\t0\t\t";
    const result = parseMessagesFromAppleScript(input);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("");
    expect(result[0].text).toBe("");
    expect(result[0].chatId).toBe("");
    expect(result[0].handle).toBe("");
  });

  it("handles extra tab-separated fields (forward compat)", () => {
    const input =
      "msg001\tHello\t1000\t1\tchat1\tsender\textra1\textra2";
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
    const input =
      "incomplete\tdata\n" + "chat1\tTest\t3\t1700000000000";
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

describe("sendMessage action", () => {
  it("has correct action metadata", () => {
    expect(sendMessage.name).toBe("IMESSAGE_SEND_MESSAGE");
    expect(sendMessage.description).toContain("iMessage");
    expect(Array.isArray(sendMessage.similes)).toBe(true);
    expect(sendMessage.similes?.length).toBeGreaterThan(0);
    expect(Array.isArray(sendMessage.examples)).toBe(true);
    expect(sendMessage.examples?.length).toBeGreaterThan(0);
  });

  it("validate returns false for non-imessage sources", async () => {
    const mockRuntime = {} as Parameters<
      NonNullable<typeof sendMessage.validate>
    >[0];
    const mockMessage = {
      content: { source: "discord" },
    } as Parameters<NonNullable<typeof sendMessage.validate>>[1];

    const result = await sendMessage.validate!(mockRuntime, mockMessage);
    expect(result).toBe(false);
  });

  it("validate returns true for imessage source", async () => {
    const mockRuntime = {} as Parameters<
      NonNullable<typeof sendMessage.validate>
    >[0];
    const mockMessage = {
      content: { source: "imessage" },
    } as Parameters<NonNullable<typeof sendMessage.validate>>[1];

    const result = await sendMessage.validate!(mockRuntime, mockMessage);
    expect(result).toBe(true);
  });
});

// ============================================================
// Chat context provider
// ============================================================

describe("chatContextProvider", () => {
  it("has correct provider metadata", () => {
    expect(chatContextProvider.name).toBe("imessageChatContext");
    expect(chatContextProvider.description).toContain("iMessage");
  });
});
