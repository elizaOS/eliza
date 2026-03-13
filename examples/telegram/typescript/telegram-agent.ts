/**
 * Telegram bot using elizaOS with full message pipeline.
 *
 * Required env vars: TELEGRAM_BOT_TOKEN, OPENAI_API_KEY
 * Optional: POSTGRES_URL (defaults to in-memory; use createDatabaseAdapter for persistence)
 */

import {
  AgentRuntime,
  createCharacter,
  InMemoryDatabaseAdapter,
  mergeDbSettings,
  provisionAgent,
  stringToUuid,
} from "@elizaos/core";
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
      OPENAI_SMALL_MODEL: "gpt-5-mini",
      OPENAI_LARGE_MODEL: "gpt-5-mini",
    },
    secrets: {
      TELEGRAM_BOT_TOKEN: telegramBotToken,
      OPENAI_API_KEY: openaiApiKey,
    },
  });

  console.log("Starting TelegramEliza...");

  const agentId = stringToUuid(character.name ?? "TelegramEliza");
  const adapter = process.env.POSTGRES_URL
    ? (await import("@elizaos/plugin-sql")).createDatabaseAdapter(
        { postgresUrl: process.env.POSTGRES_URL },
        agentId,
      )
    : new InMemoryDatabaseAdapter();
  await adapter.initialize();

  const characterWithSettings = await mergeDbSettings(character, adapter, agentId);

  const runtime = new AgentRuntime({
    character: characterWithSettings,
    adapter,
    plugins: [sqlPlugin, openaiPlugin, telegramPlugin],
  });

  await runtime.initialize();
  await provisionAgent(runtime, { runMigrations: true });

  const taskService = await runtime.getService("task");
  if (taskService && typeof (taskService as { startTimer?: () => void }).startTimer === "function") {
    (taskService as { startTimer: () => void }).startTimer();
  }

  console.log(`${character.name} is running. Press Ctrl+C to stop.`);

  process.on("SIGINT", async () => {
    await runtime.stop();
    process.exit(0);
  });

  await new Promise(() => {});
}

main().catch(console.error);
