// File: /swarm/shared/settings/provider.ts
// Updated to use world metadata instead of cache

import { logger } from "../logger";
import { findWorldForOwner } from "../roles";
import { getWorldSettings } from "../settings";
import {
    ChannelType,
    IAgentRuntime,
    Memory,
    Provider,
    State,
    type OnboardingSetting,
    type WorldSettings
} from "../types";

/**
 * Formats a setting value for display, respecting privacy flags
 */
const formatSettingValue = (
  setting: OnboardingSetting,
  isOnboarding: boolean
): string => {
  if (setting.value === null) return "Not set";
  if (setting.secret && !isOnboarding) return "****************";
  return String(setting.value);
};

/**
 * Generates a status message based on the current settings state
 */
function generateStatusMessage(
  runtime: IAgentRuntime,
  worldSettings: WorldSettings,
  isOnboarding: boolean,
  state?: State
): string {
  try {
    // Format settings for display
    const formattedSettings = Object.entries(worldSettings)
      .map(([key, setting]) => {
        if (typeof setting !== "object" || !setting.name) return null;

        const description = setting.description || "";
        const usageDescription = setting.usageDescription || "";

        // Skip settings that should be hidden based on visibility function
        if (setting.visibleIf && !setting.visibleIf(worldSettings)) {
          return null;
        }

        return {
          name: setting.name,
          value: formatSettingValue(setting, isOnboarding),
          description,
          usageDescription,
          required: setting.required,
          configured: setting.value !== null,
        };
      })
      .filter(Boolean);

    // Count required settings that are not configured
    const requiredUnconfigured = formattedSettings.filter(
      (s) => s.required && !s.configured
    ).length;

    // Generate appropriate message
    if (isOnboarding) {
      if (requiredUnconfigured > 0) {
        return (
          `# PRIORITY TASK: Onboarding with ${state.senderName}\n${state.agentName} still needs to configure ${requiredUnconfigured} required settings:\n\n` +
          formattedSettings
            .filter((s) => s.required && !s.configured)
            .map((s) => `${s.name}: ${s.usageDescription}\nValue: ${s.value}`)
            .join("\n\n") +
          "\n\n" +
          `If the user gives any information related to the settings, ${state.agentName} should use the UPDATE_SETTINGS action to update the settings with this new information. ${state.agentName} can update any, some or all settings.`
        );
      } else {
        return (
          "All required settings have been configured! Here's the current configuration:\n\n" +
          formattedSettings.map((s) => `${s.name}: ${s.description}\nValue: ${s.value}`).join("\n")
        );
      }
    } else {
      // Non-onboarding context - list all public settings with values and descriptions
      return (
        "## Current Configuration\n\n" +
        (requiredUnconfigured > 0
          ? `**Note:** ${requiredUnconfigured} required settings still need configuration.\n\n`
          : "All required settings are configured.\n\n") +
        formattedSettings
          .map((s) => `### ${s.name}\n**Value:** ${s.value}\n**Description:** ${s.description}`)
          .join("\n\n")
      );
    }
  } catch (error) {
    logger.error(`Error generating status message: ${error}`);
    return "Error generating configuration status.";
  }
}

/**
 * Creates an settings provider with the given configuration
 * Updated to use world metadata instead of cache
 */
export const settingsProvider: Provider = {
  get: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State
  ): Promise<string> => {
    try {
      const room = await runtime.getRoom(message.roomId);
      if (!room) {
        logger.error("No room found for settings provider");
        return "Error: Room not found";
      }

      const type = room.type;
      const isOnboarding = type === ChannelType.DM;

      // Find server for the current user
      let world = await findWorldForOwner(runtime, message.userId);
      let serverId;

      if(isOnboarding) {
        if(!world) {
            throw new Error("No server ownership found for onboarding");
        }
        serverId = world.serverId;
      } else {
        world = await runtime.getWorld(room.worldId);
        serverId = world.serverId;
      }

      // If still no server found after recovery attempts
      if (!serverId) {
        logger.info(
          `No server ownership found for user ${message.userId} after recovery attempt`
        );
        return isOnboarding
          ? "The user doesn't appear to have ownership of any servers. They should make sure they're using the correct account."
          : "Error: No configuration access";
      }


      // Get current settings state from world metadata
      const worldSettings = await getWorldSettings(runtime, serverId);

      if (!worldSettings) {
        logger.info(`No settings state found for server ${serverId}`);
        return isOnboarding
          ? "The user doesn't appear to have any settings configured for this server. They should configure some settings for this server."
          : "Configuration has not been completed yet.";
      }

      const output = generateStatusMessage(
        runtime,
        worldSettings,
        isOnboarding,
        state
      );

      return output;
    } catch (error) {
      logger.error(`Critical error in settings provider: ${error}`);
      return "Error retrieving configuration information. Please try again later.";
    }
  },
};
