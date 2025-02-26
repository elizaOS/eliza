import { composeContext } from "../context";
import { generateMessageResponse, generateObjectArray } from "../generation";
import { logger } from "../logger";
import { messageCompletionFooter } from "../parsing";
import { findWorldForOwner, normalizeUserId } from "../roles";
import {
    Action,
    ActionExample,
    ChannelType,
    HandlerCallback,
    IAgentRuntime,
    Memory,
    ModelClass,
    OnboardingSetting,
    WorldSettings,
    State,
} from "../types";
import { stringToUuid } from "../uuid";

interface SettingUpdate {
  key: string;
  value: string | boolean;
}
// Enhanced extraction template that explicitly handles multiple settings
const extractionTemplate = `# Task: Extract setting values from the conversation

# Available Settings:
{{#each settings}}
{{key}}:
  Name: {{name}}
  Description: {{description}}
  Current Value: {{value}}
  Required: {{required}}
  Validation Rules: {{#if validation}}Present{{else}}None{{/if}}
{{/each}}

# Current Settings Status:
{{settingsStatus}}

# Recent Conversation:
{{recentMessages}}

# Instructions:
1. Review the ENTIRE conversation and identify ALL values provided for settings
2. For each setting mentioned, extract:
   - The setting key (must exactly match one of the available settings above)
   - The provided value that matches the setting's description and purpose
3. Return an array of ALL setting updates found, even if mentioned earlier in the conversation

Return ONLY a JSON array of objects with 'key' and 'value' properties. Format:
[
  { "key": "SETTING_NAME", "value": "extracted value" },
  { "key": "ANOTHER_SETTING", "value": "another value" }
]

IMPORTANT: Only include settings from the Available Settings list above. Ignore any other potential settings.`;

/**
 * Gets settings state from world metadata
 */
export async function getWorldSettings(
  runtime: IAgentRuntime,
  serverId: string
): Promise<WorldSettings | null> {
  try {
    const worldId = stringToUuid(`${serverId}-${runtime.agentId}`);
    const world = await runtime.getWorld(worldId);

    if (!world || !world.metadata?.settings) {
      return null;
    }

    return world.metadata.settings as WorldSettings;
  } catch (error) {
    logger.error(`Error getting settings state: ${error}`);
    return null;
  }
}

/**
 * Updates settings state in world metadata
 */
export async function updateWorldSettings(
  runtime: IAgentRuntime,
  serverId: string,
  worldSettings: WorldSettings
): Promise<boolean> {
  try {
    const worldId = stringToUuid(`${serverId}-${runtime.agentId}`);
    const world = await runtime.getWorld(worldId);

    if (!world) {
      logger.error(`No world found for server ${serverId}`);
      return false;
    }

    // Initialize metadata if it doesn't exist
    if (!world.metadata) {
      world.metadata = {};
    }

    // Update settings state
    world.metadata.settings = worldSettings;

    // Save updated world
    await runtime.updateWorld(world);

    return true;
  } catch (error) {
    logger.error(`Error updating settings state: ${error}`);
    return false;
  }
}

/**
 * Formats a list of settings for display
 */
function formatSettingsList(worldSettings: WorldSettings): string {
  const settings = Object.entries(worldSettings)
    .filter(([key]) => !key.startsWith("_")) // Skip internal settings
    .map(([key, setting]) => {
      const status = setting.value !== null ? "Configured" : "Not configured";
      const required = setting.required ? "Required" : "Optional";
      return `- ${setting.name} (${key}): ${status}, ${required}`;
    })
    .join("\n");

  return settings || "No settings available";
}

/**
 * Categorizes settings by their configuration status
 */
