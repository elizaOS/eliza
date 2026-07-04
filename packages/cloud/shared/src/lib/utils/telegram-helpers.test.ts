// Exercises telegram helpers behavior with deterministic cloud-shared lib fixtures.
import { describe, expect, test } from "vitest";
import {
  convertToTelegramMarkdown,
  escapeMarkdownV2,
  extractMessageText,
  isCommand,
  maskChatId,
  parseBotToken,
  parseCommand,
  splitMessage,
} from "./telegram-helpers";

/**
 * Telegram formatting + parsing helpers. MarkdownV2 escaping must backslash
 * every reserved char (an unescaped one makes Telegram reject the whole send);
 * splitMessage must respect the 4096 cap; maskChatId redacts a PII id in logs;
 * parseCommand strips the @botname suffix so group commands route correctly.
 */

describe("escapeMarkdownV2 / convertToTelegramMarkdown", () => {
  test("escapes every reserved MarkdownV2 char", () => {
    expect(escapeMarkdownV2("a.b-c!")).toBe("a\\.b\\-c\\!");
    expect(escapeMarkdownV2("")).toBe("");
  });

  test("converts **bold** / _italic_ / `code` back to Telegram syntax", () => {
    expect(convertToTelegramMarkdown("**bold**")).toBe("*bold*");
    expect(convertToTelegramMarkdown("say `code` now")).toBe("say `code` now");
    // a stray dot stays escaped so the send is not rejected.
    expect(convertToTelegramMarkdown("end.")).toBe("end\\.");
  });
});

describe("splitMessage", () => {
  test("returns one chunk under the cap, splits oversize lines", () => {
    expect(splitMessage("")).toEqual([]);
    expect(splitMessage("short")).toEqual(["short"]);
    const long = "x".repeat(10);
    const chunks = splitMessage(long, 4);
    expect(chunks.every((c) => c.length <= 4)).toBe(true);
    expect(chunks.join("")).toBe(long);
  });
});

describe("parseBotToken", () => {
  test("valid token yields the bot id; malformed is rejected", () => {
    expect(parseBotToken("123456:ABC-def")).toEqual({ botId: "123456", valid: true });
    expect(parseBotToken("nocolon")).toEqual({ botId: "", valid: false });
    expect(parseBotToken("123:")).toEqual({ botId: "", valid: false });
  });
});

describe("maskChatId", () => {
  test("redacts the middle of long ids, leaves short ones", () => {
    expect(maskChatId(1234567890)).toBe("12...90");
    expect(maskChatId("99")).toBe("99");
  });
});

describe("message + command parsing", () => {
  test("extractMessageText prefers text then caption", () => {
    expect(extractMessageText({ text: "hi" })).toBe("hi");
    expect(extractMessageText({ caption: "cap" })).toBe("cap");
    expect(extractMessageText({})).toBe("");
  });

  test("isCommand + parseCommand strip @botname and split args", () => {
    expect(isCommand("/start")).toBe(true);
    expect(isCommand("hello")).toBe(false);
    expect(parseCommand("/Start@MyBot foo bar")).toEqual({
      command: "/start",
      args: ["foo", "bar"],
      raw: "foo bar",
    });
  });
});
