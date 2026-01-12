/**
 * Eliza Telegram Agent Example - TypeScript
 *
 * A complete Telegram bot powered by elizaOS with SQL persistence.
 * Features:
 * - Full Telegram integration (private/group chats, reactions, inline buttons)
 * - PostgreSQL or PGLite database persistence
 * - OpenAI for language model capabilities
 *
 * Required environment variables:
 * - TELEGRAM_BOT_TOKEN: Your Telegram bot token from @BotFather
 * - OPENAI_API_KEY: Your OpenAI API key
 * - POSTGRES_URL (optional): PostgreSQL connection string (falls back to PGLite)
 */

import {
  AgentRuntime,
  type Character,
  EventType,
  logger,
} from "@elizaos/core";
import { openaiPlugin } from "@elizaos/plugin-openai";
import sqlPlugin from "@elizaos/plugin-sql";
import telegramPlugin from "@elizaos/plugin-telegram";

// Define the agent's character/personality
const character: Character = {
  name: "TelegramEliza",
  bio: "A helpful and friendly AI assistant available on Telegram. I can answer questions, have conversations, and help with various tasks.",
  system: `You are TelegramEliza, a helpful AI assistant on Telegram.
You are friendly, knowledgeable, and concise in your responses.
When users greet you with /start, welcome them warmly.
Keep responses appropriate for chat format - not too long, easy to read.
You can use emojis sparingly to make conversations more engaging.`,
  messageExamples: [
    [
      { name: "user", content: { text: "Hello!" } },
      {
        name: "TelegramEliza",
        content: { text: "Hey there! 👋 How can I help you today?" },
      },
    ],
    [
      { name: "user", content: { text: "What can you do?" } },
      {
        name: "TelegramEliza",
        content: {
          text: "I can chat, answer questions, help brainstorm ideas, explain concepts, and much more! Just ask me anything.",
        },
      },
    ],
  ],
  // Include secrets from environment variables
  secrets: {
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  },
};

async function main(): Promise<void> {
  // Validate required environment variables
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    console.error("❌ TELEGRAM_BOT_TOKEN environment variable is required");
    console.error("   Get your bot token from @BotFather on Telegram");
    process.exit(1);
  }

  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    console.error("❌ OPENAI_API_KEY environment variable is required");
    process.exit(1);
  }

  console.log("🚀 Starting TelegramEliza...\n");

  // Create the agent runtime with all plugins
  const runtime = new AgentRuntime({
    character,
    plugins: [
      sqlPlugin, // Database persistence (PostgreSQL or PGLite)
      openaiPlugin, // Language model capabilities
      telegramPlugin, // Telegram bot integration
    ],
  });

  // Register event handlers before initialization
  // Handle Telegram /start command
  runtime.registerEvent(
    "TELEGRAM_SLASH_START",
    async (payload: Record<string, unknown>) => {
      const ctx = payload.ctx as { reply?: (msg: string) => Promise<void> } | undefined;
      if (ctx?.reply) {
        await ctx.reply(
          `👋 Hello! I'm ${character.name}.\n\nI'm here to help you with questions, conversations, and more. Just send me a message!`
        );
      }
    }
  );

  // Log message events
  runtime.registerEvent(
    EventType.MESSAGE_RECEIVED,
    async (payload: Record<string, unknown>) => {
      const content = payload.content as { text?: string } | undefined;
      if (content?.text) {
        logger.info(`Message received from Telegram: ${content.text.slice(0, 50)}...`);
      }
    }
  );

  // Log when actions complete
  runtime.registerEvent(
    EventType.ACTION_COMPLETED,
    async (payload: Record<string, unknown>) => {
      const action = payload.action as string | undefined;
      logger.debug(`Action completed: ${action}`);
    }
  );

  // Initialize the runtime (starts all services including Telegram)
  await runtime.initialize();

  console.log(`\n✅ ${character.name} is now running on Telegram!`);
  console.log("   Send a message to your bot to start chatting.\n");
  console.log("Press Ctrl+C to stop.\n");

  // Handle graceful shutdown
  const shutdown = async () => {
    console.log("\n\n🛑 Shutting down...");
    await runtime.stop();
    console.log("👋 Goodbye!\n");
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Keep the process alive
  await new Promise(() => {});
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
