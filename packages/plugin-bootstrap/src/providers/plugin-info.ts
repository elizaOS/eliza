/**
 * Plugin Information Providers for Bootstrap Plugin
 *
 * Two dynamic providers:
 * 1. bootstrapInstructionsProvider - Usage instructions for the agent/LLM
 * 2. bootstrapSettingsProvider - Current configuration (non-sensitive)
 */

import type { IAgentRuntime, Provider, ProviderResult, Memory, State } from '@elizaos/core';

/**
 * Instructions Provider
 */
export const bootstrapInstructionsProvider: Provider = {
  name: 'bootstrapInstructions',
  description: 'Instructions and capabilities for the bootstrap (core) plugin',
  dynamic: true,

  get: async (_runtime: IAgentRuntime, _message: Memory, _state: State): Promise<ProviderResult> => {
    const instructions = `
# Bootstrap Plugin Capabilities

## What This Plugin Does

The bootstrap plugin provides essential agent capabilities. It's the foundation that enables basic agent functionality.

## Core Actions

### Communication
- **REPLY**: Respond to messages (primary communication action)
- **SEND_MESSAGE**: Send a message to a specific room/channel
- **IGNORE**: Explicitly ignore a message (no response)
- **NONE**: Take no action

### Room Management
- **FOLLOW_ROOM**: Start following a room's messages
- **UNFOLLOW_ROOM**: Stop following a room
- **MUTE_ROOM**: Temporarily mute notifications from a room
- **UNMUTE_ROOM**: Restore notifications for a room

### Entity & Role Management
- **UPDATE_ENTITY**: Update information about an entity/user
- **UPDATE_ROLE**: Change role/permissions for an entity
- **UPDATE_SETTINGS**: Modify configuration settings

### Content
- **GENERATE_IMAGE**: Create images using AI models
- **CHOICE**: Present options for user selection

## Core Providers

The bootstrap plugin provides essential context:
- **TIME**: Current date and time
- **ENTITIES**: Information about participants
- **RELATIONSHIPS**: Connection between entities
- **FACTS**: Known facts about the conversation
- **RECENT_MESSAGES**: Recent conversation history
- **CHARACTER**: Agent's personality and traits
- **ACTIONS**: Available actions
- **PROVIDERS**: Available data providers

## Event Handling

Bootstrap handles key events:
- Message received/sent
- Reactions
- Entity joins/leaves
- World connections
- Action lifecycle (start/complete)
- Run lifecycle (start/end/timeout)

## Best Practices

1. **REPLY for conversations**: Use REPLY for normal responses
2. **IGNORE intentionally**: Use IGNORE when staying silent is appropriate
3. **Room awareness**: Follow relevant rooms, mute noisy ones
4. **Entity context**: Use entity info for personalization
`;

    return {
      text: instructions.trim(),
      data: {
        pluginName: 'bootstrap',
        isCore: true,
      },
    };
  },
};

/**
 * Settings Provider
 */
export const bootstrapSettingsProvider: Provider = {
  name: 'bootstrapSettings',
  description: 'Current bootstrap plugin configuration (non-sensitive)',
  dynamic: true,

  get: async (runtime: IAgentRuntime, _message: Memory, _state: State): Promise<ProviderResult> => {
    // Check configurable settings
    const alwaysRespondChannels = runtime.getSetting('ALWAYS_RESPOND_CHANNELS') || '';
    const alwaysRespondSources = runtime.getSetting('ALWAYS_RESPOND_SOURCES') || '';

    const settings = {
      pluginEnabled: true,
      agentName: runtime.character?.name || 'Agent',
      hasCustomRespondChannels: !!alwaysRespondChannels,
      hasCustomRespondSources: !!alwaysRespondSources,
    };

    const text = `
# Bootstrap Plugin Settings

## Plugin Status
- **Status**: Enabled (Core Plugin)
- **Agent**: ${settings.agentName}

## Response Configuration
- **Custom Respond Channels**: ${settings.hasCustomRespondChannels ? 'Configured' : 'Using defaults'}
- **Custom Respond Sources**: ${settings.hasCustomRespondSources ? 'Configured' : 'Using defaults'}

## Default Behavior
- Always responds in DMs and API calls
- Responds when mentioned or replied to
- Uses LLM evaluation for other messages
`;

    return {
      text: text.trim(),
      data: settings,
      values: {
        pluginEnabled: 'true',
        isCore: 'true',
      },
    };
  },
};

