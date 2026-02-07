import { type IAgentRuntime, logger, type Plugin } from "@elizaos/core";
import moltbookBrowseAction from "./actions/moltbookBrowse";
import moltbookCommentAction from "./actions/moltbookComment";
// Actions
import moltbookPostAction from "./actions/moltbookPost";
import moltbookReadAction from "./actions/moltbookRead";
import moltbookSubmoltsAction from "./actions/moltbookSubmolts";
// Constants and types
import { URLS } from "./constants";

// Providers
import { moltbookStateProvider } from "./providers/moltbookState";
// Service
import { MoltbookService } from "./service";

/**
 * Moltbook Plugin
 *
 * Enables Eliza agents to engage on Moltbook - a Reddit-style social platform for AI agents.
 * Features:
 * - Create and browse posts
 * - Comment and reply to discussions
 * - Autonomous social engagement mode
 */
const moltbookPlugin: Plugin = {
  name: "moltbook",
  description:
    "Moltbook social plugin for Eliza agents. Enables posting, browsing, and commenting on Moltbook - Reddit for AI agents.",

  services: [MoltbookService],

  actions: [
    moltbookPostAction,
    moltbookBrowseAction,
    moltbookCommentAction,
    moltbookReadAction,
    moltbookSubmoltsAction,
  ],

  providers: [moltbookStateProvider],

  init: async (_config: Record<string, string>, runtime: IAgentRuntime) => {
    const moltbookToken = runtime.getSetting("MOLTBOOK_TOKEN") as string;
    const agentName = runtime.getSetting("MOLTBOOK_AGENT_NAME") as string;
    const autonomousMode = runtime.getSetting(
      "MOLTBOOK_AUTONOMOUS_MODE",
    ) as string;

    // Log plugin initialization
    logger.info("=".repeat(50));
    logger.info("Moltbook Plugin - Social Platform for AI Agents");
    logger.info("=".repeat(50));
    logger.info("");
    logger.info("Settings:");
    logger.info(`  MOLTBOOK_TOKEN: ${moltbookToken ? "[set]" : "[not set]"}`);
    logger.info(
      `  MOLTBOOK_AGENT_NAME: ${agentName || runtime.character?.name || "Agent"}`,
    );
    logger.info(`  MOLTBOOK_AUTONOMOUS_MODE: ${autonomousMode || "false"}`);
    logger.info("");
    logger.info("Endpoints:");
    logger.info(`  Moltbook: ${URLS.moltbook.replace("/api/v1", "")}`);
    logger.info("=".repeat(50));

    if (!moltbookToken) {
      logger.warn(
        "MOLTBOOK_TOKEN not provided - posting and commenting will be disabled",
      );
      logger.warn(
        "To enable full functionality, provide MOLTBOOK_TOKEN in your .env file",
      );
    }
  },
};

export default moltbookPlugin;

// Export constants
export {
  CONTENT_LIMITS,
  DEFAULT_SUBMOLT,
  MOLTBOOK_SERVICE_NAME,
  URLS,
} from "./constants";
// Export service and constants
export { MoltbookService } from "./service";
// Export types
export type {
  IMoltbookService,
  MoltbookAutonomyStepPayload,
  MoltbookComment,
  MoltbookCommentPayload,
  MoltbookEventType,
  MoltbookPost,
  MoltbookPostPayload,
  MoltbookResult,
  MoltbookSettings,
  MoltbookSubmolt,
} from "./types";
// Export event types and helper functions
export {
  MoltbookEventTypes,
  moltbookFailure,
  moltbookSuccess,
} from "./types";
