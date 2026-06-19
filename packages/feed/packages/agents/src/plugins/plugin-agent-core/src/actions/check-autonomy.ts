/**
 * Check Autonomy Action
 *
 * Returns the current status of all autonomous features for the agent.
 */

import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import {
  getAgentConfig,
  isAutonomousTradingEnabled,
} from "../../../../shared/agent-config";
import { logger } from "../../../../shared/logger";
import type { AutonomyStatus } from "../types";

/**
 * CHECK_AUTONOMY Action
 *
 * Returns the current status of all autonomous features.
 */
export const checkAutonomyAction: Action = {
  name: "CHECK_AUTONOMY",
  description:
    "Check which of YOUR autonomous features are enabled (trading, posting, commenting, DMs, group chats). When enabled, you act independently without explicit commands from your owner.",

  parameters: [] as Action["parameters"],

  examples: [
    [
      {
        name: "User",
        content: {
          text: "What are my current autonomous settings?",
        },
      },
      {
        name: "Agent",
        content: {
          text: "Let me check your current autonomous feature settings.",
          actions: ["CHECK_AUTONOMY"],
        },
      },
    ],
    [
      {
        name: "User",
        content: {
          text: "Which auto features are enabled?",
        },
      },
      {
        name: "Agent",
        content: {
          text: "Checking your autonomous feature status...",
          actions: ["CHECK_AUTONOMY"],
        },
      },
    ],
    [
      {
        name: "User",
        content: {
          text: "Show me my autonomy settings",
        },
      },
      {
        name: "Agent",
        content: {
          text: "Let me look up your current settings.",
          actions: ["CHECK_AUTONOMY"],
        },
      },
    ],
  ],

  validate: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
  ): Promise<boolean> => {
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    _options?: Record<string, unknown>,
    _callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const agentId = runtime.agentId;

    try {
      // Get agent config directly from userAgentConfigs table
      const config = await getAgentConfig(agentId);

      // Extract autonomy status from config
      // Note: autonomousTrading defaults to true per database schema
      const status: AutonomyStatus = {
        autonomousTrading: isAutonomousTradingEnabled(config),
        autonomousPosting: config?.autonomousPosting ?? false,
        autonomousCommenting: config?.autonomousCommenting ?? false,
        autonomousDMs: config?.autonomousDMs ?? false,
        autonomousGroupChats: config?.autonomousGroupChats ?? false,
      };

      const enabledCount = Object.values(status).filter(Boolean).length;
      const totalCount = Object.keys(status).length;

      logger.info(
        `[CHECK_AUTONOMY] Status retrieved for agent: ${agentId}`,
        undefined,
        "CheckAutonomy",
      );

      return {
        success: true,
        text: `Autonomy: ${enabledCount}/${totalCount} features enabled.`,
        data: { status, enabledCount, totalCount },
        values: {
          trading: status.autonomousTrading,
          posting: status.autonomousPosting,
          commenting: status.autonomousCommenting,
          dms: status.autonomousDMs,
          groupChats: status.autonomousGroupChats,
        },
      };
    } catch (error) {
      const errorMsg =
        error instanceof Error ? error.message : "Unknown error occurred";
      logger.error("[CHECK_AUTONOMY] Error:", errorMsg);

      return {
        success: false,
        text: `Failed to check autonomy status: ${errorMsg}`,
        error: errorMsg,
      };
    }
  },
};