function categorizeSettings(worldSettings: WorldSettings): {
  configured: [string, OnboardingSetting][];
  requiredUnconfigured: [string, OnboardingSetting][];
  optionalUnconfigured: [string, OnboardingSetting][];
} {
  const configured: [string, OnboardingSetting][] = [];
  const requiredUnconfigured: [string, OnboardingSetting][] = [];
  const optionalUnconfigured: [string, OnboardingSetting][] = [];

  for (const [key, setting] of Object.entries(worldSettings) as [
    string,
    OnboardingSetting
  ][]) {
    // Skip internal settings
    if (key.startsWith("_")) continue;

    if (setting.value !== null) {
      configured.push([key, setting]);
    } else if (setting.required) {
      requiredUnconfigured.push([key, setting]);
    } else {
      optionalUnconfigured.push([key, setting]);
    }
  }

  return { configured, requiredUnconfigured, optionalUnconfigured };
}

/**
 * Extracts setting values from user message with improved handling of multiple settings
 */
async function extractSettingValues(
  runtime: IAgentRuntime,
  message: Memory,
  state: State,
  worldSettings: WorldSettings
): Promise<SettingUpdate[]> {
  try {
    // Create context with current settings status for better extraction
    const context = composeContext({
      state: {
        ...state,
        settings: Object.entries(worldSettings)
          .filter(([key]) => !key.startsWith("_")) // Skip internal settings
          .map(([key, setting]) => ({
            key,
            ...setting,
          })),
        settingsStatus: formatSettingsList(worldSettings),
      },
      template: extractionTemplate,
    });

    // Generate extractions using larger model for better comprehension
    const extractions = (await generateObjectArray({
      runtime,
      context,
      modelClass: ModelClass.TEXT_LARGE,
    })) as SettingUpdate[];

    logger.info(`Extracted ${extractions.length} potential setting updates`);

    // Validate each extraction against setting definitions
    const validExtractions = extractions.filter((update) => {
      const setting = worldSettings[update.key];
      if (!setting) {
        logger.info(`Ignored extraction for unknown setting: ${update.key}`);
        return false;
      }

      // Validate value if validation function exists
      if (setting.validation && !setting.validation(update.value)) {
        logger.info(`Validation failed for setting ${update.key}`);
        return false;
      }

      return true;
    });

    logger.info(`Validated ${validExtractions.length} setting updates`);
    return validExtractions;
  } catch (error) {
    logger.error("Error extracting setting values:", error);
    return [];
  }
}

/**
 * Processes multiple setting updates atomically
 */
async function processSettingUpdates(
  runtime: IAgentRuntime,
  serverId: string,
  worldSettings: WorldSettings,
  updates: SettingUpdate[]
): Promise<{ updatedAny: boolean; messages: string[] }> {
  if (!updates.length) {
    return { updatedAny: false, messages: [] };
  }

  const messages: string[] = [];
  let updatedAny = false;

  try {
    // Create a copy of the state for atomic updates
    const updatedState = { ...worldSettings };

    // Process all updates
    for (const update of updates) {
      const setting = updatedState[update.key];
      if (!setting) continue;

      // Check dependencies if they exist
      if (setting.dependsOn?.length) {
        const dependenciesMet = setting.dependsOn.every(
          (dep) => updatedState[dep]?.value !== null
        );
        if (!dependenciesMet) {
          messages.push(`Cannot update ${setting.name} - dependencies not met`);
          continue;
        }
      }

      // Update the setting
      updatedState[update.key] = {
        ...setting,
        value: update.value,
      };

      messages.push(`Updated ${setting.name} successfully`);
      updatedAny = true;

      // Execute onSetAction if defined
      if (setting.onSetAction) {
        const actionMessage = setting.onSetAction(update.value);
        if (actionMessage) {
          messages.push(actionMessage);
        }
      }
    }

    // If any updates were made, save the entire state to world metadata
    if (updatedAny) {
      // Save to world metadata
      const saved = await updateWorldSettings(
        runtime,
        serverId,
        updatedState
      );

      if (!saved) {
        throw new Error("Failed to save updated state to world metadata");
      }

      // Verify save by retrieving it again
      const savedState = await getWorldSettings(runtime, serverId);
      if (!savedState) {
        throw new Error("Failed to verify state save");
      }
    }

    return { updatedAny, messages };
  } catch (error) {
    logger.error("Error processing setting updates:", error);
    return {
      updatedAny: false,
      messages: ["Error occurred while updating settings"],
    };
  }
}

