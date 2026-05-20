/**
 * Telegram bot using elizaOS with full message pipeline.
 *
 * Required env vars: TELEGRAM_BOT_TOKEN, OPENAI_API_KEY
 * Optional: POSTGRES_URL (defaults to PGLite)
 */

import { AgentRuntime, createCharacter } from "@elizaos/core";

export function readRequiredEnv(key: string): string {
  const value = process.env[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

export function createTelegramCharacter(params: {
  telegramBotToken: string;
  openaiApiKey: string;
}) {
  return createCharacter({
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
      TELEGRAM_BOT_TOKEN: params.telegramBotToken,
      OPENAI_API_KEY: params.openaiApiKey,
    },
  });
}

async function main() {
  const [
    { openaiPlugin },
    { default: sqlPlugin },
    { default: telegramPlugin },
  ] = await Promise.all([
    import("@elizaos/plugin-openai"),
    import("@elizaos/plugin-sql"),
    import("@elizaos/plugin-telegram"),
  ]);

  let telegramBotToken: string;
  let openaiApiKey: string;
  try {
    telegramBotToken = readRequiredEnv("TELEGRAM_BOT_TOKEN");
    openaiApiKey = readRequiredEnv("OPENAI_API_KEY");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  const character = createTelegramCharacter({
    telegramBotToken,
    openaiApiKey,
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

if (import.meta.main) {
  main().catch(console.error);
}
