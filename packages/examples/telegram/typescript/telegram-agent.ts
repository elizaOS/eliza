/**
 * Telegram bot using elizaOS with full message pipeline.
 * 
 * Required env vars: TELEGRAM_BOT_TOKEN, OPENAI_API_KEY
 * Optional: POSTGRES_URL (defaults to PGLite)
 */

import { AgentRuntime, createCharacter } from "@elizaos/core";
import { openaiPlugin } from "@elizaos/plugin-openai";
import sqlPlugin from "@elizaos/plugin-sql";
import telegramPlugin from "@elizaos/plugin-telegram";

async function main() {
  const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
  const openaiApiKey = process.env.OPENAI_API_KEY;

  if (!telegramBotToken || !openaiApiKey) {
    console.error("Missing TELEGRAM_BOT_TOKEN or OPENAI_API_KEY");
    process.exit(1);
  }

  const character = createCharacter({
    name: "TelegramEliza",
    bio: "A helpful AI assistant on Telegram.",
    system: `You are TelegramEliza, a helpful AI assistant on Telegram.
Be friendly, concise, and genuinely helpful.
Keep responses short - suitable for mobile chat.`,
    settings: {
      // Match how the chat example configures model selection via runtime settings
      // (read by @elizaos/plugin-openai).
      OPENAI_SMALL_MODEL: "gpt-5-mini",
      OPENAI_LARGE_MODEL: "gpt-5-mini",
    },
    // Optional: pass through secrets so plugins can read via runtime.getSetting()
    secrets: {
      TELEGRAM_BOT_TOKEN: telegramBotToken,
      OPENAI_API_KEY: openaiApiKey,
    },
  });

  console.log("Starting TelegramEliza...");

  const runtime = new AgentRuntime({
    character,
    plugins: [sqlPlugin, openaiPlugin, telegramPlugin],
  });

  await runtime.initialize();

  console.log(`${character.name} is running. Press Ctrl+C to stop.`);

  process.on("SIGINT", async () => {
    await runtime.stop();
    process.exit(0);
  });

  await new Promise(() => {});
}

main().catch(console.error);
