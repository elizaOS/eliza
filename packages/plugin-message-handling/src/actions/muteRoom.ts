import {
  type Action,
  type ActionExample,
  booleanFooter,
  composePromptFromState,
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type Memory,
  ModelType,
  type State,
  type ActionResult,
} from '@elizaos/core';

/**
 * Template string for deciding if the agent should mute a room and stop responding unless explicitly mentioned.
 *
 * @type {string}
 */
/**
 * Template for deciding if agent should mute a room and stop responding unless explicitly mentioned.
 *
 * @type {string}
 */
export const shouldMuteTemplate = `# Task: Decide if {{agentName}} should mute this room and stop responding unless explicitly mentioned.

{{recentMessages}}

Should {{agentName}} mute this room and stop responding unless explicitly mentioned?

Respond with YES if:
- The user is being aggressive, rude, or inappropriate
- The user has directly asked {{agentName}} to stop responding or be quiet
- {{agentName}}'s responses are not well-received or are annoying the user(s)

Otherwise, respond with NO.
${booleanFooter}`;

/**
 * Action for muting a room, ignoring all messages unless explicitly mentioned.
 * Only do this if explicitly asked to, or if you're annoying people.
 *
 * @name MUTE_ROOM
 * @type {Action}
 *
 * @property {string} name - The name of the action
 * @property {string[]} similes - Similar actions related to muting a room
 * @property {string} description - Description of the action
 * @property {Function} validate - Validation function to check if the room is not already muted
 * @property {Function} handler - Handler function to handle muting the room
 * @property {ActionExample[][]} examples - Examples of using the action
 */
