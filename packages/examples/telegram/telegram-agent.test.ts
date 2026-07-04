/**
 * Bun tests for the Telegram example's environment validation and character
 * factory.
 */
import { expect, test } from "bun:test";
import { createTelegramCharacter, readRequiredEnv } from "./telegram-agent";

test("readRequiredEnv rejects missing or empty values", () => {
  const originalValue = process.env.TELEGRAM_BOT_TOKEN;
  try {
    delete process.env.TELEGRAM_BOT_TOKEN;
    expect(() => readRequiredEnv("TELEGRAM_BOT_TOKEN")).toThrow(
      "Missing required environment variable: TELEGRAM_BOT_TOKEN",
    );

    process.env.TELEGRAM_BOT_TOKEN = " ";
    expect(() => readRequiredEnv("TELEGRAM_BOT_TOKEN")).toThrow(
      "Missing required environment variable: TELEGRAM_BOT_TOKEN",
    );

    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    expect(readRequiredEnv("TELEGRAM_BOT_TOKEN")).toBe("bot-token");
  } finally {
    if (originalValue === undefined) {
      delete process.env.TELEGRAM_BOT_TOKEN;
    } else {
      process.env.TELEGRAM_BOT_TOKEN = originalValue;
    }
  }
});

test("createTelegramCharacter wires required secrets and mobile-friendly prompt", () => {
  const character = createTelegramCharacter({
    telegramBotToken: "telegram-token",
    openaiApiKey: "openai-key",
  });

  expect(character.name).toBe("TelegramEliza");
  expect(character.system).toContain("suitable for mobile chat");
  expect(character.settings?.OPENAI_SMALL_MODEL).toBe("gpt-5-mini");
  expect(character.secrets?.TELEGRAM_BOT_TOKEN).toBe("telegram-token");
  expect(character.secrets?.OPENAI_API_KEY).toBe("openai-key");
});