// Template for success responses when settings are updated
const successTemplate = `# Task: Generate a response for successful setting updates

# About {{agentName}}:
{{bio}}

# Current Settings Status:
{{settingsStatus}}

# Update Information:
- Updated Settings: {{updateMessages}}
- Next Required Setting: {{nextSetting.name}}
- Remaining Required Settings: {{remainingRequired}}

# Recent Conversation:
{{recentMessages}}

# Instructions:
1. Acknowledge the successful update of settings
2. Maintain {{agentName}}'s personality and tone
3. Provide clear guidance on the next setting that needs to be configured
4. Explain what the next setting is for and how to set it
5. If appropriate, mention how many required settings remain

Write a natural, conversational response that {{agentName}} would send about the successful update and next steps.
Include the action "SETTING_UPDATED" in your response.
` + messageCompletionFooter;

// Template for failure responses when settings couldn't be updated
const failureTemplate = `# Task: Generate a response for failed setting updates

# About {{agentName}}:
{{bio}}

# Current Settings Status:
{{settingsStatus}}

# Next Required Setting:
- Name: {{nextSetting.name}}
- Description: {{nextSetting.description}}
- Required: Yes
- Remaining Required Settings: {{remainingRequired}}

# Recent Conversation:
{{recentMessages}}

# Instructions:
1. Express that you couldn't understand or process the setting update
2. Maintain {{agentName}}'s personality and tone
3. Provide clear guidance on what setting needs to be configured next
4. Explain what the setting is for and how to set it properly
5. Use a helpful, patient tone

Write a natural, conversational response that {{agentName}} would send about the failed update and how to proceed.
Include the action "SETTING_UPDATE_FAILED" in your response.
` + messageCompletionFooter;

// Template for error responses when unexpected errors occur
const errorTemplate = `# Task: Generate a response for an error during setting updates

# About {{agentName}}:
{{bio}}

# Recent Conversation:
{{recentMessages}}

# Instructions:
1. Apologize for the technical difficulty
2. Maintain {{agentName}}'s personality and tone
3. Suggest trying again or contacting support if the issue persists
4. Keep the message concise and helpful

Write a natural, conversational response that {{agentName}} would send about the error.
Include the action "SETTING_UPDATE_ERROR" in your response.
` + messageCompletionFooter;

// Template for completion responses when all required settings are configured
const completionTemplate = `# Task: Generate a response for settings completion

# About {{agentName}}:
{{bio}}

# Settings Status:
{{settingsStatus}}

# Recent Conversation:
{{recentMessages}}

# Instructions:
1. Congratulate the user on completing the settings process
2. Maintain {{agentName}}'s personality and tone
3. Summarize the key settings that have been configured
4. Explain what functionality is now available
5. Provide guidance on what the user can do next
6. Express enthusiasm about working together

Write a natural, conversational response that {{agentName}} would send about the successful completion of settings.
Include the action "ONBOARDING_COMPLETE" in your response.
` + messageCompletionFooter;

/**
 * Handles the completion of settings when all required settings are configured
 */
async function handleOnboardingComplete(
  runtime: IAgentRuntime,
  worldSettings: WorldSettings,
  state: State,
  callback: HandlerCallback
): Promise<void> {
  try {
    // Generate completion message
    const context = composeContext({
      state: {
        ...state,
        settingsStatus: formatSettingsList(worldSettings),
      },
      template: completionTemplate,
    });

    const completionMessage = await generateMessageResponse({
      runtime,
      context,
      modelClass: ModelClass.TEXT_SMALL,
    });

    await callback({
      text: completionMessage.text,
      action: "ONBOARDING_COMPLETE",
      source: "discord",
    });
  } catch (error) {
    logger.error(`Error handling settings completion: ${error}`);
    await callback({
      text: "Great! All required settings have been configured. Your server is now fully set up and ready to use.",
      action: "ONBOARDING_COMPLETE",
      source: "discord",
    });
  }
}

