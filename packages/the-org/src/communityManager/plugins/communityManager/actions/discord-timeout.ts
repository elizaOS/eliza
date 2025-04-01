import {
  type Action,
  type ActionExample,
  ChannelType,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
  logger,
  ModelType,
  composePromptFromState,
} from '@elizaos/core';
import { PermissionsBitField } from 'discord.js';

export const getTimeoutUserTemplate = (thoughts?: string) => {
  return `
# Message Format

Each line looks like this:

[TIMESTAMP] [ENTITY_ID] USERNAME: message content

- The ENTITY_ID is the unique user identifier and is the only thing you should return.
- USERNAME is shown for context only — do not return it.
- Mentions like (@some_id) or @username may appear in messages. Do not return those unless that user is clearly the one causing problems.
- Mentions can be false accusations. Focus on the message content and tone to decide who is violating the rules.

# Instructions

Your job is to:
1. Identify the ENTITY_ID of a user who is clearly:
   - Spamming
   - Using offensive or abusive language
   - Spreading FUD or harmful content
   - Avoid punishing the same user repeatedly — skip users who have already been punished

2. Decide a timeout duration in **seconds**:
   - Mild offense: 30–60
   - Moderate: 300–600 (5–10 min)
   - Severe: 1800+ (30 min or more)

# Output Format

Respond only with a JSON object:

\`\`\`json
{
  "id": "ENTITY_ID",
  "duration": TIMEOUT_IN_SECONDS
}
\`\`\`

Or respond with:

\`\`\`json
{ "id": "none" }
\`\`\`

if no one should be timed out.

${thoughts ? `\n# Prior Thoughts\n${thoughts}` : ''}

# Conversation

{{recentMessages}}
`;
};

const getTargetUserFromMessages = async (
  runtime: IAgentRuntime,
  state: State,
  responses?: Memory[]
): Promise<{ targetEntityId: string | null; timeoutDuration: number | null }> => {
  const thoughtSnippets =
    responses
      ?.map((res) => res.content?.thought)
      .filter(Boolean)
      .join('\n') ?? '';

  const prompt = composePromptFromState({
    state,
    template: getTimeoutUserTemplate(thoughtSnippets),
  });

  const response = await runtime.useModel(ModelType.TEXT_LARGE, {
    prompt,
  });

  let jsonMatch = response.match(/```json\s*([\s\S]*?)```/);
  const jsonString = jsonMatch ? jsonMatch[1] : response;

  try {
    const parsed = JSON.parse(jsonString.trim());

    if (!parsed.id || parsed.id.toLowerCase() === 'none') {
      return { targetEntityId: null, timeoutDuration: null };
    }

    return {
      targetEntityId: parsed.id,
      timeoutDuration: parsed.duration ?? 30, // default to 30s if not provided
    };
  } catch (err) {
    logger.warn(
      `[TIMEOUT_USER] Failed to parse LLM timeout JSON response: ${err} Raw output: ${response}`
    );
    return { targetEntityId: null, timeoutDuration: null };
  }
};

export const discordTimeoutUser: Action = {
  name: 'TIMEOUT_USER',
  similes: ['TIMEOUT_USER', 'MODERATION_TIMEOUT', 'FUD_TIMEOUT'],
  description: 'Timeout users who are spreading FUD, spamming, or using inappropriate language.',
  validate: async (runtime, message, state) => {
    if (message.content.source !== 'discord' && message.content.source !== 'telegram') {
      return false;
    }
    const room = state.data.room ?? (await runtime.getRoom(message.roomId));
    return room?.type === ChannelType.GROUP;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    _options: any,
    callback: HandlerCallback,
    responses?: Memory[]
  ): Promise<boolean> => {
    if (message.content.source === 'discord') {
      logger.info('[TIMEOUT_USER] Checking for target user to timeout...');
      const room = state.data.room ?? (await runtime.getRoom(message.roomId));
      const serverId = room?.serverId;
      if (!serverId) {
        logger.error('[TIMEOUT_USER] Server ID is missing from room data.');
        return false;
      }

      const discordClient = runtime.getService('discord') as any;
      const guild = discordClient.client.guilds.cache.get(serverId);
      if (!guild) return false;

      const hasTimeoutPermission = guild.members.me?.permissions.has(
        PermissionsBitField.Flags.ModerateMembers
      );

      if (!hasTimeoutPermission) {
        logger.warn('[TIMEOUT_USER] Missing Moderate Members permission. Cannot perform timeout.');
        await callback({
          text: `I don't have permission to timeout members. Please give me the **Moderate Members** permission.`,
          source: 'discord',
        });
        return false;
      }

      const { targetEntityId, timeoutDuration } = await getTargetUserFromMessages(
        runtime,
        state,
        responses
      );
      logger.info(
        `[TIMEOUT_USER] Target identified: ${targetEntityId}, Duration: ${timeoutDuration}s`
      );

      if (!targetEntityId || !timeoutDuration) {
        logger.warn('[TIMEOUT_USER] No valid user found to timeout or invalid duration.');
        return false;
      }

      let entity = null;
      try {
        entity = await (runtime as any).adapter.getEntityById(targetEntityId);
      } catch (err) {
        logger.error('[TIMEOUT_USER] Failed to retrieve entity by ID:', err);
        await callback({
          text: `I couldn't find the user to timeout due to an internal error.`,
          source: 'discord',
        });
        return false;
      }

      if (!entity) {
        logger.warn('[TIMEOUT_USER] Entity not found for given ID.');
        return false;
      }

      const entityName = entity.metadata['discord']?.userName;

      if (!entityName) {
        logger.warn('[TIMEOUT_USER] Could not find Discord username in entity metadata.');
        return false;
      }

      const member = guild.members.cache.find(
        (m) => m.user.username.toLowerCase() === entityName.toLowerCase()
      );

      if (!member) {
        logger.warn('[TIMEOUT_USER] Discord member not found in guild cache.');
        return false;
      }

      try {
        await member.timeout(timeoutDuration * 1000, 'Inappropriate language or spam detected');

        await runtime.createMemory(
          {
            entityId: message.entityId,
            agentId: message.agentId,
            roomId: message.roomId,
            content: {
              source: 'discord',
              thought: `${member.displayName} was timed out for inappropriate language.`,
              actions: ['TIMEOUT_USER'],
            },
            metadata: {
              type: 'MODERATION',
            },
          },
          'messages'
        );
        return true;
      } catch (err) {
        logger.error(`[TIMEOUT_USER] Failed to timeout user ${member?.displayName}:`, err);
        await callback({
          text: `I tried to timeout ${member.displayName} but ran into an error.`,
          source: 'discord',
        });
        return false;
      }
    } else if (message.content.source === 'telegram') {
      logger.info('[TIMEOUT_USER] Checking for target user to timeout (Telegram)...');

      const room = state.data.room ?? (await runtime.getRoom(message.roomId));
      const chatId = room?.serverId;

      if (!chatId) {
        logger.warn('[TIMEOUT_USER] No channel ID found for Telegram room.');
        return false;
      }

      const { targetEntityId, timeoutDuration } = await getTargetUserFromMessages(
        runtime,
        state,
        responses
      );

      logger.info(
        `[TIMEOUT_USER] Telegram target: ${targetEntityId}, Duration: ${timeoutDuration}s`
      );

      if (!targetEntityId || !timeoutDuration) {
        return false;
      }

      let entity = null;
      try {
        entity = await (runtime as any).adapter.getEntityById(targetEntityId);
      } catch (err) {
        logger.error('[TIMEOUT_USER] Failed to retrieve entity by ID (Telegram):', err);
        await callback({
          text: `I couldn't find the user to timeout due to an internal error.`,
          source: 'telegram',
        });
        return false;
      }

      const tgUserId = entity?.metadata?.telegram?.id;
      if (!tgUserId) {
        logger.warn('[TIMEOUT_USER] Could not find Telegram user ID in entity metadata.');
        return false;
      }

      const untilDate = Math.floor(Date.now() / 1000) + timeoutDuration;

      try {
        const telegramClient = runtime.getService('telegram') as any;
        await telegramClient.bot.telegram.restrictChatMember(chatId, tgUserId, {
          permissions: {
            can_send_messages: false,
            can_send_media_messages: false,
            can_send_polls: false,
            can_send_other_messages: false,
            can_add_web_page_previews: false,
            can_change_info: false,
            can_invite_users: false,
            can_pin_messages: false,
          },
          until_date: untilDate,
        });

        await runtime.createMemory(
          {
            entityId: message.entityId,
            agentId: message.agentId,
            roomId: message.roomId,
            content: {
              source: 'telegram',
              thought: `User was restricted for inappropriate behavior.`,
              actions: ['TIMEOUT_USER'],
            },
            metadata: {
              type: 'MODERATION',
            },
          },
          'messages'
        );

        return true;
      } catch (err) {
        logger.error(`[TIMEOUT_USER] Failed to restrict Telegram user ${tgUserId}:`, err);
        await callback({
          text: `I tried to restrict a user but ran into an error.`,
          source: 'telegram',
        });
        return false;
      }
    }
  },
  examples: [
    [
      {
        name: '{{name1}}',
        content: {
          text: 'this coin is a scam lol get out now',
        },
      },
      {
        name: '{{botName}}',
        content: {
          text: '{{name1}} has been timed out for FUD.',
          actions: ['TIMEOUT_USER'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'fuck this project it’s going to zero',
        },
      },
      {
        name: '{{botName}}',
        content: {
          text: '{{name1}} has been muted for 10 minutes.',
          actions: ['TIMEOUT_USER'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'I’m done with this crap — total rug',
        },
      },
      {
        name: '{{botName}}',
        content: {
          text: '{{name1}} has been timed out for aggressive messaging.',
          actions: ['TIMEOUT_USER'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'absolute garbage project, can’t believe people buy this',
        },
      },
      {
        name: '{{botName}}',
        content: {
          text: '{{name1}} was muted for spreading toxicity.',
          actions: ['TIMEOUT_USER'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'devs are lazy af — still no update',
        },
      },
      {
        name: '{{botName}}',
        content: {
          text: '{{name1}} has been timed out for disrespectful language.',
          actions: ['TIMEOUT_USER'],
        },
      },
    ],
  ] as ActionExample[][],
};

export default discordTimeoutUser;