export const muteRoomAction: Action = {
  name: 'MUTE_ROOM',
  similes: ['MUTE_CHAT', 'MUTE_CONVERSATION', 'MUTE_ROOM', 'MUTE_THREAD', 'MUTE_CHANNEL'],
  description:
    "Mutes a room, ignoring all messages unless explicitly mentioned. Only do this if explicitly asked to, or if you're annoying people.",
  validate: async (runtime: IAgentRuntime, message: Memory) => {
    const roomId = message.roomId;
    const roomState = await runtime.getParticipantUserState(roomId, runtime.agentId);
    return roomState !== 'MUTED';
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: { [key: string]: unknown },
    _callback?: HandlerCallback,
    _responses?: Memory[]
  ): Promise<ActionResult> => {
    if (!state) {
      logger.error('State is required for muting a room');
      throw new Error('State is required for muting a room');
    }

    async function _shouldMute(state: State): Promise<boolean> {
      const shouldMutePrompt = composePromptFromState({
        state,
        template: shouldMuteTemplate, // Define this template separately
      });

      const response = await runtime.useModel(ModelType.TEXT_SMALL, {
        runtime,
        prompt: shouldMutePrompt,
        stopSequences: [],
      });

      const cleanedResponse = response.trim().toLowerCase();

      // Handle various affirmative responses
      if (
        cleanedResponse === 'true' ||
        cleanedResponse === 'yes' ||
        cleanedResponse === 'y' ||
        cleanedResponse.includes('true') ||
        cleanedResponse.includes('yes')
      ) {
        await runtime.createMemory(
          {
            entityId: message.entityId,
            agentId: message.agentId,
            roomId: message.roomId,
            content: {
              source: message.content.source,
              thought: 'I will now mute this room',
              actions: ['MUTE_ROOM_STARTED'],
            },
            metadata: {
              type: 'MUTE_ROOM',
            },
          },
          'messages'
        );
        return true;
      }

      // Handle various negative responses
      if (
        cleanedResponse === 'false' ||
        cleanedResponse === 'no' ||
        cleanedResponse === 'n' ||
        cleanedResponse.includes('false') ||
        cleanedResponse.includes('no')
      ) {
        await runtime.createMemory(
          {
            entityId: message.entityId,
            agentId: message.agentId,
            roomId: message.roomId,
            content: {
              source: message.content.source,
              thought: 'I decided to not mute this room',
              actions: ['MUTE_ROOM_FAILED'],
            },
            metadata: {
              type: 'MUTE_ROOM',
            },
          },
          'messages'
        );
      }

      // Default to false if response is unclear
      logger.warn(`Unclear boolean response: ${response}, defaulting to false`);
      return false;
    }

    try {
      const shouldMute = await _shouldMute(state);
      const room = state.data.room ?? (await runtime.getRoom(message.roomId));

      let muteSuccess = false;
      let errorMessage = '';

      if (shouldMute) {
        try {
          await runtime.setParticipantUserState(message.roomId, runtime.agentId, 'MUTED');
          muteSuccess = true;
        } catch (error) {
          logger.error('Failed to mute room:', error);
          errorMessage = error instanceof Error ? error.message : 'Failed to mute room';
          muteSuccess = false;
        }
      }

      // Create memory for action result
      await runtime.createMemory(
        {
          entityId: message.entityId,
          agentId: message.agentId,
          roomId: message.roomId,
          content: {
            thought: muteSuccess
              ? `I successfully muted the room ${room.name}`
              : shouldMute
                ? `I tried to mute the room ${room.name} but failed: ${errorMessage}`
                : `I decided not to mute the room ${room.name}`,
            actions: muteSuccess
              ? ['MUTE_ROOM_SUCCESS']
              : shouldMute
                ? ['MUTE_ROOM_FAILED']
                : ['MUTE_ROOM_DECLINED'],
          },
        },
        'messages'
      );

      // Return structured result for chaining
      return {
        data: {
          actionName: 'MUTE_ROOM',
          roomName: room.name,
          roomId: message.roomId,
          muted: muteSuccess,
          attempted: shouldMute,
          error: errorMessage || undefined,
        },
        values: {
          roomMuteState: muteSuccess ? 'MUTED' : 'NOT_MUTED',
          lastMuteTime: muteSuccess ? Date.now() : undefined,
          muteAttempted: shouldMute,
          muteSuccess: muteSuccess,
        },
        text: muteSuccess
          ? `Room ${room.name} has been muted`
          : shouldMute
            ? `Failed to mute room ${room.name}: ${errorMessage}`
            : `Room ${room.name} was not muted`,
      };
    } catch (error) {
      logger.error('Error in mute room handler:', error);
      return {
        data: {
          actionName: 'MUTE_ROOM',
          error: error instanceof Error ? error.message : String(error),
        },
        values: {
          muteAttempted: false,
          muteSuccess: false,
        },
        text: `Error while processing mute request: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  },
  examples: [
    // Example 1: Mute and confirm
    [
      {
        name: '{{name1}}',
        content: {
          text: '{{name3}}, please mute this channel and let me know when done.',
        },
      },
      {
        name: '{{name3}}',
        content: {
          text: "I'll mute this channel and only respond when directly mentioned from now on.",
          actions: ['MUTE_ROOM', 'REPLY'],
        },
      },
    ],
    // Example 2: Mute with explanation
    [
      {
        name: '{{name1}}',
        content: {
          text: '{{name3}}, please mute this channel for the time being',
        },
      },
      {
        name: '{{name3}}',
        content: {
          text: "I'll mute this channel and stay quiet unless you need me.",
          actions: ['MUTE_ROOM', 'REPLY'],
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: 'Hey what do you think about this new design',
        },
      },
      {
        name: '{{name3}}',
        content: {
          text: '',
          actions: ['IGNORE'],
        },
      },
    ],
    // Example 3: Failed mute attempt
    [
      {
        name: '{{name1}}',
        content: {
          text: '{{name2}} plz mute this private channel',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: "I'll try to mute this private channel and stop responding here.",
          actions: ['MUTE_ROOM', 'REPLY'],
        },
      },
    ],
    // Example 4: Mute after being annoying
    [
      {
        name: '{{name1}}',
        content: {
          text: 'too many messages here {{name2}}',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: "Sorry about that! I'll mute this channel now.",
          actions: ['MUTE_ROOM', 'REPLY'],
        },
      },
    ],
    // Example 5: Quick mute acknowledgment
    [
      {
        name: '{{name1}}',
        content: {
          text: 'yo {{name2}} dont talk in here',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: "Got it, I'll mute this channel.",
          actions: ['MUTE_ROOM', 'REPLY'],
        },
      },
    ],
    // Example 6: Mute with follow-up action
    [
      {
        name: '{{name1}}',
        content: {
          text: '{{name3}} mute this room and update the room settings',
        },
      },
      {
        name: '{{name3}}',
        content: {
          text: 'I will mute this room and update the room settings',
          actions: ['MUTE_ROOM', 'REPLY'],
        },
      },
    ],
  ] as ActionExample[][],
} as Action;
