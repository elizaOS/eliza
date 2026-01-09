// action: SEND_MESSAGE
// send message to a user or room (other than this room we are in)

import {
  type Action,
  type ActionExample,
  composePromptFromState,
  type Content,
  findEntityByName,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  logger,
  type Memory,
  ModelType,
  parseKeyValueXml,
  type State,
  type ActionResult,
} from '@elizaos/core';

/** Shape of the target extraction XML response */
interface TargetExtractionResult {
  targetType?: string;
  source?: string;
  identifiers?: {
    roomName?: string;
    userId?: string;
    username?: string;
  };
}

/**
 * Interface for services that support sending direct messages.
 * Plugins implementing messaging should conform to this interface.
 */
interface DirectMessageCapableService {
  sendDirectMessage: (target: string, content: Content) => Promise<void>;
}

/**
 * Interface for services that support sending room messages.
 * Plugins implementing room messaging should conform to this interface.
 */
interface RoomMessageCapableService {
  sendRoomMessage: (target: string, content: Content) => Promise<void>;
}

/**
 * Type guard to check if a service supports direct messaging.
 */
function hasDirectMessageCapability(service: unknown): service is DirectMessageCapableService {
  return (
    service !== null &&
    typeof service === 'object' &&
    'sendDirectMessage' in service &&
    typeof (service as DirectMessageCapableService).sendDirectMessage === 'function'
  );
}

/**
 * Type guard to check if a service supports room messaging.
 */
function hasRoomMessageCapability(service: unknown): service is RoomMessageCapableService {
  return (
    service !== null &&
    typeof service === 'object' &&
    'sendRoomMessage' in service &&
    typeof (service as RoomMessageCapableService).sendRoomMessage === 'function'
  );
}

/**
 * Get all available message sources from the runtime's registered services.
 *
 * This function inspects all registered services to find those that implement
 * messaging capabilities (sendDirectMessage or sendRoomMessage methods).
 * This provides automatic discovery of message sources from plugins.
 */
function getAvailableMessageSources(runtime: IAgentRuntime): Set<string> {
  const sources = new Set<string>();

  const allServices = runtime.getAllServices();
  for (const [serviceType, services] of allServices) {
    for (const service of services) {
      if (hasDirectMessageCapability(service) || hasRoomMessageCapability(service)) {
        // Use the service type as the source identifier
        sources.add(serviceType);
      }
    }
  }

  return sources;
}

/**
 * Task: Extract Target and Source Information
 *
 * Recent Messages:
 * {{recentMessages}}
 *
 * Instructions:
 * Analyze the conversation to identify:
 * 1. The target type (user or room)
 * 2. The target platform/source (e.g. telegram, discord, etc)
 * 3. Any identifying information about the target
 *
 * Return an XML response with:
 * <response>
 *   <targetType>user|room</targetType>
 *   <source>platform-name</source>
 *   <identifiers>
 *     <username>username_if_applicable</username>
 *     <roomName>room_name_if_applicable</roomName>
 *     <!-- Add other relevant identifiers as needed -->
 *   </identifiers>
 * </response>
 *
 * Example outputs:
 * For "send a message to @dev_guru on telegram":
 * <response>
 *   <targetType>user</targetType>
 *   <source>telegram</source>
 *   <identifiers>
 *     <username>dev_guru</username>
 *   </identifiers>
 * </response>
 *
 * For "post this in #announcements":
 * <response>
 *   <targetType>room</targetType>
 *   <source>discord</source>
 *   <identifiers>
 *     <roomName>announcements</roomName>
 *   </identifiers>
 * </response>
 */
const targetExtractionTemplate = `# Task: Extract Target and Source Information

# Recent Messages:
{{recentMessages}}

# Instructions:
Analyze the conversation to identify:
1. The target type (user or room)
2. The target platform/source (e.g. telegram, discord, etc)
3. Any identifying information about the target

Do NOT include any thinking, reasoning, or <think> sections in your response. 
Go directly to the XML response format without any preamble or explanation.

Return an XML response with:
<response>
  <targetType>user|room</targetType>
  <source>platform-name</source>
  <identifiers>
    <username>username_if_applicable</username>
    <roomName>room_name_if_applicable</roomName>
  </identifiers>
</response>

Example outputs:
1. For "send a message to @dev_guru on telegram":
<response>
  <targetType>user</targetType>
  <source>telegram</source>
  <identifiers>
    <username>dev_guru</username>
  </identifiers>
</response>

2. For "post this in #announcements":
<response>
  <targetType>room</targetType>
  <source>discord</source>
  <identifiers>
    <roomName>announcements</roomName>
  </identifiers>
</response>

IMPORTANT: Your response must ONLY contain the <response></response> XML block above. Do not include any text, thinking, or reasoning before or after this XML block. Start your response immediately with <response> and end with </response>.`;

/**
 * Create an error ActionResult with consistent structure.
 */
