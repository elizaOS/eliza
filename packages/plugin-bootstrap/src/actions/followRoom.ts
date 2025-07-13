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
 * Template for deciding if {{agentName}} should start following a room.
 * The decision is based on various criteria, including recent messages and user interactions.
 * Respond with YES if:
 * - The user has directly asked {{agentName}} to follow the conversation
 * - The conversation topic is engaging and {{agentName}}'s input would add value
 * - {{agentName}} has unique insights to contribute and users seem receptive
 * Otherwise, respond with NO.
 */
/**
 * Template for determining if the agent should start following a room
 * @type {string}
 */
export const shouldFollowTemplate = `# Task: Decide if {{agentName}} should start following this room, i.e. eagerly participating without explicit mentions.

{{recentMessages}}

Should {{agentName}} start following this room, eagerly participating without explicit mentions?
Respond with YES if:
- The user has directly asked {{agentName}} to follow the conversation or participate more actively
- The conversation topic is highly engaging and {{agentName}}'s input would add significant value
- {{agentName}} has unique insights to contribute and the users seem receptive

Otherwise, respond with NO.
${booleanFooter}`;

/**
 * Action for following a room with great interest.
 * Similes: FOLLOW_CHAT, FOLLOW_CHANNEL, FOLLOW_CONVERSATION, FOLLOW_THREAD
 * Description: Start following this channel with great interest, chiming in without needing to be explicitly mentioned. Only do this if explicitly asked to.
 * @param {IAgentRuntime} runtime - The current agent runtime.
 * @param {Memory} message - The message memory.
 * @returns {Promise<boolean>} - Promise that resolves to a boolean indicating if the room should be followed.
 */
