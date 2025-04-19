import {
  type Action,
  type ActionExample,
  ChannelType,
  composePrompt,
  composePromptFromState,
  type Content,
  createUniqueUuid,
  findWorldsForOwner,
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type Memory,
  ModelType,
  parseJSONObjectFromText,
  type Setting,
  type State,
  type WorldSettings,
} from '@elizaos/core';
import dedent from 'dedent';

/**
 * Interface representing the structure of a setting update object.
 * @interface
 * @property {string} key - The key of the setting to be updated.
 * @property {string|boolean} value - The new value for the setting, can be a string or a boolean.
 */
/**
 * Interface for updating settings.
 * @typedef {Object} SettingUpdate
 * @property {string} key - The key of the setting to update.
 * @property {string | boolean} value - The new value of the setting, can be a string or a boolean.
 */
interface SettingUpdate {
  key: string;
  value: string | boolean;
}

const messageCompletionFooter = `\n# Instructions: Write the next message for {{agentName}}. Include the appropriate action from the list: {{actionNames}}
Response format should be formatted in a valid JSON block like this:
\`\`\`json
{ "name": "{{agentName}}", "text": "<string>", "thought": "<string>", "actions": ["<string>", "<string>", "<string>"] }
\`\`\`
Do not including any thinking or internal reflection in the "text" field.
"thought" should be a short description of what the agent is thinking about before responding, including a brief justification for the response.`;

// Template for success responses when settings are updated
/**
 * JSDoc comment for successTemplate constant
 *
 * # Task: Generate a response for successful setting updates
 * {{providers}}
 *
 * # Update Information:
 * - Updated Settings: {{updateMessages}}
 * - Next Required Setting: {{nextSetting.name}}
 * - Remaining Required Settings: {{remainingRequired}}
 *
 * # Instructions:
 * 1. Acknowledge the successful update of settings
 * 2. Maintain {{agentName}}'s personality and tone
 * 3. Provide clear guidance on the next setting that needs to be configured
 * 4. Explain what the next setting is for and how to set it
 * 5. If appropriate, mention how many required settings remain
 *
 * Write a natural, conversational response that {{agentName}} would send about the successful update and next steps.
 * Include the actions array ["SETTING_UPDATED"] in your response.
 * ${messageCompletionFooter}
 */
const successTemplate = `# Task: Generate a response for successful setting updates
{{providers}}

# Update Information:
- Updated Settings: {{updateMessages}}
- Next Required Setting: {{nextSetting.name}}
- Remaining Required Settings: {{remainingRequired}}

# Instructions:
1. Acknowledge the successful update of settings
2. Maintain {{agentName}}'s personality and tone
3. Provide clear guidance on the next setting that needs to be configured
4. Explain what the next setting is for and how to set it
5. If appropriate, mention how many required settings remain

Write a natural, conversational response that {{agentName}} would send about the successful update and next steps.
Include the actions array ["SETTING_UPDATED"] in your response.
${messageCompletionFooter}`;

// Template for failure responses when settings couldn't be updated
/**
 * Template for generating a response for failed setting updates.
 *
 * @template T
 * @param {string} failureTemplate - The failure template string to fill in with dynamic content.
 * @returns {string} - The filled-in template for generating the response.
 */
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
Include the actions array ["SETTING_UPDATE_FAILED"] in your response.
${messageCompletionFooter}`;

// Template for error responses when unexpected errors occur
/**
 * Template for generating a response for an error during setting updates.
 *
 * The template includes placeholders for agent name, bio, recent messages,
 * and provides instructions for crafting a response.
 *
 * Instructions:
 * 1. Apologize for the technical difficulty
 * 2. Maintain agent's personality and tone
 * 3. Suggest trying again or contacting support if the issue persists
 * 4. Keep the message concise and helpful
 *
 * Actions array to include: ["SETTING_UPDATE_ERROR"]
 */
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
Include the actions array ["SETTING_UPDATE_ERROR"] in your response.
${messageCompletionFooter}`;

// Template for completion responses when all required settings are configured
/**
 * Task: Generate a response for settings completion
 *
 * About {{agentName}}:
 * {{bio}}
 *
 * Settings Status:
 * {{settingsStatus}}
 *
 * Recent Conversation:
 * {{recentMessages}}
 *
 * Instructions:
 * 1. Congratulate the user on completing the settings process
 * 2. Maintain {{agentName}}'s personality and tone
 * 3. Summarize the key settings that have been configured
 * 4. Explain what functionality is now available
 * 5. Provide guidance on what the user can do next
 * 6. Express enthusiasm about working together
 *
 * Write a natural, conversational response that {{agentName}} would send about the successful completion of settings.
 * Include the actions array ["ONBOARDING_COMPLETE"] in your response.
 */
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
Include the actions array ["ONBOARDING_COMPLETE"] in your response.
${messageCompletionFooter}`;

/**
 * Generates an extraction template with formatting details.
 *
 * @param {WorldSettings} worldSettings - The settings to generate a template for.
 * @returns {string} The formatted extraction template.
 */
const extractionTemplate = `# Task: Extract Setting Changes from User Input

