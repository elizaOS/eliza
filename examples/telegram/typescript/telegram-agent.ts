/**
 * Telegram bot using elizaOS with full message pipeline.
 *
 * Required env vars: TELEGRAM_BOT_TOKEN, OPENAI_API_KEY
 * Optional: POSTGRES_URL (with it: plugin-sql; without: in-memory via plugin-inmemorydb)
 */

import { loadCharacters, createRuntimes } from "@elizaos/core";
import { openaiPlugin } from "@elizaos/plugin-openai";
import telegramPlugin from "@elizaos/plugin-telegram";

async function main() {
  const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
  const openaiApiKey = process.env.OPENAI_API_KEY;

  if (!telegramBotToken || !openaiApiKey) {
    console.error("Missing TELEGRAM_BOT_TOKEN or OPENAI_API_KEY");
    process.exit(1);
  }

  const adapterPlugin = process.env.POSTGRES_URL ? "@elizaos/plugin-sql" : "@elizaos/plugin-inmemorydb";

  const characterInput = {
    name: "TelegramEliza",
    bio: "A helpful AI assistant on Telegram.",
    system: `You are TelegramEliza, a helpful AI assistant on Telegram.
Be friendly, concise, and genuinely helpful.
Keep responses short - suitable for mobile chat.`,
    plugins: [adapterPlugin],
    settings: {
      OPENAI_SMALL_MODEL: "gpt-4o-mini",
      OPENAI_LARGE_MODEL: "gpt-4o-mini",
    },
    secrets: {
      // Note: stores sensitive information securely for API integration with external services
      TELEGRAM_BOT_TOKEN: telegramBotToken,
      OPENAI_API_KEY: openaiApiKey,
    },
  };

  console.log("Starting TelegramEliza...");

  const characters = await loadCharacters([characterInput]);
  const runtimes = await createRuntimes(characters, {
    sharedPlugins: [openaiPlugin, telegramPlugin],
    provision: true,
    logLevel: "info",
  });

  const runtime = runtimes[0];
  if (!runtime) {
    throw new Error("No runtime created");
  }

  const taskService = await runtime.getService("task");
  const taskWithTimer = taskService as unknown as { startTimer?: () => void };
  if (taskWithTimer?.startTimer) {
    taskWithTimer.startTimer();
  }

  console.log(`${runtime.character.name} is running. Press Ctrl+C to stop.`);

  process.on("SIGINT", async () => {
    await runtime.stop();
    process.exit(0);
  });

  await new Promise(() => {});
}

main().catch(console.error);

