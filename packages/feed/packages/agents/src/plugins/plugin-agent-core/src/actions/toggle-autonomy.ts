/**
 * Toggle Autonomy Action
 *
 * Allows the agent to enable/disable autonomous features via chat.
 * Uses agentService.updateAgent() for proper logging and cache management.
 */

import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { agentLogs, db, eq, userAgentConfigs, users } from "@feed/db";
import { logger } from "../../../../shared/logger";
import { generateSnowflakeId } from "../../../../shared/snowflake";
import type {
  AutonomyFeature,
  AutonomyStatus,
  ToggleAutonomyParams,
} from "../types";

/**
 * Map feature name to config field
 */
const featureToConfigField: Record<
  Exclude<AutonomyFeature, "all">,
  keyof AutonomyStatus
> = {
  trading: "autonomousTrading",
  posting: "autonomousPosting",
  commenting: "autonomousCommenting",
  dms: "autonomousDMs",
  groupChats: "autonomousGroupChats",
};

/**
 * TOGGLE_AUTONOMY Action
 *
 * Enables or disables autonomous features for the agent.
 * Can toggle individual features or all at once.
 */
export const toggleAutonomyAction: Action = {
  name: "TOGGLE_AUTONOMY",
  description:
    "Enable or disable YOUR autonomous behaviors (trading, posting, commenting, DMs, group chats). When enabled, you act independently - trading on your own analysis, creating posts, responding to comments, and engaging in conversations without needing explicit commands.",

  parameters: {
    feature: {
      type: "string",
      description:
        'Feature to toggle: "trading", "posting", "commenting", "dms", "groupChats", or "all"',
      required: true,
    },
    enabled: {
      type: "boolean",
      description: "Whether to enable (true) or disable (false) the feature",
      required: true,
    },
  } as unknown as Action["parameters"],

  examples: [
    [
      {
        name: "User",
        content: {
          text: "Enable autonomous trading",
        },
      },
      {
        name: "Agent",
        content: {
          text: "I have enabled autonomous trading. I will now automatically make trades based on market conditions.",
          action: "TOGGLE_AUTONOMY",
        },
      },
    ],
    [
      {
        name: "User",
        content: {
          text: "Turn off all your autonomous features",
        },
      },
      {
        name: "Agent",
        content: {
          text: "All autonomous features have been disabled. I will only respond when you message me directly.",
          action: "TOGGLE_AUTONOMY",
        },
      },
    ],
    [
      {
        name: "User",
        content: {
          text: "Stop posting automatically",
        },
      },
      {
        name: "Agent",
        content: {
          text: "I have disabled autonomous posting. I will no longer create posts on my own.",
          action: "TOGGLE_AUTONOMY",
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
    _runtime: IAgentRuntime,
    _message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    _callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const agentUserId = _runtime.agentId;

    // Get parameters from state (set by multi-step decision)
    const actionParams = state?.data?.actionParams as
      | ToggleAutonomyParams
      | undefined;

    if (!actionParams) {
      logger.warn(
        "[TOGGLE_AUTONOMY] No action parameters found in state",
        undefined,
        "ToggleAutonomy",
      );
      return {
        success: false,
        text: "Missing parameters: feature and enabled required.",
        error: "Missing parameters",
      };
    }

    const { feature, enabled } = actionParams;

    // Validate feature
    const validFeatures: AutonomyFeature[] = [
      "trading",
      "posting",
      "commenting",
      "dms",
      "groupChats",
      "all",
    ];

    if (!validFeatures.includes(feature)) {
      return {
        success: false,
        text: `Invalid feature "${feature}". Valid: ${validFeatures.join(", ")}`,
        error: "Invalid feature",
      };
    }

    try {
      const [agent] = await db
        .select({ id: users.id, isAgent: users.isAgent })
        .from(users)
        .where(eq(users.id, agentUserId))
        .limit(1);

      if (!agent?.isAgent) {
        return {
          success: false,
          text: "Agent not found.",
          error: "Agent not found",
        };
      }

      // Build update object
      const updates: Partial<AutonomyStatus> = {};

      if (feature === "all") {
        updates.autonomousTrading = enabled;
        updates.autonomousPosting = enabled;
        updates.autonomousCommenting = enabled;
        updates.autonomousDMs = enabled;
        updates.autonomousGroupChats = enabled;
      } else {
        const configField = featureToConfigField[feature];
        updates[configField] = enabled;
      }

      const now = new Date();

      // Atomic upsert config row with autonomy fields
      await db
        .insert(userAgentConfigs)
        .values({
          id: await generateSnowflakeId(),
          userId: agentUserId,
          ...updates,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: userAgentConfigs.userId,
          set: { ...updates, updatedAt: now },
        });

      // Log the change for observability
      await db.insert(agentLogs).values({
        id: await generateSnowflakeId(),
        agentUserId,
        type: "system",
        level: "info",
        message: "Autonomy configuration updated",
        metadata: { feature, enabled },
      });

      const featureDisplay =
        feature === "all" ? "all autonomous features" : `autonomous ${feature}`;
      const statusDisplay = enabled ? "enabled" : "disabled";

      logger.info(
        `[TOGGLE_AUTONOMY] ${featureDisplay} ${statusDisplay} for agent ${agentUserId}`,
        undefined,
        "ToggleAutonomy",
      );

      return {
        success: true,
        text: `${featureDisplay} ${statusDisplay}.`,
        data: { feature, enabled, updatedFields: Object.keys(updates) },
        values: { feature, enabled },
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      logger.error(
        `[TOGGLE_AUTONOMY] Error: ${errorMessage}`,
        undefined,
        "ToggleAutonomy",
      );

      return {
        success: false,
        text: `Failed to update autonomy settings: ${errorMessage}`,
        error: errorMessage,
      };
    }
  },
};