/**
 * Generates a success response for setting updates
 */
async function generateSuccessResponse(
  runtime: IAgentRuntime,
  worldSettings: WorldSettings,
  state: State,
  messages: string[],
  callback: HandlerCallback
): Promise<void> {
  try {
    // Check if all required settings are now configured
    const { requiredUnconfigured } = categorizeSettings(worldSettings);

    if (requiredUnconfigured.length === 0) {
      // All required settings are configured, complete settings
      await handleOnboardingComplete(runtime, worldSettings, state, callback);
      return;
    }

    // Generate success message
    const context = composeContext({
      state: {
        ...state,
        updateMessages: messages.join("\n"),
        nextSetting: requiredUnconfigured[0][1],
        remainingRequired: requiredUnconfigured.length,
      },
      template: successTemplate,
    });

    const successMessage = await generateMessageResponse({
      runtime,
      context,
      modelClass: ModelClass.TEXT_SMALL,
    });

    await callback({
      text: successMessage.text,
      action: "SETTING_UPDATED",
      source: "discord",
    });
  } catch (error) {
    logger.error(`Error generating success response: ${error}`);
    await callback({
      text: "Settings updated successfully. Please continue with the remaining configuration.",
      action: "SETTING_UPDATED",
      source: "discord",
    });
  }
}

/**
 * Generates a failure response when no settings could be updated
 */
async function generateFailureResponse(
  runtime: IAgentRuntime,
  worldSettings: WorldSettings,
  state: State,
  callback: HandlerCallback
): Promise<void> {
  try {
    // Get next required setting
    const { requiredUnconfigured } = categorizeSettings(worldSettings);

    if (requiredUnconfigured.length === 0) {
      // All required settings are configured, complete settings
      await handleOnboardingComplete(runtime, worldSettings, state, callback);
      return;
    }

    // Generate failure message
    const context = composeContext({
      state: {
        ...state,
        nextSetting: requiredUnconfigured[0][1],
        remainingRequired: requiredUnconfigured.length,
      },
      template: failureTemplate,
    });

    const failureMessage = await generateMessageResponse({
      runtime,
      context,
      modelClass: ModelClass.TEXT_SMALL,
    });

    await callback({
      text: failureMessage.text,
      action: "SETTING_UPDATE_FAILED",
      source: "discord",
    });
  } catch (error) {
    logger.error(`Error generating failure response: ${error}`);
    await callback({
      text: "I couldn't understand your settings update. Please try again with a clearer format.",
      action: "SETTING_UPDATE_FAILED",
      source: "discord",
    });
  }
}

/**
 * Generates an error response for unexpected errors
 */
async function generateErrorResponse(
  runtime: IAgentRuntime,
  state: State,
  callback: HandlerCallback
): Promise<void> {
  try {
    const context = composeContext({
      state,
      template: errorTemplate,
    });

    const errorMessage = await generateMessageResponse({
      runtime,
      context,
      modelClass: ModelClass.TEXT_SMALL,
    });

    await callback({
      text: errorMessage.text,
      action: "SETTING_UPDATE_ERROR",
      source: "discord",
    });
  } catch (error) {
    logger.error(`Error generating error response: ${error}`);
    await callback({
      text: "I'm sorry, but I encountered an error while processing your request. Please try again or contact support if the issue persists.",
      action: "SETTING_UPDATE_ERROR",
      source: "discord",
    });
  }
}

/**
 * Enhanced settings action with improved state management and logging
 * Updated to use world metadata instead of cache
 */