export const followRoomAction: Action = {
  name: 'FOLLOW_ROOM',
  similes: ['FOLLOW_CHAT', 'FOLLOW_CHANNEL', 'FOLLOW_CONVERSATION', 'FOLLOW_THREAD'],
  description:
    'Start following this channel with great interest, chiming in without needing to be explicitly mentioned. Only do this if explicitly asked to.',
  validate: async (runtime: IAgentRuntime, message: Memory) => {
    const keywords = ['follow', 'participate', 'engage', 'listen', 'take interest', 'join'];
    if (!keywords.some((keyword) => message.content.text?.toLowerCase().includes(keyword))) {
      return false;
    }
    const roomId = message.roomId;
    const roomState = await runtime.getParticipantUserState(roomId, runtime.agentId);
    return roomState !== 'FOLLOWED' && roomState !== 'MUTED';
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
      logger.error('State is required for followRoomAction');
      return {
        text: 'State is required for follow room action',
        values: {
          success: false,
          error: 'STATE_REQUIRED',
        },
        data: {
          actionName: 'FOLLOW_ROOM',
          error: 'State is required',
        },
        success: false,
        error: new Error('State is required for followRoomAction'),
      };
    }

    async function _shouldFollow(state: State): Promise<boolean> {
      const shouldFollowPrompt = composePromptFromState({
        state,
        template: shouldFollowTemplate, // Define this template separately
      });

      const response = await runtime.useModel(ModelType.TEXT_SMALL, {
        runtime,
        prompt: shouldFollowPrompt,
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
              thought: 'I will now follow this room and chime in',
              actions: ['FOLLOW_ROOM_STARTED'],
            },
            metadata: {
              type: 'FOLLOW_ROOM',
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
              thought: 'I decided to not follow this room',
              actions: ['FOLLOW_ROOM_FAILED'],
            },
            metadata: {
              type: 'FOLLOW_ROOM',
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

    const shouldFollow = await _shouldFollow(state);
    const room = state.data.room ?? (await runtime.getRoom(message.roomId));

    if (shouldFollow) {
      try {
        await runtime.setParticipantUserState(message.roomId, runtime.agentId, 'FOLLOWED');

        await runtime.createMemory(
          {
            entityId: message.entityId,
            agentId: message.agentId,
            roomId: message.roomId,
            content: {
              thought: `I followed the room ${room.name}`,
              actions: ['FOLLOW_ROOM_START'],
            },
          },
          'messages'
        );

        return {
          text: `Now following room: ${room.name}`,
          values: {
            success: true,
            roomFollowed: true,
            roomId: message.roomId,
            roomName: room.name,
            newState: 'FOLLOWED',
          },
          data: {
            actionName: 'FOLLOW_ROOM',
            roomId: message.roomId,
            roomName: room.name,
            followed: true,
          },
          success: true,
        };
      } catch (error) {
        logger.error('Error following room:', error);
        return {
          text: 'Failed to follow room',
          values: {
            success: false,
            error: 'FOLLOW_FAILED',
          },
          data: {
            actionName: 'FOLLOW_ROOM',
            error: error instanceof Error ? error.message : String(error),
            roomId: message.roomId,
          },
          success: false,
          error: error instanceof Error ? error : new Error(String(error)),
        };
      }
    } else {
      return {
        text: `Decided not to follow room: ${room.name}`,
        values: {
          success: true,
          roomFollowed: false,
          roomId: message.roomId,
          roomName: room.name,
          reason: 'NOT_APPROPRIATE',
        },
        data: {
          actionName: 'FOLLOW_ROOM',
          roomId: message.roomId,
          roomName: room.name,
          followed: false,
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
          text: 'hey {{name2}} follow this channel',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: 'Sure, I will now follow this room and chime in',
          actions: ['FOLLOW_ROOM'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: '{{name3}}, please start participating in discussions in this channel',
        },
      },
      {
        name: '{{name3}}',
        content: {
          text: 'Got it',
          actions: ['FOLLOW_ROOM'],
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: "I'm struggling with the new database migration",
        },
      },
      {
        name: '{{name3}}',
        content: {
          text: 'well you did back up your data first right',
        },
      },
    ],
    [
      {
        name: '{{name2}}',
        content: {
          text: 'yeah i like your idea',
        },
      },
      {
        name: '{{name1}}',
        content: {
          text: 'hey {{name3}} can you follow this convo',
        },
      },
      {
        name: '{{name3}}',
        content: {
          text: "Sure thing, I'm on it",
          actions: ['FOLLOW_ROOM'],
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: 'actually, unfollow it',
        },
      },
      {
        name: '{{name3}}',
        content: {
          text: 'Haha, okay no problem',
          actions: ['UNFOLLOW_ROOM'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: '{{name2}} stay in this chat pls',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: "you got it, i'm here",
          actions: ['FOLLOW_ROOM'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'FOLLOW THIS CHAT {{name3}}',
        },
      },
      {
        name: '{{name3}}',
        content: {
          text: "I'M ON IT",
          actions: ['FOLLOW_ROOM'],
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: 'CAKE SHORTAGE ANYONE',
        },
      },
      {
        name: '{{name3}}',
        content: {
          text: "WHAT WHERE'S THE CAKE AT",
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: '{{name2}} folo this covo',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: "kk i'm following",
          actions: ['FOLLOW_ROOM'],
        },
      },
    ],
    [
      {
        name: '{{name2}}',
        content: {
          text: 'Do machines have consciousness',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: 'Deep question, no clear answer yet',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: 'Depends on how we define consciousness',
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: '{{name2}}, monitor this convo please',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: 'On it',
          actions: ['FOLLOW_ROOM'],
        },
      },
      {
        name: '{{name1}}',
        content: {
          text: 'Please engage in our discussion {{name2}}',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: "Gladly, I'm here to participate",
          actions: ['FOLLOW_ROOM'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'PLS follow this convo {{name3}}',
        },
      },
      {
        name: '{{name3}}',
        content: {
          text: "I'm in, let's do this",
          actions: ['FOLLOW_ROOM'],
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: 'I LIKE TURTLES',
        },
      },
    ],
    [
      {
        name: '{{name2}}',
        content: {
          text: 'beach day tmrw who down',
        },
      },
      {
        name: '{{name3}}',
        content: {
          text: 'wish i could but gotta work',
        },
      },
      {
        name: '{{name1}}',
        content: {
          text: 'hey {{name3}} follow this chat',
        },
      },
      {
        name: '{{name3}}',
        content: {
          text: 'sure',
          actions: ['FOLLOW_ROOM'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: '{{name3}}, partake in our discourse henceforth',
        },
      },
      {
        name: '{{name3}}',
        content: {
          text: 'I shall eagerly engage, good sir',
          actions: ['FOLLOW_ROOM'],
        },
      },
    ],
    [
      {
        name: '{{name2}}',
        content: {
          text: 'wuts ur fav clr',
        },
      },
      {
        name: '{{name3}}',
        content: {
          text: 'blu cuz calmmm',
        },
      },
      {
        name: '{{name1}}',
        content: {
          text: 'hey respond to everything in this channel {{name3}}',
        },
      },
      {
        name: '{{name3}}',
        content: {
          text: 'k',
          actions: ['FOLLOW_ROOM'],
        },
      },
    ],
  ] as ActionExample[][],
} as Action;
