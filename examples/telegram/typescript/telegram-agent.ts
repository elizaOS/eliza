/**
 * Eliza Telegram Agent Example - TypeScript (Canonical Implementation)
 *
 * A complete Telegram bot powered by elizaOS with the FULL Eliza pipeline:
 * - Providers load context (CHARACTER, ENTITIES, RECENT_MESSAGES, ACTIONS, etc.)
 * - Actions are processed (REPLY, IGNORE, NONE, and any custom actions)
 * - Evaluators run post-response
 * - SQL plugin provides persistence
 * - OpenAI plugin provides language model capabilities
 *
 * The Telegram plugin handles:
 * - Bot lifecycle (start/stop)
 * - Message reception and response
 * - Proper ensureConnection for entity/room management
 * - Calling runtime.messageService.handleMessage for full pipeline
 *
 * Required environment variables:
 * - TELEGRAM_BOT_TOKEN: Your Telegram bot token from @BotFather
 * - OPENAI_API_KEY: Your OpenAI API key
 * - POSTGRES_URL (optional): PostgreSQL connection string (falls back to PGLite)
 */

import {
  AgentRuntime,
  type Character,
  logger,
} from "@elizaos/core";
import { openaiPlugin } from "@elizaos/plugin-openai";
import sqlPlugin from "@elizaos/plugin-sql";
import telegramPlugin from "@elizaos/plugin-telegram";

/**
 * Define the agent's character/personality.
 *
 * This is the canonical way to configure an Eliza agent:
 * - name, bio: Identity
 * - system: Core behavior prompt
 * - messageExamples: Few-shot examples for response style
 * - topics, adjectives: Help with context and personality
 * - settings: Runtime configuration
 * - secrets: API keys and tokens (loaded from env or character file)
 */
const character: Character = {
  name: "TelegramEliza",
  bio: [
    "A helpful and friendly AI assistant available on Telegram.",
    "I can answer questions, have conversations, and help with various tasks.",
    "I'm knowledgeable, concise, and always try to be genuinely helpful.",
  ],
  system: `You are TelegramEliza, a helpful AI assistant on Telegram.
You are friendly, knowledgeable, and concise in your responses.
When users greet you with /start, welcome them warmly and explain what you can do.
Keep responses appropriate for chat format - not too long, easy to read on mobile.
You can use emojis sparingly to make conversations more engaging.
When you don't know something, be honest about it.
Always aim to be genuinely helpful rather than just responding for the sake of it.`,

  // Few-shot examples help the model understand your agent's communication style
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
          text: "I can chat, answer questions, help brainstorm ideas, explain concepts, and much more! Just ask me anything. What's on your mind?",
        },
      },
    ],
    [
      { name: "user", content: { text: "Can you help me write an email?" } },
      {
        name: "TelegramEliza",
        content: {
          text: "Absolutely! Tell me who it's for and what you want to communicate. I'll help you draft something clear and effective.",
        },
      },
    ],
  ],

  // Topics the agent is knowledgeable about
  topics: [
    "general knowledge",
    "technology",
    "writing assistance",
    "brainstorming",
    "explanations",
    "coding help",
    "daily tasks",
  ],

  // Personality traits
  adjectives: [
    "helpful",
    "friendly",
    "knowledgeable",
    "concise",
    "patient",
    "clear",
  ],

  // Writing style guidance
  style: {
    all: [
      "Be concise but thorough",
      "Use simple language",
      "Be warm and approachable",
      "Give actionable advice when applicable",
    ],
    chat: [
      "Keep messages short - suitable for mobile reading",
      "Use paragraphs sparingly",
      "Emojis are okay but don't overuse them",
      "Feel free to ask clarifying questions",
    ],
  },

  // Settings control runtime behavior
  settings: {
    // Model settings
    model: "gpt-4o-mini", // Cost-effective for chat
    maxOutputTokens: 1000, // Keep responses concise

    // Response behavior
    SHOULD_RESPOND_MODEL: "small", // Fast response decisions
  },

  // Secrets are loaded from environment variables
  // The runtime automatically picks these up for plugin configuration
  secrets: {
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  },
};

async function main(): Promise<void> {
  // Validate required environment variables
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    console.error("❌ TELEGRAM_BOT_TOKEN environment variable is required");
    console.error("   Get your bot token from @BotFather on Telegram");
    process.exit(1);
  }

  if (!process.env.OPENAI_API_KEY) {
    console.error("❌ OPENAI_API_KEY environment variable is required");
    process.exit(1);
  }

  console.log("🚀 Starting TelegramEliza...\n");
  console.log("📦 Loading plugins:");
  console.log("   - @elizaos/plugin-sql (database persistence)");
  console.log("   - @elizaos/plugin-openai (language model)");
  console.log("   - @elizaos/plugin-telegram (bot integration)\n");

  /**
   * Create the agent runtime.
   *
   * This is the canonical way to create an Eliza agent:
   * 1. Pass the character configuration
   * 2. Include all required plugins
   *
   * The runtime automatically:
   * - Registers the bootstrap plugin (basic capabilities: providers, actions, services)
   * - Initializes the message service
   * - Starts all plugin services (including TelegramService)
   */
  const runtime = new AgentRuntime({
    character,
    plugins: [
      sqlPlugin,        // Database persistence (PostgreSQL or PGLite)
      openaiPlugin,     // Language model capabilities
      telegramPlugin,   // Telegram bot integration - handles full message pipeline
    ],
    // Enable extended capabilities for more features (optional)
    // enableExtendedCapabilities: true,
  });

  /**
   * Initialize the runtime.
   *
   * This:
   * 1. Registers the bootstrap plugin (providers, actions, evaluators, services)
   * 2. Registers all user-provided plugins
   * 3. Initializes the database adapter
   * 4. Starts all services (including TelegramService)
   *
   * After this, the Telegram bot is running and handling messages through
   * the full Eliza pipeline:
   * - runtime.ensureConnection() for entity/room management
   * - runtime.messageService.handleMessage() for full processing
   * - Providers supply context (CHARACTER, ENTITIES, RECENT_MESSAGES, ACTIONS)
   * - Actions are evaluated and executed (REPLY, IGNORE, NONE)
   * - Evaluators run post-response
   */
  await runtime.initialize();

  console.log(`\n✅ ${character.name} is now running on Telegram!`);
  console.log("   The full Eliza pipeline is active:");
  console.log("   📥 Messages → Providers → LLM → Actions → Evaluators → Response");
  console.log("\n   Send a message to your bot to start chatting.\n");
  console.log("Press Ctrl+C to stop.\n");

  // Handle graceful shutdown
  const shutdown = async () => {
    console.log("\n\n🛑 Shutting down gracefully...");
    await runtime.stop();
    console.log("👋 Goodbye!\n");
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Keep the process alive - the Telegram service runs in the background
  await new Promise(() => {});
}

main().catch((error) => {
  logger.error("Fatal error:", error);
  process.exit(1);
});