I need to extract settings that the user wants to change based on their message.

Available Settings:
{{settingsContext}}

User message: {{content}}

For each setting mentioned in the user's input, extract the key and its new value.
Format your response as a JSON array of objects, each with 'key' and 'value' properties.

Example response:
\`\`\`json
[
  { "key": "SETTING_NAME", "value": "extracted value" },
  { "key": "ANOTHER_SETTING", "value": "another value" }
]
\`\`\`

IMPORTANT: Only include settings from the Available Settings list above. Ignore any other potential settings.`;

/**
 * Gets settings state from world metadata
 */
/**
 * Retrieves the settings for a specific world from the database.
 * @param {IAgentRuntime} runtime - The Agent Runtime instance.
 * @param {string} serverId - The ID of the server.
 * @returns {Promise<WorldSettings | null>} The settings of the world, or null if not found.
 */
export async function getWorldSettings(
  runtime: IAgentRuntime,
  serverId: string
): Promise<WorldSettings | null> {
  try {
    const worldId = createUniqueUuid(runtime, serverId);
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
    const worldId = createUniqueUuid(runtime, serverId);
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
    .filter(([key]) => !key.startsWith('_')) // Skip internal settings
    .map(([key, setting]) => {
      const status = setting.value !== null ? 'Configured' : 'Not configured';
      const required = setting.required ? 'Required' : 'Optional';
      return `- ${setting.name} (${key}): ${status}, ${required}`;
    })
    .join('\n');

  return settings || 'No settings available';
}

/**
 * Categorizes settings by their configuration status
 */
function categorizeSettings(worldSettings: WorldSettings): {
  configured: [string, Setting][];
  requiredUnconfigured: [string, Setting][];
  optionalUnconfigured: [string, Setting][];
} {
  const configured: [string, Setting][] = [];
  const requiredUnconfigured: [string, Setting][] = [];
  const optionalUnconfigured: [string, Setting][] = [];

  for (const [key, setting] of Object.entries(worldSettings) as [string, Setting][]) {
    // Skip internal settings
    if (key.startsWith('_')) continue;

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
  _message: Memory,
  state: State,
  worldSettings: WorldSettings
): Promise<SettingUpdate[]> {
  // Find what settings need to be configured
  const { requiredUnconfigured, optionalUnconfigured } = categorizeSettings(worldSettings);

  // Generate a prompt to extract settings from the user's message
  const settingsContext = requiredUnconfigured
    .concat(optionalUnconfigured)
    .map(([key, setting]) => {
      const requiredStr = setting.required ? 'Required.' : 'Optional.';
      return `${key}: ${setting.description} ${requiredStr}`;
    })
    .join('\n');

  const basePrompt = dedent`
    I need to extract settings values from the user's message.
    
    Available settings:
    ${settingsContext}
    
    User message: ${state.text}

    For each setting mentioned in the user's message, extract the value.
    
    Only return settings that are clearly mentioned in the user's message.
    If a setting is mentioned but no clear value is provided, do not include it.
    `;

  try {
    // Use runtime.useModel directly with strong typing
    const result = await runtime.useModel<typeof ModelType.OBJECT_LARGE, SettingUpdate[]>(
      ModelType.OBJECT_LARGE,
      {
        prompt: basePrompt,
        output: 'array',
        schema: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string' },
              value: { type: 'string' },
            },
            required: ['key', 'value'],
          },
        },
      }
    );

    // Validate the extracted settings
    if (!result) {
      return [];
    }

    function extractValidSettings(obj: unknown, worldSettings: WorldSettings) {
      const extracted = [];

      function traverse(node: unknown): void {
        if (Array.isArray(node)) {
          for (const item of node) {
            traverse(item);
          }
        } else if (typeof node === 'object' && node !== null) {
          for (const [key, value] of Object.entries(node)) {
            if (worldSettings[key] && typeof value !== 'object') {
              extracted.push({ key, value });
            } else {
              traverse(value);
            }
          }
        }
      }

      traverse(obj);
      return extracted;
    }

    const extractedSettings = extractValidSettings(result, worldSettings);

    return extractedSettings;
  } catch (error) {
    console.error('Error extracting settings:', error);
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
        const dependenciesMet = setting.dependsOn.every((dep) => updatedState[dep]?.value !== null);
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
      const saved = await updateWorldSettings(runtime, serverId, updatedState);

      if (!saved) {
        throw new Error('Failed to save updated state to world metadata');
      }

      // Verify save by retrieving it again
      const savedState = await getWorldSettings(runtime, serverId);
      if (!savedState) {
        throw new Error('Failed to verify state save');
      }
    }

    return { updatedAny, messages };
  } catch (error) {
    logger.error('Error processing setting updates:', error);
    return {
      updatedAny: false,
      messages: ['Error occurred while updating settings'],
    };
  }
}

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
    const prompt = composePrompt({
      state: {
        settingsStatus: formatSettingsList(worldSettings),
      },
      template: completionTemplate,
    });

    const response = await runtime.useModel(ModelType.TEXT_LARGE, {
      prompt,
    });

    const responseContent = parseJSONObjectFromText(response) as Content;

    await callback({
      text: responseContent.text,
      actions: ['ONBOARDING_COMPLETE'],
      source: 'discord',
    });
  } catch (error) {
    logger.error(`Error handling settings completion: ${error}`);
    await callback({
      text: 'Great! All required settings have been configured. Your server is now fully set up and ready to use.',
      actions: ['ONBOARDING_COMPLETE'],
      source: 'discord',
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

    const requiredUnconfiguredString = requiredUnconfigured
      .map(([key, setting]) => `${key}: ${setting.name}`)
      .join('\n');

    // Generate success message
    const prompt = composePrompt({
      state: {
        updateMessages: messages.join('\n'),
        nextSetting: requiredUnconfiguredString,
        remainingRequired: requiredUnconfigured.length.toString(),
      },
      template: successTemplate,
    });

    const response = await runtime.useModel(ModelType.TEXT_LARGE, {
      prompt,
    });

    const responseContent = parseJSONObjectFromText(response) as Content;

    await callback({
      text: responseContent.text,
      actions: ['SETTING_UPDATED'],
      source: 'discord',
    });
  } catch (error) {
    logger.error(`Error generating success response: ${error}`);
    await callback({
      text: 'Settings updated successfully. Please continue with the remaining configuration.',
      actions: ['SETTING_UPDATED'],
      source: 'discord',
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

    const requiredUnconfiguredString = requiredUnconfigured
      .map(([key, setting]) => `${key}: ${setting.name}`)
      .join('\n');

    // Generate failure message
    const prompt = composePrompt({
      state: {
        nextSetting: requiredUnconfiguredString,
        remainingRequired: requiredUnconfigured.length.toString(),
      },
      template: failureTemplate,
    });

    const response = await runtime.useModel(ModelType.TEXT_LARGE, {
      prompt,
    });

    const responseContent = parseJSONObjectFromText(response) as Content;

    await callback({
      text: responseContent.text,
      actions: ['SETTING_UPDATE_FAILED'],
      source: 'discord',
    });
  } catch (error) {
    logger.error(`Error generating failure response: ${error}`);
    await callback({
      text: "I couldn't understand your settings update. Please try again with a clearer format.",
      actions: ['SETTING_UPDATE_FAILED'],
      source: 'discord',
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
    const prompt = composePromptFromState({
      state,
      template: errorTemplate,
    });

    const response = await runtime.useModel(ModelType.TEXT_LARGE, {
      prompt,
    });

    const responseContent = parseJSONObjectFromText(response) as Content;

    await callback({
      text: responseContent.text,
      actions: ['SETTING_UPDATE_ERROR'],
      source: 'discord',
    });
  } catch (error) {
    logger.error(`Error generating error response: ${error}`);
    await callback({
      text: "I'm sorry, but I encountered an error while processing your request. Please try again or contact support if the issue persists.",
      actions: ['SETTING_UPDATE_ERROR'],
      source: 'discord',
    });
  }
}

/**
 * Enhanced settings action with improved state management and logging
 * Updated to use world metadata instead of cache
 */
export const updateSettingsAction: Action = {
  name: 'UPDATE_SETTINGS',
  similes: ['UPDATE_SETTING', 'SAVE_SETTING', 'SET_CONFIGURATION', 'CONFIGURE'],
  description:
    'Saves a configuration setting during the onboarding process, or update an existing setting. Use this when you are onboarding with a world owner or admin.',

  validate: async (runtime: IAgentRuntime, message: Memory, _state: State): Promise<boolean> => {
    try {
      if (message.content.channelType !== ChannelType.DM) {
        logger.debug(`Skipping settings in non-DM channel (type: ${message.content.channelType})`);
        return false;
      }

      // Find the server where this user is the owner
      logger.debug(`Looking for server where user ${message.entityId} is owner`);
      const worlds = await findWorldsForOwner(runtime, message.entityId);
      if (!worlds) {
        return false;
      }

      const world = worlds.find((world) => world.metadata.settings);

      // Check if there's an active settings state in world metadata
      const worldSettings = world.metadata.settings;

      if (!worldSettings) {
        logger.error(`No settings state found for server ${world.serverId}`);
        return false;
      }

      logger.debug(`Found valid settings state for server ${world.serverId}`);
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
    try {
      // Find the server where this user is the owner
      logger.info(`Handler looking for server for user ${message.entityId}`);
      const worlds = await findWorldsForOwner(runtime, message.entityId);
      const serverOwnership = worlds.find((world) => world.metadata.settings);
      if (!serverOwnership) {
        logger.error(`No server found for user ${message.entityId} in handler`);
        await generateErrorResponse(runtime, state, callback);
        return;
      }

      const serverId = serverOwnership.serverId;
      logger.info(`Using server ID: ${serverId}`);

      // Get settings state from world metadata
      const worldSettings = await getWorldSettings(runtime, serverId);

      if (!worldSettings) {
        logger.error(`No settings state found for server ${serverId} in handler`);
        await generateErrorResponse(runtime, state, callback);
        return;
      }

      // Extract setting values from message
      logger.info(`Extracting settings from message: ${message.content.text}`);
      const extractedSettings = await extractSettingValues(runtime, message, state, worldSettings);
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
        logger.info(`Successfully updated settings: ${updateResults.messages.join(', ')}`);

        // Get updated settings state
        const updatedWorldSettings = await getWorldSettings(runtime, serverId);
        if (!updatedWorldSettings) {
          logger.error('Failed to retrieve updated settings state');
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
        logger.info('No settings were updated');
        await generateFailureResponse(runtime, worldSettings, state, callback);
      }
    } catch (error) {
      logger.error(`Error in settings handler: ${error}`);
      await generateErrorResponse(runtime, state, callback);
    }
  },
  examples: [
    [
      {
        name: '{{name1}}',
        content: {
          text: 'I want to set up the welcome channel to #general',
          source: 'discord',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: "Perfect! I've updated your welcome channel to #general. Next, we should configure the automated greeting message that new members will receive.",
          actions: ['SETTING_UPDATED'],
          source: 'discord',
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: "Let's set the bot prefix to !",
          source: 'discord',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: "Great choice! I've set the command prefix to '!'. Now you can use commands like !help, !info, etc.",
          actions: ['SETTING_UPDATED'],
          source: 'discord',
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'Enable auto-moderation for bad language',
          source: 'discord',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: "Auto-moderation for inappropriate language has been enabled. I'll now filter messages containing offensive content.",
          actions: ['SETTING_UPDATED'],
          source: 'discord',
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'For server logs, use the #server-logs channel',
          source: 'discord',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: "I've configured #server-logs as your logging channel. All server events like joins, leaves, and moderation actions will be recorded there.",
          actions: ['SETTING_UPDATED'],
          source: 'discord',
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: "I'd like to have role self-assignment in the #roles channel",
          source: 'discord',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: 'Role self-assignment has been set up in the #roles channel. Members can now assign themselves roles by interacting with messages there.',
          actions: ['SETTING_UPDATED'],
          source: 'discord',
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'Make music commands available in voice-text channels only',
          source: 'discord',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: "I've updated your music command settings - they'll now only work in voice-text channels. This helps keep other channels clear of music spam.",
          actions: ['SETTING_UPDATED'],
          source: 'discord',
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'For server timezone, set it to EST',
          source: 'discord',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: 'Server timezone has been set to Eastern Standard Time (EST). All scheduled events and timestamps will now display in this timezone.',
          actions: ['SETTING_UPDATED'],
          source: 'discord',
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'Set verification level to email verified users only',
          source: 'discord',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: "I've updated the verification requirement to email verified accounts only. This adds an extra layer of security to your server.",
          actions: ['SETTING_UPDATED'],
          source: 'discord',
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'I want to turn off level-up notifications',
          source: 'discord',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: "Level-up notifications have been disabled. Members will still earn experience and level up, but there won't be any automatic announcements. You can still view levels with the appropriate commands.",
          actions: ['SETTING_UPDATED'],
          source: 'discord',
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: "My server name is 'Gaming Lounge'",
          source: 'discord',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: "Great! I've saved 'Gaming Lounge' as your server name. This helps me personalize responses and know how to refer to your community. We've completed all the required settings! Your server is now fully configured and ready to use. You can always adjust these settings later if needed.",
          actions: ['ONBOARDING_COMPLETE'],
          source: 'discord',
        },
      },
    ],
  ] as ActionExample[][],
};