function createErrorResult(
  text: string,
  errorCode: string,
  additionalValues?: Record<string, unknown>,
  error?: Error
): ActionResult {
  return {
    text,
    values: {
      success: false,
      error: errorCode,
      ...additionalValues,
    },
    data: {
      actionName: 'SEND_MESSAGE',
      error: text,
      ...additionalValues,
    },
    success: false,
    error,
  };
}

/**
 * Create a success ActionResult with consistent structure.
 */
function createSuccessResult(
  text: string,
  additionalValues: Record<string, unknown>,
  additionalData: Record<string, unknown>
): ActionResult {
  return {
    text,
    values: {
      success: true,
      ...additionalValues,
    },
    data: {
      actionName: 'SEND_MESSAGE',
      ...additionalData,
    },
    success: true,
  };
}

/**
 * Represents an action to send a message to a user or room.
 *
 * @typedef {Action} sendMessageAction
 * @property {string} name - The name of the action.
 * @property {string[]} similes - Additional names for the action.
 * @property {string} description - Description of the action.
 * @property {function} validate - Asynchronous function to validate if the action can be executed.
 * @property {function} handler - Asynchronous function to handle the action execution.
 * @property {ActionExample[][]} examples - Examples demonstrating the usage of the action.
 */
export const sendMessageAction: Action = {
  name: 'SEND_MESSAGE',
  similes: ['DM', 'MESSAGE', 'SEND_DM', 'POST_MESSAGE'],
  description: 'Send a message to a user or room (other than the current one)',

  validate: async (runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    // Check if we have permission to send messages
    const worldId = message.roomId;
    const agentId = runtime.agentId;

    // Get all components for the current room to understand available sources
    const roomComponents = await runtime.getComponents(message.roomId, worldId, agentId);

    // Get source types from room components
    const availableSources = new Set(roomComponents.map((c) => c.type));

    // Also check for messaging-capable services registered by plugins
    const messagingServices = getAvailableMessageSources(runtime);
    for (const service of messagingServices) {
      availableSources.add(service);
    }

    return availableSources.size > 0;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
    responses?: Memory[]
  ): Promise<ActionResult> => {
    if (!state) {
      logger.error(
        { src: 'plugin:bootstrap:action:send_message', agentId: runtime.agentId },
        'State is required for sendMessage action'
      );
      return createErrorResult(
        'State is required for sendMessage action',
        'STATE_REQUIRED',
        undefined,
        new Error('State is required for sendMessage action')
      );
    }

    if (!callback) {
      logger.error(
        { src: 'plugin:bootstrap:action:send_message', agentId: runtime.agentId },
        'Callback is required for sendMessage action'
      );
      return createErrorResult(
        'Callback is required for sendMessage action',
        'CALLBACK_REQUIRED',
        undefined,
        new Error('Callback is required for sendMessage action')
      );
    }

    if (!responses) {
      logger.error(
        { src: 'plugin:bootstrap:action:send_message', agentId: runtime.agentId },
        'Responses are required for sendMessage action'
      );
      return createErrorResult(
        'Responses are required for sendMessage action',
        'RESPONSES_REQUIRED',
        undefined,
        new Error('Responses are required for sendMessage action')
      );
    }

    // Handle initial responses
    for (const response of responses) {
      await callback(response.content);
    }

    const sourceEntityId = message.entityId;
    const room = state.data.room ?? (await runtime.getRoom(message.roomId));

    if (!room) {
      return createErrorResult('Could not find room', 'ROOM_NOT_FOUND');
    }

    const worldId = room.worldId;

    // Extract target and source information
    const targetPrompt = composePromptFromState({
      state,
      template: targetExtractionTemplate,
    });

    const targetResult = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt: targetPrompt,
      stopSequences: [],
    });

    const targetData = parseKeyValueXml<TargetExtractionResult>(targetResult);

    if (!targetData?.targetType || !targetData?.source) {
      await callback({
        text: "I couldn't determine where you want me to send the message. Could you please specify the target (user or room) and platform?",
        actions: ['SEND_MESSAGE_ERROR'],
        source: message.content.source,
      });
      return createErrorResult('Could not determine message target', 'TARGET_UNCLEAR', {
        targetType: targetData?.targetType,
        source: targetData?.source,
      });
    }

    const source = targetData.source.toLowerCase();

    if (targetData.targetType === 'user') {
      return await handleDirectMessage(
        runtime,
        message,
        state,
        callback,
        source,
        sourceEntityId,
        worldId
      );
    }

    if (targetData.targetType === 'room') {
      return await handleRoomMessage(
        runtime,
        message,
        callback,
        source,
        worldId,
        targetData.identifiers?.roomName
      );
    }

    // Should not reach here
    return createErrorResult('Unknown target type', 'UNKNOWN_TARGET_TYPE', {
      targetType: targetData.targetType,
    });
  },

  examples: [
    [
      {
        name: '{{name1}}',
        content: {
          text: "Send a message to @dev_guru on telegram saying 'Hello!'",
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: 'Message sent to dev_guru on telegram.',
          actions: ['SEND_MESSAGE'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: "Post 'Important announcement!' in #announcements",
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: 'Message sent to announcements.',
          actions: ['SEND_MESSAGE'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: "DM Jimmy and tell him 'Meeting at 3pm'",
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: 'Message sent to Jimmy.',
          actions: ['SEND_MESSAGE'],
        },
      },
    ],
  ] as ActionExample[][],
};

/**
 * Handle sending a direct message to a user.
 */
async function handleDirectMessage(
  runtime: IAgentRuntime,
  message: Memory,
  state: State,
  callback: HandlerCallback,
  source: string,
  sourceEntityId: string,
  worldId: string | undefined
): Promise<ActionResult> {
  // Try to find the target user entity
  const targetEntity = await findEntityByName(runtime, message, state);

  if (!targetEntity) {
    await callback({
      text: "I couldn't find the user you want me to send a message to. Could you please provide more details about who they are?",
      actions: ['SEND_MESSAGE_ERROR'],
      source: message.content.source,
    });
    return createErrorResult('Target user not found', 'USER_NOT_FOUND', {
      targetType: 'user',
      source,
    });
  }

  // Get the component for the specified source
  const userComponent = await runtime.getComponent(
    targetEntity.id,
    source,
    worldId,
    sourceEntityId
  );

  if (!userComponent) {
    await callback({
      text: `I couldn't find ${source} information for that user. Could you please provide their ${source} details?`,
      actions: ['SEND_MESSAGE_ERROR'],
      source: message.content.source,
    });
    return createErrorResult(`No ${source} information found for user`, 'COMPONENT_NOT_FOUND', {
      targetType: 'user',
      source,
      targetEntityId: targetEntity.id,
    });
  }

  const service = runtime.getService(source);

  if (!hasDirectMessageCapability(service)) {
    await callback({
      text: `The ${source} service doesn't support sending direct messages. Please check if the plugin is properly configured.`,
      actions: ['SEND_MESSAGE_ERROR'],
      source: message.content.source,
    });
    return createErrorResult('Message service not available', 'SERVICE_NOT_FOUND', {
      targetType: 'user',
      source,
    });
  }

  // Send the message using the appropriate client
  await service.sendDirectMessage(targetEntity.id, {
    text: message.content.text,
    source: message.content.source,
  });

  await callback({
    text: `Message sent to ${targetEntity.names[0]} on ${source}.`,
    actions: ['SEND_MESSAGE'],
    source: message.content.source,
  });

  return createSuccessResult(
    `Message sent to ${targetEntity.names[0]}`,
    {
      targetType: 'user',
      targetId: targetEntity.id,
      targetName: targetEntity.names[0],
      source,
      messageSent: true,
    },
    {
      targetType: 'user',
      targetId: targetEntity.id,
      targetName: targetEntity.names[0],
      source,
      messageContent: message.content.text,
    }
  );
}

/**
 * Handle sending a message to a room.
 */
async function handleRoomMessage(
  runtime: IAgentRuntime,
  message: Memory,
  callback: HandlerCallback,
  source: string,
  worldId: string | undefined,
  targetRoomName: string | undefined
): Promise<ActionResult> {
  if (!worldId) {
    return createErrorResult('Could not determine world for room lookup', 'NO_WORLD_ID');
  }

  const rooms = await runtime.getRooms(worldId);
  const targetRoom = rooms.find(
    (r) => r.name?.toLowerCase() === targetRoomName?.toLowerCase()
  );

  if (!targetRoom) {
    await callback({
      text: "I couldn't find the room you want me to send a message to. Could you please specify the exact room name?",
      actions: ['SEND_MESSAGE_ERROR'],
      source: message.content.source,
    });
    return createErrorResult('Target room not found', 'ROOM_NOT_FOUND', {
      targetType: 'room',
      roomName: targetRoomName,
      source,
    });
  }

  const service = runtime.getService(source);

  if (!hasRoomMessageCapability(service)) {
    await callback({
      text: `The ${source} service doesn't support sending room messages. Please check if the plugin is properly configured.`,
      actions: ['SEND_MESSAGE_ERROR'],
      source: message.content.source,
    });
    return createErrorResult('Room message service not available', 'SERVICE_NOT_FOUND', {
      targetType: 'room',
      source,
    });
  }

  // Send the message to the room
  await service.sendRoomMessage(targetRoom.id, {
    text: message.content.text,
    source: message.content.source,
  });

  await callback({
    text: `Message sent to ${targetRoom.name} on ${source}.`,
    actions: ['SEND_MESSAGE'],
    source: message.content.source,
  });

  return createSuccessResult(
    `Message sent to ${targetRoom.name}`,
    {
      targetType: 'room',
      targetId: targetRoom.id,
      targetName: targetRoom.name,
      source,
      messageSent: true,
    },
    {
      targetType: 'room',
      targetId: targetRoom.id,
      targetName: targetRoom.name,
      source,
      messageContent: message.content.text,
    }
  );
}

export default sendMessageAction;
