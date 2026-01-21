// File: /swarm/shared/settings/provider.ts
// Updated to use world metadata instead of cache

import { logger } from "../../logger.ts";
import { findWorldsForOwner } from "../../roles.ts";
import { getSalt, unsaltWorldSettings } from "../../settings.ts";
import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  Setting,
  State,
  World,
  WorldSettings,
} from "../../types/index.ts";
import { ChannelType } from "../../types/index.ts";

/**
 * Formats a setting value for display, respecting privacy flags
 */
const formatSettingValue = (
  setting: Setting,
  isOnboarding: boolean,
): string => {
  if (setting.value === null) {
    return "Not set";
  }
  if (setting.secret && !isOnboarding) {
    return "****************";
  }
  return String(setting.value);
};

/**
 * Generates a status message based on the current settings state
 */
function generateStatusMessage(
  runtime: IAgentRuntime,
  worldSettings: WorldSettings,
  isOnboarding: boolean,
  state?: State,
): string {
  // Format settings for display
  const formattedSettings = Object.entries(worldSettings)
    .map(([key, setting]) => {
      // Type guard: ensure setting is a Setting object with required properties
      if (
        typeof setting !== "object" ||
        setting === null ||
        !("name" in setting) ||
        !("description" in setting) ||
        !("dependsOn" in setting)
      ) {
        return null;
      }

      const typedSetting = setting as Setting;
      const description = typedSetting.description || "";
      const usageDescription = typedSetting.usageDescription || "";

      // Skip settings that should be hidden based on visibility function
      if (
        typedSetting.visibleIf &&
        !typedSetting.visibleIf(worldSettings.settings ?? {})
      ) {
        return null;
      }

      return {
        key,
        name: typedSetting.name,
        value: formatSettingValue(typedSetting, isOnboarding),
        description,
        usageDescription,
        required: typedSetting.required,
        configured: typedSetting.value !== null,
      };
    })
    .filter(Boolean);

  // Count required settings that are not configured
  const requiredUnconfigured = formattedSettings.filter(
    (s) => s?.required && !s.configured,
  ).length;

  // Generate appropriate message
  if (isOnboarding) {
    const settingsList = formattedSettings
      .map((s) => {
        if (!s) return "";
        const label = s.required ? "(Required)" : "(Optional)";
        return `${s.key}: ${s.value} ${label}\n(${s.name}) ${s.usageDescription}`;
      })
      .filter(Boolean)
      .join("\n\n");

    const validKeys = `Valid setting keys: ${Object.keys(worldSettings).join(", ")}`;

    const commonInstructions = `Instructions for ${runtime.character.name}:
      - Only update settings if the user is clearly responding to a setting you are currently asking about.
      - If the user's reply clearly maps to a setting and a valid value, you **must** call the UPDATE_SETTINGS action with the correct key and value. Do not just respond with a message saying it's updated — it must be an action.
      - Never hallucinate settings or respond with values not listed above.
      - Do not call UPDATE_SETTINGS just because the user has started onboarding or you think a setting needs to be configured. Only update when the user clearly provides a specific value for a setting you are currently asking about.
      - Answer setting-related questions using only the name, description, and value from the list.`;

    if (requiredUnconfigured > 0) {
      const senderName = state?.senderName ? state.senderName : "user";
      return `# PRIORITY TASK: Onboarding with ${senderName}

        ${runtime.character.name} needs to help the user configure ${requiredUnconfigured} required settings:
        
        ${settingsList}
        
        ${validKeys}
        
        ${commonInstructions}
        
        - Prioritize configuring required settings before optional ones.`;
    }

    return `All required settings have been configured. Here's the current configuration:
      
        ${settingsList}
        
        ${validKeys}
        
        ${commonInstructions}`;
  }

  // Non-onboarding context - list all public settings with values and descriptions
  return `## Current Configuration\n\n${
    requiredUnconfigured > 0
      ? `IMPORTANT!: ${requiredUnconfigured} required settings still need configuration. ${runtime.character.name} should get onboarded with the OWNER as soon as possible.\n\n`
      : "All required settings are configured.\n\n"
  }${formattedSettings
    .map((s) => {
      if (!s) return "";
      return `### ${s.name}\n**Value:** ${s.value}\n**Description:** ${s.description}`;
    })
    .filter(Boolean)
    .join("\n\n")}`;
}

/**
 * Creates an settings provider with the given configuration
 * Updated to use world metadata instead of cache
 */
export const settingsProvider: Provider = {
  name: "SETTINGS",
  description: "Current settings for the server",
  get: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
  ): Promise<ProviderResult> => {
    // Parallelize the initial database operations to improve performance
    // These operations can run simultaneously as they don't depend on each other
    const [room, userWorlds] = await Promise.all([
      runtime.getRoom(message.roomId),
      findWorldsForOwner(runtime, message.entityId),
    ]);

    if (!room) {
      logger.error(
        {
          src: "plugin:bootstrap:provider:settings",
          agentId: runtime.agentId,
        },
        "No room found for settings provider",
      );
      return {
        data: {
          settings: [],
        },
        values: {
          settings: "Error: Room not found",
        },
        text: "Error: Room not found",
      };
    }

    if (!room.worldId) {
      logger.debug(
        {
          src: "plugin:bootstrap:provider:settings",
          agentId: runtime.agentId,
        },
        "No world found for settings provider -- settings provider will be skipped",
      );
      return {
        data: {
          settings: [],
        },
        values: {
          settings:
            "Room does not have a worldId -- settings provider will be skipped",
        },
        text: "Room does not have a worldId -- settings provider will be skipped",
      };
    }

    const type = room.type;
    const isOnboarding = type === ChannelType.DM;

    let world: World | null | undefined = null;
    let serverId: string | undefined;
    let worldSettings: WorldSettings | null = null;

    if (isOnboarding) {
      // In onboarding mode, use the user's world directly
      // Look for worlds with settings metadata, or create one if none exists
      world =
        userWorlds?.find(
          (world) => world.metadata && world.metadata.settings !== undefined,
        ) || null;

      if (!world && userWorlds && userWorlds.length > 0) {
        // If user has worlds but none have settings, use the first one and initialize settings
        world = userWorlds[0];
        if (!world.metadata) {
          world.metadata = {};
        }
        world.metadata.settings = {};
        await runtime.updateWorld(world);
        logger.info(
          {
            src: "plugin:bootstrap:provider:settings",
            agentId: runtime.agentId,
            worldId: world.id,
          },
          "Initialized settings for user world",
        );
      }

      if (!world) {
        logger.error(
          {
            src: "plugin:bootstrap:provider:settings",
            agentId: runtime.agentId,
          },
          "No world found for user during onboarding",
        );
        throw new Error("No server ownership found for onboarding");
      }

      serverId = world.messageServerId;

      // Get world settings directly from the world object we already have
      // Must decrypt secret values using unsaltWorldSettings (settings are stored encrypted)
      if (world.metadata?.settings) {
        const salt = getSalt();
        worldSettings = unsaltWorldSettings(
          world.metadata.settings as WorldSettings,
          salt,
        );
      }
    } else {
      // For non-onboarding, we need to get the world associated with the room
      world = await runtime.getWorld(room.worldId);

      if (!world) {
        logger.error(
          {
            src: "plugin:bootstrap:provider:settings",
            agentId: runtime.agentId,
            worldId: room.worldId,
          },
          "No world found for room",
        );
        throw new Error(`No world found for room ${room.worldId}`);
      }

      serverId = world.messageServerId;

      // Get world settings directly from the world object we already have
      // Must decrypt secret values using unsaltWorldSettings (settings are stored encrypted)
      if (world.metadata?.settings) {
        const salt = getSalt();
        worldSettings = unsaltWorldSettings(
          world.metadata.settings as WorldSettings,
          salt,
        );
      } else if (!serverId) {
        logger.debug(
          {
            src: "plugin:bootstrap:provider:settings",
            agentId: runtime.agentId,
            worldId: room.worldId,
          },
          "No server ID or settings found for world",
        );
      }
    }

    // If no server found after recovery attempts
    if (!serverId) {
      logger.info(
        {
          src: "plugin:bootstrap:provider:settings",
          agentId: runtime.agentId,
          entityId: message.entityId,
        },
        "No server ownership found for user after recovery attempt",
      );
      return isOnboarding
        ? {
            data: {
              settings: [],
            },
            values: {
              settings:
                "The user doesn't appear to have ownership of any servers. They should make sure they're using the correct account.",
            },
            text: "The user doesn't appear to have ownership of any servers. They should make sure they're using the correct account.",
          }
        : {
            data: {
              settings: [],
            },
            values: {
              settings: "Error: No configuration access",
            },
            text: "Error: No configuration access",
          };
    }

    if (!worldSettings) {
      logger.info(
        {
          src: "plugin:bootstrap:provider:settings",
          agentId: runtime.agentId,
          messageServerId: serverId,
        },
        "No settings state found for server",
      );
      return isOnboarding
        ? {
            data: {
              settings: [],
            },
            values: {
              settings:
                "The user doesn't appear to have any settings configured for this server. They should configure some settings for this server.",
            },
            text: "The user doesn't appear to have any settings configured for this server. They should configure some settings for this server.",
          }
        : {
            data: {
              settings: [],
            },
            values: {
              settings: "Configuration has not been completed yet.",
            },
            text: "Configuration has not been completed yet.",
          };
    }

    // Generate the status message based on the settings
    const output = generateStatusMessage(
      runtime,
      worldSettings,
      isOnboarding,
      state,
    );

    return {
      data: {
        settings: worldSettings,
      },
      values: {
        settings: output,
      },
      text: output,
    };
  },
};
