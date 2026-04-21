import "dotenv/config";

import { AgentRuntime, createCharacter } from "@elizaos/core";
import { type MoltbookService, moltbookPlugin } from "@elizaos/plugin-moltbook";
import { openaiPlugin } from "@elizaos/plugin-openai";
import sqlPlugin from "@elizaos/plugin-sql";
import { getDiscoveryConfig } from "./memecoin/config";
import { startDashboardServer } from "./memecoin/server";
import { setupElizaOkDiscovery } from "./memecoin/setup";

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
    "MOLTBOOK_BOOT_POST_ENABLED",
    "MOLTBOOK_BOOT_POST_TITLE",
    "MOLTBOOK_BOOT_POST_TEXT",
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

function envBool(name: string, defaultValue = false): boolean {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  return ["1", "true", "yes", "on"].includes(String(raw).trim().toLowerCase());
}

async function tryBootPost(runtime: AgentRuntime): Promise<void> {
  if (!envBool("MOLTBOOK_BOOT_POST_ENABLED", false)) {
    return;
  }

  const title =
    process.env.MOLTBOOK_BOOT_POST_TITLE?.trim() || "Joining the BNB Hackathon";
  const content =
    process.env.MOLTBOOK_BOOT_POST_TEXT?.trim() ||
    "elizaOKBSC is powered by elizaOS.\n\nwe’re joining the BNB Hackathon and building in public.";

  try {
    const service = (await runtime.getServiceLoadPromise(
      "moltbook" as never,
    )) as MoltbookService;

    const creds = await service.ensureAuthenticated();
    if (!creds) {
      console.warn("Boot post skipped: Moltbook credentials are unavailable.");
      return;
    }

    if (creds.claimStatus !== "claimed") {
      console.warn(
        `Boot post skipped: Moltbook account ${creds.username} is not claimed yet.`,
      );
      return;
    }

    const post = await service.createPost(title, content);
    if (!post) {
      console.warn(
        "Boot post attempt completed, but Moltbook did not return a post object.",
      );
      return;
    }

    console.log(`Boot post created on Moltbook: ${post.id}`);
  } catch (error) {
    console.error("Boot post failed:", error);
  }
}

async function main(): Promise<void> {
  const hasOpenAI = Boolean(process.env.OPENAI_API_KEY?.trim());
  const hasMoltbook = Boolean(process.env.MOLTBOOK_API_KEY?.trim());
  const discoveryConfig = getDiscoveryConfig();

  if (!hasOpenAI) {
    console.warn(
      "OPENAI_API_KEY is not set. elizaOKBSC can still initialize, but message generation will be limited.",
    );
  }

  if (!hasMoltbook) {
    console.warn(
      "MOLTBOOK_API_KEY is not set. Moltbook plugin will stay disabled so the dashboard can run without upstream Moltbook errors.",
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
      ...(hasMoltbook ? ["@elizaos/plugin-moltbook"] : []),
    ],
    settings: {
      ...(hasMoltbook
        ? {
            moltbook: {
              MOLTBOOK_AGENT_NAME:
                process.env.MOLTBOOK_AGENT_NAME || "elizaOK_BSC",
              MOLTBOOK_AUTO_REGISTER:
                process.env.MOLTBOOK_AUTO_REGISTER || "true",
              MOLTBOOK_AUTO_ENGAGE: process.env.MOLTBOOK_AUTO_ENGAGE || "false",
              MOLTBOOK_MIN_QUALITY_SCORE:
                process.env.MOLTBOOK_MIN_QUALITY_SCORE || "7",
              MOLTBOOK_AUTONOMOUS_MODE:
                process.env.MOLTBOOK_AUTONOMOUS_MODE || "false",
              MOLTBOOK_MODEL: process.env.MOLTBOOK_MODEL || "gpt-4o-mini",
              MOLTBOOK_PERSONALITY:
                process.env.MOLTBOOK_PERSONALITY ||
                "A community-native ElizaOS agent representing ElizaOK on BNB Chain.",
            },
          }
        : {}),
    },
    secrets: requiredSecrets(),
  });

  const runtime = new AgentRuntime({
    character,
    plugins: [
      sqlPlugin,
      ...(hasOpenAI ? [openaiPlugin] : []),
      ...(hasMoltbook ? [moltbookPlugin] : []),
    ],
    settings: {
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      PGLITE_DATA_DIR: pgliteDir,
      ...(hasMoltbook
        ? {
            MOLTBOOK_API_KEY: process.env.MOLTBOOK_API_KEY,
            MOLTBOOK_AUTO_REGISTER:
              process.env.MOLTBOOK_AUTO_REGISTER || "true",
            MOLTBOOK_AUTO_ENGAGE: process.env.MOLTBOOK_AUTO_ENGAGE || "false",
            MOLTBOOK_MIN_QUALITY_SCORE:
              process.env.MOLTBOOK_MIN_QUALITY_SCORE || "7",
            MOLTBOOK_AGENT_NAME:
              process.env.MOLTBOOK_AGENT_NAME || "elizaOK_BSC",
            MOLTBOOK_AUTONOMOUS_MODE:
              process.env.MOLTBOOK_AUTONOMOUS_MODE || "false",
            MOLTBOOK_AUTONOMY_INTERVAL_MS:
              process.env.MOLTBOOK_AUTONOMY_INTERVAL_MS,
            MOLTBOOK_AUTONOMY_MAX_STEPS:
              process.env.MOLTBOOK_AUTONOMY_MAX_STEPS,
            MOLTBOOK_MODEL: process.env.MOLTBOOK_MODEL,
            MOLTBOOK_PERSONALITY: process.env.MOLTBOOK_PERSONALITY,
          }
        : {}),
    },
  });

  let runtimeReady = false;
  try {
    await runtime.initialize();
    runtimeReady = true;
    console.log("elizaOK_BSC initialized.");
    console.log(
      "Loaded plugins:",
      runtime.plugins.map((plugin) => plugin.name).join(", "),
    );
    console.log("PGLite:", pgliteDir);
  } catch (initError) {
    console.error(
      "elizaOK_BSC runtime init failed (PGlite WASM). Dashboard will still start.",
      initError instanceof Error ? initError.message : initError,
    );
  }

  console.log(
    "Moltbook:",
    hasMoltbook
      ? `enabled as ${process.env.MOLTBOOK_AGENT_NAME || "elizaOK_BSC"}`
      : "disabled",
  );
  console.log(
    "ElizaOK discovery:",
    discoveryConfig.enabled
      ? `enabled every ${Math.round(discoveryConfig.intervalMs / 60_000)} minutes`
      : "disabled",
  );
  console.log(
    "ElizaOK Goo scan:",
    discoveryConfig.goo.enabled &&
      discoveryConfig.goo.rpcUrl &&
      discoveryConfig.goo.registryAddress
      ? `enabled with registry ${discoveryConfig.goo.registryAddress}`
      : "disabled",
  );
  console.log(
    "ElizaOK dashboard:",
    discoveryConfig.dashboard.enabled
      ? `http://localhost:${discoveryConfig.dashboard.port}`
      : "disabled",
  );

  const dashboardServer = startDashboardServer(runtime);

  await setupElizaOkDiscovery(runtime);

  if (hasMoltbook && runtimeReady) {
    await tryBootPost(runtime);
  }

  const stop = async () => {
    console.log("Stopping elizaOK_BSC...");
    dashboardServer?.close();
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