const updateSettingsAction: Action = {
  name: "UPDATE_SETTINGS",
  similes: ["UPDATE_SETTING", "SAVE_SETTING", "SET_CONFIGURATION", "CONFIGURE"],
  description: "Saves a setting during the settings process",

  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State
  ): Promise<boolean> => {
    try {
      if (!message.userId) {
        logger.error("No user ID in message for settings validation");
        return false;
      }

      // Log the user ID for debugging
      const normalizedUserId = normalizeUserId(message.userId);
      logger.info(
        `Validating settings action for user ${message.userId} (normalized: ${normalizedUserId})`
      );

      // Validate that we're in a DM channel
      const room = await runtime.getRoom(message.roomId);
      if (!room) {
        logger.error(`No room found for ID ${message.roomId}`);
        return false;
      }

      if (room.type !== ChannelType.DM) {
        logger.info(
          `Skipping settings in non-DM channel (type: ${room.type})`
        );
        return false;
      }

      // Find the server where this user is the owner
      logger.info(`Looking for server where user ${message.userId} is owner`);
      const world = await findWorldForOwner(runtime, message.userId);
      if (!world) {
        logger.error(`No server ownership found for user ${message.userId}`);
        return false;
      }

      logger.info(
        `Found server ${world.serverId} owned by ${world.metadata.ownership.ownerId}`
      );

      // Check if there's an active settings state in world metadata
      const worldSettings = world.metadata.settings;

      if (!worldSettings) {
        logger.error(`No settings state found for server ${world.serverId}`);
        return false;
      }

      logger.info(
        `Found valid settings state for server ${world.serverId}`
      );
      return true;
    } catch (error) {
      logger.error(`Error validating settings action: ${error}`);
      return false;
    }
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    _options: any,
    callback: HandlerCallback
  ): Promise<void> => {
    if (!message.content.source || message.content.source !== "discord") {
      logger.info(
        `Skipping non-discord message source: ${message.content.source}`
      );
      return;
    }

    try {
      // Find the server where this user is the owner
      logger.info(`Handler looking for server for user ${message.userId}`);
      const serverOwnership = await findWorldForOwner(runtime, message.userId);
      if (!serverOwnership) {
        logger.error(`No server found for user ${message.userId} in handler`);
        await generateErrorResponse(runtime, state, callback);
        return;
      }

      const serverId = serverOwnership.serverId;
      logger.info(`Using server ID: ${serverId}`);

      // Get settings state from world metadata
      const worldSettings = await getWorldSettings(runtime, serverId);

      if (!worldSettings) {
        logger.error(
          `No settings state found for server ${serverId} in handler`
        );
        await generateErrorResponse(runtime, state, callback);
        return;
      }

      // Check if all required settings are already configured
      const { requiredUnconfigured } = categorizeSettings(worldSettings);
      if (requiredUnconfigured.length === 0) {
        logger.info("All required settings configured, completing settings");
        await handleOnboardingComplete(
          runtime,
          worldSettings,
          state,
          callback
        );
        return;
      }

      // Extract setting values from message
      logger.info(`Extracting settings from message: ${message.content.text}`);
      const extractedSettings = await extractSettingValues(
        runtime,
        message,
        state,
        worldSettings
      );
      logger.info(`Extracted ${extractedSettings.length} settings`);

      // Process extracted settings
      const updateResults = await processSettingUpdates(
        runtime,
        serverId,
        worldSettings,
        extractedSettings
      );

      // Generate appropriate response
      if (updateResults.updatedAny) {
        logger.info(
          `Successfully updated settings: ${updateResults.messages.join(", ")}`
        );

        // Get updated settings state
        const updatedWorldSettings = await getWorldSettings(
          runtime,
          serverId
        );
        if (!updatedWorldSettings) {
          logger.error(`Failed to retrieve updated settings state`);
          await generateErrorResponse(runtime, state, callback);
          return;
        }

        await generateSuccessResponse(
          runtime,
          updatedWorldSettings,
          state,
          updateResults.messages,
          callback
        );
      } else {
        logger.info("No settings were updated");
        await generateFailureResponse(
          runtime,
          worldSettings,
          state,
          callback
        );
      }
    } catch (error) {
      logger.error(`Error in settings handler: ${error}`);
      await generateErrorResponse(runtime, state, callback);
    }
  },
  examples: [
    [
      {
        user: "{{user1}}",
        content: {
          text: "I want to set up the welcome channel to #general",
          source: "discord",
        },
      },
      {
        user: "{{user2}}",
        content: {
          text: "Perfect! I've updated your welcome channel to #general. Next, we should configure the automated greeting message that new members will receive.",
          action: "SETTING_UPDATED",
          source: "discord",
        },
      },
    ],
    [
      {
        user: "{{user1}}",
        content: {
          text: "Let's set the bot prefix to !",
          source: "discord",
        },
      },
      {
        user: "{{user2}}",
        content: {
          text: "Great choice! I've set the command prefix to '!'. Now you can use commands like !help, !info, etc.",
          action: "SETTING_UPDATED",
          source: "discord",
        },
      },
    ],
    [
      {
        user: "{{user1}}",
        content: {
          text: "Enable auto-moderation for bad language",
          source: "discord",
        },
      },
      {
        user: "{{user2}}",
        content: {
          text: "Auto-moderation for inappropriate language has been enabled. I'll now filter messages containing offensive content.",
          action: "SETTING_UPDATED",
          source: "discord",
        },
      },
    ],
    [
      {
        user: "{{user1}}",
        content: {
          text: "For server logs, use the #server-logs channel",
          source: "discord",
        },
      },
      {
        user: "{{user2}}",
        content: {
          text: "I've configured #server-logs as your logging channel. All server events like joins, leaves, and moderation actions will be recorded there.",
          action: "SETTING_UPDATED",
          source: "discord",
        },
      },
    ],
    [
      {
        user: "{{user1}}",
        content: {
          text: "I'd like to have role self-assignment in the #roles channel",
          source: "discord",
        },
      },
      {
        user: "{{user2}}",
        content: {
          text: "Role self-assignment has been set up in the #roles channel. Members can now assign themselves roles by interacting with messages there.",
          action: "SETTING_UPDATED",
          source: "discord",
        },
      },
    ],
    [
      {
        user: "{{user1}}",
        content: {
          text: "Make music commands available in voice-text channels only",
          source: "discord",
        },
      },
      {
        user: "{{user2}}",
        content: {
          text: "I've updated your music command settings - they'll now only work in voice-text channels. This helps keep other channels clear of music spam.",
          action: "SETTING_UPDATED",
          source: "discord",
        },
      },
    ],
    [
      {
        user: "{{user1}}",
        content: {
          text: "For server timezone, set it to EST",
          source: "discord",
        },
      },
      {
        user: "{{user2}}",
        content: {
          text: "Server timezone has been set to Eastern Standard Time (EST). All scheduled events and timestamps will now display in this timezone.",
          action: "SETTING_UPDATED",
          source: "discord",
        },
      },
    ],
    [
      {
        user: "{{user1}}",
        content: {
          text: "Set verification level to email verified users only",
          source: "discord",
        },
      },
      {
        user: "{{user2}}",
        content: {
          text: "I've updated the verification requirement to email verified accounts only. This adds an extra layer of security to your server.",
          action: "SETTING_UPDATED",
          source: "discord",
        },
      },
    ],
    [
      {
        user: "{{user1}}",
        content: {
          text: "I want to turn off level-up notifications",
          source: "discord",
        },
      },
      {
        user: "{{user2}}",
        content: {
          text: "Level-up notifications have been disabled. Members will still earn experience and level up, but there won't be any automatic announcements. You can still view levels with the appropriate commands.",
          action: "SETTING_UPDATED",
          source: "discord",
        },
      },
    ],
    [
      {
        user: "{{user1}}",
        content: {
          text: "My server name is 'Gaming Lounge'",
          source: "discord",
        },
      },
      {
        user: "{{user2}}",
        content: {
          text: "Great! I've saved 'Gaming Lounge' as your server name. This helps me personalize responses and know how to refer to your community. We've completed all the required settings! Your server is now fully configured and ready to use. You can always adjust these settings later if needed.",
          action: "ONBOARDING_COMPLETE",
          source: "discord",
        },
      },
    ],
  ] as ActionExample[][],
};

export default updateSettingsAction;
