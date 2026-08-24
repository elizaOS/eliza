// Exercises discord helpers behavior with deterministic cloud-shared lib fixtures.
import { describe, expect, test } from "vitest";
import {
  escapeMarkdown,
  getChannelTypeName,
  isTextChannel,
  isValidSnowflake,
  maskId,
  mention,
  splitMessage,
  createEmbed,
} from "./discord-helpers";

/**
 * Discord helpers. splitMessage must keep every chunk within the limit (the
 * 2000-char API cap), escapeMarkdown must neutralize formatting metacharacters
 * (injection), snowflake validation gates IDs, and maskId redacts for logs.
 */

describe("splitMessage", () => {
  test("returns chunks all within the limit with exact reassembly", () => {
    expect(splitMessage("", 100)).toEqual([]);
    expect(splitMessage("short", 100)).toEqual(["short"]);
    const long = Array.from({ length: 500 }, (_, i) => `word${i}`).join(" ");
    const chunks = splitMessage(long, 100);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 100)).toBe(true);
    expect(chunks.join("")).toBe(long);
    const whitespace = `  lead\n\n${"😀".repeat(80)}\ntrail  `;
    expect(splitMessage(whitespace, 17).join("")).toBe(whitespace);
  });
});

describe("escapeMarkdown", () => {
  test("backslash-escapes Discord formatting metacharacters", () => {
    expect(escapeMarkdown("a*b_c~d`e|f\\g")).toBe("a\\*b\\_c\\~d\\`e\\|f\\\\g");
    expect(escapeMarkdown("")).toBe("");
  });
});

describe("isValidSnowflake / maskId", () => {
  test("validates 17-19 digit ids and masks for logs", () => {
    expect(isValidSnowflake("1234567890123456789")).toBe(true); // 19 digits
    expect(isValidSnowflake("12345678901234567")).toBe(true); // 17 digits
    expect(isValidSnowflake("123")).toBe(false);
    expect(isValidSnowflake("12345678901234567890")).toBe(false); // 20 digits
    expect(isValidSnowflake("abc")).toBe(false);
    expect(maskId("1234567890")).toBe("123...890");
    expect(maskId("short")).toBe("short");
  });
});

describe("channel + text helpers", () => {
  test("channel type naming, text-channel check, and mentions", () => {
    expect(getChannelTypeName(0)).toBe("Text Channel");
    expect(getChannelTypeName(999)).toBe("Channel");
    expect(isTextChannel(0)).toBe(true);
    expect(isTextChannel(2)).toBe(false); // voice
    expect(mention("42", "user")).toBe("<@42>");
    expect(mention("42", "role")).toBe("<@&42>");
    expect(mention("42", "channel")).toBe("<#42>");
  });

  test("rejects an oversized embed description without discarding it", () => {
    expect(() => createEmbed({ description: "x".repeat(4097) })).toThrow(
      "Discord embed description exceeds the 4096-character protocol limit",
    );
    expect(createEmbed({ description: "x".repeat(4096) })).toEqual({
      description: "x".repeat(4096),
    });
  });
});
