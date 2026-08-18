import { toWellFormedUnicode } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  splitMessage as splitDiscordMessage,
  truncate as truncateDiscord,
} from "./discord-helpers";
import { splitMessage as splitTelegramMessage } from "./telegram-helpers";

describe("cloud/shared telegram and discord surrogate-pair chunking", () => {
  const invalidLimits = [
    1,
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ];

  it("keeps surrogate pairs intact in telegram splitMessage", () => {
    const text = `a${"🙂".repeat(4096)}`;
    const chunks = splitTelegramMessage(text, 4096);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4096);
      expect(toWellFormedUnicode(chunk)).toBe(chunk);
    }
  });

  it("keeps surrogate pairs intact in discord splitMessage", () => {
    const text = `a${"🙂".repeat(2000)}`;
    const chunks = splitDiscordMessage(text, 2000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(2000);
      expect(toWellFormedUnicode(chunk)).toBe(chunk);
    }
  });

  it("keeps surrogate pairs intact in discord truncate", () => {
    const text = `a${"🙂".repeat(20)}`;
    const truncated = truncateDiscord(text, 10);
    expect(truncated.endsWith("...")).toBe(true);
    expect(toWellFormedUnicode(truncated)).toBe(truncated);
  });

  it.each([
    ["telegram", splitTelegramMessage],
    ["discord", splitDiscordMessage],
  ] as const)("rejects unsafe %s chunk limits before splitting", (_name, splitMessage) => {
    for (const limit of invalidLimits) {
      expect(() => splitMessage("😀x", limit)).toThrow(RangeError);
    }
  });

  it.each([
    ["telegram", splitTelegramMessage],
    ["discord", splitDiscordMessage],
  ] as const)(
    "makes nonempty, lossless progress at the minimum %s limit",
    (_name, splitMessage) => {
      const text = "😀😀x";
      const chunks = splitMessage(text, 2);

      expect(chunks.join("")).toBe(text);
      expect(chunks.every((chunk) => chunk.length > 0 && chunk.length <= 2)).toBe(true);
      expect(chunks.every((chunk) => toWellFormedUnicode(chunk) === chunk)).toBe(true);
    },
  );
});
