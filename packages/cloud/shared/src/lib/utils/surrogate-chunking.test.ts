import { describe, expect, it } from "vitest";
import {
  splitMessage as splitDiscordMessage,
  truncate as truncateDiscord,
} from "./discord-helpers";
import { splitMessage as splitTelegramMessage } from "./telegram-helpers";

describe("cloud/shared telegram and discord surrogate-pair chunking", () => {
  it("keeps surrogate pairs intact in telegram splitMessage", () => {
    const text = `a${"🙂".repeat(4096)}`;
    const chunks = splitTelegramMessage(text, 4096);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4096);
      expect(chunk.isWellFormed()).toBe(true);
    }
  });

  it("keeps surrogate pairs intact in discord splitMessage", () => {
    const text = `a${"🙂".repeat(2000)}`;
    const chunks = splitDiscordMessage(text, 2000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(2000);
      expect(chunk.isWellFormed()).toBe(true);
    }
  });

  it("keeps surrogate pairs intact in discord truncate", () => {
    const text = `a${"🙂".repeat(20)}`;
    const truncated = truncateDiscord(text, 10);
    expect(truncated.endsWith("...")).toBe(true);
    expect(truncated.isWellFormed()).toBe(true);
  });
});
