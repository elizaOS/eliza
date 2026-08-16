/** Exercises stable Telegram bot identity parsing across credential rotation. */

import { describe, expect, test } from "bun:test";
import { parseTelegramBotId } from "../src/telegram-account";

describe("parseTelegramBotId", () => {
  test("preserves the bot id when the credential suffix rotates", () => {
    expect(parseTelegramBotId("123456789:AAAAAAAAAAAAAAAAAAAA")).toBe(
      parseTelegramBotId("123456789:BBBBBBBBBBBBBBBBBBBB"),
    );
  });

  test("rejects ambiguous or incomplete credentials", () => {
    for (const token of [
      "123456789",
      "bot:AAAAAAAAAAAAAAAAAAAA",
      "0123:AAAAAAAAAAAAAAAAAAAA",
      "123:short",
      "123:AAAAAAAAAAAAAAAAAAA!",
    ]) {
      expect(() => parseTelegramBotId(token)).toThrow(
        "Telegram bot token is malformed",
      );
    }
  });
});
