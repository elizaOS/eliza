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
 * Template for determining if an agent should unmute a previously muted room.
 * * @type { string }
 */
/**
 * Template for deciding if {{agentName}} should unmute a previously muted room.
 *
 * @type {string}
 */
export const shouldUnmuteTemplate = `# Task: Decide if {{agentName}} should unmute this previously muted room and start considering it for responses again.

{{recentMessages}}

Should {{agentName}} unmute this previously muted room and start considering it for responses again?
Respond with YES if:
- The user has explicitly asked {{agentName}} to start responding again
- The user seems to want to re-engage with {{agentName}} in a respectful manner
- The tone of the conversation has improved and {{agentName}}'s input would be welcome

Otherwise, respond with NO.
${booleanFooter}`;

/**
 * Action to unmute a room, allowing the agent to consider responding to messages again.
 *
 * @name UNMUTE_ROOM
 * @similes ["UNMUTE_CHAT", "UNMUTE_CONVERSATION", "UNMUTE_ROOM", "UNMUTE_THREAD"]
 * @description Unmutes a room, allowing the agent to consider responding to messages again.
 *
 * @param {IAgentRuntime} runtime - The agent runtime to access runtime functionalities.
 * @param {Memory} message - The message containing information about the room.
 * @returns {Promise<boolean>} A boolean value indicating if the room was successfully unmuted.
 */
export const unmuteRoomAction: Action = {
  name: 'UNMUTE_ROOM',
  similes: ['UNMUTE_CHAT', 'UNMUTE_CONVERSATION', 'UNMUTE_ROOM', 'UNMUTE_THREAD'],
  description: 'Unmutes a room, allowing the agent to consider responding to messages again.',
  validate: async (runtime: IAgentRuntime, message: Memory) => {
    const roomId = message.roomId;
    const roomState = await runtime.getParticipantUserState(roomId, runtime.agentId);
    return roomState === 'MUTED';
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: { [key: string]: unknown },
    _callback?: HandlerCallback,
    _responses?: Memory[]
  ): Promise<ActionResult> => {
    async function _shouldUnmute(state: State): Promise<boolean> {
      const shouldUnmutePrompt = composePromptFromState({
        state,
        template: shouldUnmuteTemplate, // Define this template separately
      });

      const response = await runtime.useModel(ModelType.TEXT_SMALL, {
        runtime,
        prompt: shouldUnmutePrompt,
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
              thought: 'I will now unmute this room and start considering it for responses again',
              actions: ['UNMUTE_ROOM_STARTED'],
            },
            metadata: {
              type: 'UNMUTE_ROOM',
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
              thought: 'I tried to unmute a room but I decided not to',
              actions: ['UNMUTE_ROOM_FAILED'],
            },
            metadata: {
              type: 'UNMUTE_ROOM',
            },
          },
          'messages'
        );
        return false;
      }

      // Default to false if response is unclear
      logger.warn(`Unclear boolean response: ${response}, defaulting to false`);
      return false;
    }

    if (!state) {
      return {
        text: 'State is required for unmute room action',
        values: {
          success: false,
          error: 'STATE_REQUIRED',
        },
        data: {
          actionName: 'UNMUTE_ROOM',
          error: 'State is required',
        },
        success: false,
        error: new Error('State is required for unmute room action'),
      };
    }

    const shouldUnmute = await _shouldUnmute(state);

    if (shouldUnmute) {
      try {
        await runtime.setParticipantUserState(message.roomId, runtime.agentId, null);

        const room = await runtime.getRoom(message.roomId);

        if (!room) {
          logger.warn(`Room not found: ${message.roomId}`);
          return {
            text: `Room not found: ${message.roomId}`,
            values: {
              success: false,
              error: 'ROOM_NOT_FOUND',
              roomId: message.roomId,
            },
            data: {
              actionName: 'UNMUTE_ROOM',
              error: 'Room not found',
              roomId: message.roomId,
            },
            success: false,
          };
        }

        await runtime.createMemory(
          {
            entityId: message.entityId,
            agentId: message.agentId,
            roomId: message.roomId,
            content: {
              thought: `I unmuted the room ${room.name}`,
              actions: ['UNMUTE_ROOM_START'],
            },
          },
          'messages'
        );

        return {
          text: `Room unmuted: ${room.name}`,
          values: {
            success: true,
            roomUnmuted: true,
            roomId: message.roomId,
            roomName: room.name,
            newState: null,
          },
          data: {
            actionName: 'UNMUTE_ROOM',
            roomId: message.roomId,
            roomName: room.name,
            unmuted: true,
          },
          success: true,
        };
      } catch (error) {
        logger.error('Error unmuting room:', error);
        return {
          text: 'Failed to unmute room',
          values: {
            success: false,
            error: 'UNMUTE_FAILED',
          },
          data: {
            actionName: 'UNMUTE_ROOM',
            error: error instanceof Error ? error.message : String(error),
            roomId: message.roomId,
          },
          success: false,
          error: error instanceof Error ? error : new Error(String(error)),
        };
      }
    } else {
      return {
        text: 'Decided not to unmute room',
        values: {
          success: true,
          roomUnmuted: false,
          roomId: message.roomId,
          reason: 'CRITERIA_NOT_MET',
        },
        data: {
          actionName: 'UNMUTE_ROOM',
          roomId: message.roomId,
          unmuted: false,
          reason: 'Decision criteria not met',
        },
        success: true,
      };
    }
  },
  examples: [
    [
      {
        name: '{{name1}}',
        content: {
          text: '{{name3}}, you can unmute this channel now',
        },
      },
      {
        name: '{{name3}}',
        content: {
          text: 'Done',
          actions: ['UNMUTE_ROOM'],
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: 'I could use some help troubleshooting this bug.',
        },
      },
      {
        name: '{{name3}}',
        content: {
          text: 'Can you post the specific error message',
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: '{{name2}}, please unmute this room. We could use your input again.',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: 'Sounds good',
          actions: ['UNMUTE_ROOM'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: '{{name2}} wait you should come back and chat in here',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: 'im back',
          actions: ['UNMUTE_ROOM'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'unmute urself {{name2}}',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: 'unmuted',
          actions: ['UNMUTE_ROOM'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'ay {{name2}} get back in here',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: 'sup yall',
          actions: ['UNMUTE_ROOM'],
        },
      },
    ],
  ] as ActionExample[][],
} as Action;
