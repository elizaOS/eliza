import { describe, expect, it } from "vitest";
import { splitTelegramMessage, TELEGRAM_MAX_MESSAGE } from "./limits";

describe("splitTelegramMessage", () => {
  it("returns no chunks for empty input", () => {
    expect(splitTelegramMessage("")).toEqual([]);
  });

  it("keeps short input in a single chunk", () => {
    const text = "hello world";

    expect(splitTelegramMessage(text)).toEqual([text]);
  });

  it("keeps exact-limit input in a single chunk", () => {
    const text = "x".repeat(TELEGRAM_MAX_MESSAGE);

    expect(splitTelegramMessage(text)).toEqual([text]);
  });

  it("splits oversized input into limit-bounded chunks", () => {
    const text = "x".repeat(TELEGRAM_MAX_MESSAGE * 2 + 17);
    const chunks = splitTelegramMessage(text);

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(TELEGRAM_MAX_MESSAGE);
    expect(chunks[1]).toHaveLength(TELEGRAM_MAX_MESSAGE);
    expect(chunks[2]).toHaveLength(17);
    expect(chunks.join("")).toBe(text);
  });
});
