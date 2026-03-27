import "dotenv/config";

import { AgentRuntime, createCharacter } from "@elizaos/core";
import { moltbookPlugin } from "@elizaos/plugin-moltbook";
import { openaiPlugin } from "@elizaos/plugin-openai";
import sqlPlugin from "@elizaos/plugin-sql";

function requiredSecrets(): Record<string, string> {
  const keys = [
    "OPENAI_API_KEY",
    "MOLTBOOK_API_KEY",
    "MOLTBOOK_AUTO_REGISTER",
    "MOLTBOOK_AUTO_ENGAGE",
    "MOLTBOOK_MIN_QUALITY_SCORE",
    "MOLTBOOK_AGENT_NAME",
    "MOLTBOOK_AUTONOMOUS_MODE",
    "MOLTBOOK_AUTONOMY_INTERVAL_MS",
    "MOLTBOOK_AUTONOMY_MAX_STEPS",
    "MOLTBOOK_MODEL",
    "MOLTBOOK_PERSONALITY",
    "PGLITE_DATA_DIR",
  ];

  const secrets: Record<string, string> = {};
  for (const key of keys) {
    const value = process.env[key];
    if (typeof value === "string" && value.trim()) {
      secrets[key] = value.trim();
    }
  }
  return secrets;
}

async function main(): Promise<void> {
  const hasOpenAI = Boolean(process.env.OPENAI_API_KEY?.trim());

  if (!hasOpenAI) {
    console.warn(
      "OPENAI_API_KEY is not set. elizaOKBSC can still initialize, but message generation will be limited."
    );
  }

  const pgliteDir = process.env.PGLITE_DATA_DIR || ".elizadb/elizaokbsc";

  const character = createCharacter({
    name: "elizaOK_BSC",
    bio: [
      "An ElizaOS-native social agent for the ElizaOK BSC project.",
      "Operates on Moltbook as the public voice and community-facing presence of elizaOK_BSC.",
    ],
    topics: [
      "moltbook",
      "elizaos",
      "bnb chain",
      "agent communities",
      "memecoin discovery",
      "treasury agents",
    ],
    adjectives: ["social", "curious", "agentic", "community-native"],
    style: {
      all: [
        "Be concise and community-aware",
        "Prefer thoughtful participation over spam",
      ],
      chat: ["Be direct", "Be helpful"],
      post: ["Be authentic", "Add value to the conversation"],
    },
    plugins: [
      "@elizaos/plugin-sql",
      ...(hasOpenAI ? ["@elizaos/plugin-openai"] : []),
      "@elizaos/plugin-moltbook",
    ],
    settings: {
      moltbook: {
        MOLTBOOK_AGENT_NAME: process.env.MOLTBOOK_AGENT_NAME || "elizaOK_BSC",
        MOLTBOOK_AUTO_REGISTER: process.env.MOLTBOOK_AUTO_REGISTER || "true",
        MOLTBOOK_AUTO_ENGAGE: process.env.MOLTBOOK_AUTO_ENGAGE || "false",
        MOLTBOOK_MIN_QUALITY_SCORE: process.env.MOLTBOOK_MIN_QUALITY_SCORE || "7",
        MOLTBOOK_AUTONOMOUS_MODE: process.env.MOLTBOOK_AUTONOMOUS_MODE || "false",
        MOLTBOOK_MODEL: process.env.MOLTBOOK_MODEL || "gpt-4o-mini",
        MOLTBOOK_PERSONALITY:
          process.env.MOLTBOOK_PERSONALITY ||
          "A community-native ElizaOS agent representing ElizaOK on BNB Chain.",
      },
    },
    secrets: requiredSecrets(),
  });

  const runtime = new AgentRuntime({
    character,
    plugins: [sqlPlugin, ...(hasOpenAI ? [openaiPlugin] : []), moltbookPlugin],
    settings: {
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      PGLITE_DATA_DIR: pgliteDir,
      MOLTBOOK_API_KEY: process.env.MOLTBOOK_API_KEY,
      MOLTBOOK_AUTO_REGISTER: process.env.MOLTBOOK_AUTO_REGISTER || "true",
      MOLTBOOK_AUTO_ENGAGE: process.env.MOLTBOOK_AUTO_ENGAGE || "false",
      MOLTBOOK_MIN_QUALITY_SCORE: process.env.MOLTBOOK_MIN_QUALITY_SCORE || "7",
      MOLTBOOK_AGENT_NAME: process.env.MOLTBOOK_AGENT_NAME || "elizaOK_BSC",
      MOLTBOOK_AUTONOMOUS_MODE: process.env.MOLTBOOK_AUTONOMOUS_MODE || "false",
      MOLTBOOK_AUTONOMY_INTERVAL_MS: process.env.MOLTBOOK_AUTONOMY_INTERVAL_MS,
      MOLTBOOK_AUTONOMY_MAX_STEPS: process.env.MOLTBOOK_AUTONOMY_MAX_STEPS,
      MOLTBOOK_MODEL: process.env.MOLTBOOK_MODEL,
      MOLTBOOK_PERSONALITY: process.env.MOLTBOOK_PERSONALITY,
    },
  });

  await runtime.initialize();

  console.log("elizaOK_BSC initialized.");
  console.log("Loaded plugins:", runtime.plugins.map((plugin) => plugin.name).join(", "));
  console.log("PGLite:", pgliteDir);
  console.log("Moltbook agent name:", process.env.MOLTBOOK_AGENT_NAME || "elizaOK_BSC");

  const stop = async () => {
    console.log("Stopping elizaOK_BSC...");
    await runtime.stop();
    process.exit(0);
  };

  process.once("SIGINT", () => {
    void stop();
  });

  process.once("SIGTERM", () => {
    void stop();
  });

  setInterval(() => {}, 60_000);
}

main().catch((error) => {
  console.error("Failed to start elizaOK_BSC:", error);
  process.exit(1);
});
