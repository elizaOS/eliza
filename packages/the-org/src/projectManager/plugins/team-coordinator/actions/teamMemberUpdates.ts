import {
  type Action,
  type Content,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type UUID,
  type MemoryMetadata,
  MemoryType,
  createUniqueUuid,
  logger,
  asUUID,
  type Service,
  ModelType,
} from '@elizaos/core';
import type { TeamMemberUpdate } from '../../../types';

// Define a simple interface for the Discord service
interface IDiscordService extends Service {
  client: {
    users: {
      fetch: (userId: string) => Promise<{
        username: string;
        id: string;
      }>;
    };
    guilds: {
      cache: Map<
        string,
        {
          name: string;
          id: string;
          channels: {
            fetch: () => Promise<{
              find: (
                predicate: (channel: Record<string, unknown>) => boolean
              ) => Record<string, unknown> | undefined;
            }>;
          };
        }
      >;
    };
  };
}

/**
 * Posts team member update to the configured Discord channel for the server
 */
async function postUpdateToDiscordChannel(
  runtime: IAgentRuntime,
  update: TeamMemberUpdate
): Promise<boolean> {
  try {
    logger.info('=== POST TEAM MEMBER UPDATE TO DISCORD START ===');

    // Get the Discord service
    const discordService = runtime.getService('discord') as IDiscordService | null;
    if (!discordService) {
      logger.error('Discord service not available');
      return false;
    }

    logger.info('Discord service retrieved successfully');

    // Get report channel config
    const roomId = createUniqueUuid(runtime, 'report-channel-config');
    logger.info('Generated roomId for config:', roomId);

    const memories = await runtime.getMemories({
      roomId: roomId as UUID,
      tableName: 'messages',
    });

    logger.info('Retrieved report channel configs:', {
      count: memories.length,
      configs: memories.map((m) => ({
        type: m.content?.type,
        channelId: m.content?.config?.channelId,
      })),
    });

    // TODO : fetch server id of channel id

    // Get all guilds/servers
    const guilds = discordService.client.guilds.cache;
    logger.info(`Found ${guilds.size} Discord servers`);

    // Find the guild that matches the server name exactly
    let targetGuild = null;
    for (const guild of guilds.values()) {
      logger.info(`Checking guild: ${guild.name} against update server name: ${update.serverName}`);
      if (guild.name === update.serverName) {
        targetGuild = guild;
        logger.info(`Found matching guild: ${guild.name} with ID: ${guild.id}`);
        break;
      }
    }

    if (!targetGuild) {
      logger.warn(`Could not find Discord server matching exact name: ${update.serverName}`);
      return false;
    }

    // Find config for this server
    const config = memories.find((memory) => {
      const serverMatch = targetGuild?.id;
      logger.info(`Checking config:`, {
        configType: memory.content?.type,
        configServerId: memory.content?.config?.serverId,
        targetGuildId: targetGuild?.id,
        matches: serverMatch,
      });
      return memory.content?.type === 'report-channel-config' && serverMatch;
    });

    if (!config) {
      logger.warn(
        `No report channel config found for server: ${targetGuild.name} (${targetGuild.id})`
      );
      return false;
    }

    logger.info('Found report channel config:', {
      configId: config.id,
      configType: config.content?.type,
      configServerId: targetGuild?.id,
      configChannelId: config.content?.config?.channelId,
    });

    const channelId = config.content?.config?.channelId;
    if (!channelId) {
      logger.warn('No channel ID in config');
      return false;
    }

    // Format the update message with all answers from the stringified JSON
    const formattedDate = new Date(update.timestamp).toLocaleString();
    logger.info('Formatting update message with timestamp:', {
      timestamp: update.timestamp,
      formatted: formattedDate,
    });

    let updateMessage = `## Team Member Update
**Team Member**: ${update.teamMemberName || 'Unknown'} (${update.teamMemberId})
**Server-name**: ${update.serverName}
**Check-in Type**: ${update.checkInType}
**Timestamp**: ${formattedDate}`;

    // Parse the stringified answers and add them to the message
    try {
      const answers = JSON.parse(update.answers || '{}');

      if (Object.keys(answers).length > 0) {
        updateMessage += '\n\n**Update Details**:';

        for (const [question, answer] of Object.entries(answers)) {
          updateMessage += `\n**${question}**: ${answer}`;
        }
      }
    } catch (error) {
      logger.error('Error parsing answers JSON:', error);
      updateMessage += '\n\n**Update Details**: Error parsing update details';
    }

    logger.info('Formatted update message:', { messageLength: updateMessage.length });

    // Get Discord client
    const client = discordService.client;
    if (!client) {
      logger.error('Discord client not available');
      return false;
    }

    // Find the configured channel in the target guild
    logger.info(`Searching for channel ${channelId} in server: ${targetGuild.name}`);
    const channels = await targetGuild.channels.fetch();

    const targetChannel = channels.find((ch) => {
      return ch && typeof ch === 'object' && 'id' in ch && ch.id === channelId;
    });

    if (!targetChannel) {
      logger.warn(
        `Could not find Discord channel with ID ${channelId} in server ${targetGuild.name}`
      );
      return false;
    }

    // Send the message
    logger.info('Attempting to send update to Discord channel');
    await (
      targetChannel as Record<string, unknown> & { send: (content: string) => Promise<unknown> }
    ).send(updateMessage);

    logger.info('Successfully sent team member update to Discord');
    logger.info('=== POST TEAM MEMBER UPDATE TO DISCORD END ===');
    return true;
  } catch (error) {
    logger.error('=== POST TEAM MEMBER UPDATE TO DISCORD ERROR ===');
    logger.error('Error details:', {
      name: error.name,
      message: error.message,
      stack: error.stack,
    });
    return false;
  }
}

async function storeTeamMemberUpdate(
  runtime: IAgentRuntime,
  update: TeamMemberUpdate
): Promise<boolean> {
  try {
    logger.info('=== STORE TEAM MEMBER UPDATE START ===');
    logger.info('Storing update for team member:', {
      teamMemberId: update.teamMemberId,
      updateId: update.updateId,
      timestamp: update.timestamp,
    });

    // Use the existing room ID from the message instead of creating a new one
    // This resolves the foreign key constraint error
    const roomId = update.channelId;
    logger.info(`Using existing room ID: ${roomId}`);

    if (!roomId) {
      logger.error('No room ID available for storing the update');
      return false;
    }

    // Store the update in memory
    logger.info('Attempting to store update in memory...');
    const memory: Memory = {
      id: createUniqueUuid(runtime, `team-update-${Date.now()}`),
      agentId: runtime.agentId,
      roomId: roomId,
      entityId: asUUID(update.teamMemberId),
      content: {
        type: 'team-member-update',
        update,
      },
      metadata: {
        type: MemoryType.CUSTOM,
        timestamp: Date.now(),
      },
    };

    await runtime.createMemory(memory, 'messages');

    logger.info('Successfully stored team member update');
    logger.info('=== STORE TEAM MEMBER UPDATE END ===');
    return true;
  } catch (error) {
    logger.error('=== STORE TEAM MEMBER UPDATE ERROR ===');
    logger.error('Error details:', {
      name: error.name,
      message: error.message,
      stack: error.stack,
    });
    return false;
  }
}

async function parseTeamMemberUpdate(
  runtime: IAgentRuntime,
  message: Memory
): Promise<TeamMemberUpdate | null> {
  try {
    logger.info('=== PARSE TEAM MEMBER UPDATE START ===');
    logger.info('Parsing update from message:', {
      messageId: message.id,
      entityId: message.entityId,
    });

    const text = message.content?.text as string;
    if (!text) {
      logger.warn('No text content found in message');
      return null;
    }

    // Use AI to parse the update text with a more flexible approach
    const prompt = `Extract information from this team member update. The update will likely end with "sending my updates".

    Parse the text and return a JSON object with these fields:
    {
      "serverName": "value", // Name of the server
      "checkInType": "value", // Type of check-in (could be STANDUP, SPRINT, MENTAL_HEALTH, PROJECT_STATUS, RETRO, or something else)
      "answers": { // Dynamic field with key-value pairs for all questions and answers found
        "questionText1": "answerText1",
        "questionText2": "answerText2"
        // Any other key-value pairs detected in the format
      }
    }

    For the "answers" field, extract any key-value pairs that look like questions and answers in the text.
    Include ALL information from the update in the answers object.

    Text to parse: "${text}"`;

    logger.info('Sending text to AI for parsing');
    logger.info('Prompt:', prompt);

    const parsedResponse = await runtime.useModel(ModelType.TEXT_LARGE, {
      prompt,
      stopSequences: [],
    });

    logger.info('Raw AI response:', parsedResponse);

    let parsedData;
    try {
      // Remove any backticks or markdown formatting that might be in the response
      const cleanedResponse = parsedResponse.replace(/```json\n?|\n?```/g, '').trim();
      parsedData = JSON.parse(cleanedResponse);
      logger.info('Successfully parsed fields from AI response:', parsedData);
    } catch (error) {
      logger.error('Failed to parse AI response as JSON:', error);
      logger.error('Raw response that failed parsing:', parsedResponse);
      throw new Error('PARSING_ERROR: AI response was not valid JSON');
    }

    // Validate minimal required fields
    if (!parsedData.serverName || !parsedData.checkInType) {
      logger.warn('Missing required basic fields:', {
        hasServerName: !!parsedData.serverName,
        hasCheckInType: !!parsedData.checkInType,
      });
      throw new Error(`MISSING_FIELDS:serverName,checkInType`);
    }

    // Ensure we have at least some answers
    if (!parsedData.answers || Object.keys(parsedData.answers).length === 0) {
      logger.warn('No answers were parsed from the update');
      throw new Error('MISSING_FIELDS:answers');
    }

    // Get the user name from Discord or Telegram
    const entityById = await runtime.getEntityById(message.entityId);
    const userName =
      entityById?.metadata?.discord?.userName || entityById?.metadata?.telegram?.name;

    // Create the update object with the dynamic answers field only
    const update: TeamMemberUpdate = {
      type: 'team-member-update',
      updateId: createUniqueUuid(runtime, 'team-update'),
      teamMemberId: message.entityId || asUUID('unknown'),
      teamMemberName: userName,
      serverName: parsedData.serverName,
      checkInType: parsedData.checkInType,
      timestamp: new Date().toISOString(),
      channelId: message.roomId,
      answers: JSON.stringify(parsedData.answers),
    };

    logger.info('Successfully parsed team member update:', update);
    logger.info('=== PARSE TEAM MEMBER UPDATE END ===');
    return update;
  } catch (error) {
    logger.error('=== PARSE TEAM MEMBER UPDATE ERROR ===');
    logger.error('Error details:', {
      name: error.name,
      message: error.message,
      stack: error.stack,
    });
    throw error; // Propagate the error to handle it in the handler
  }
}

export const teamMemberUpdatesAction: Action = {
  name: 'TEAM_MEMBER_UPDATES',
  description:
    'Records individual status updates from team members including progress details, blockers, and estimated completion times',
  similes: [
    'SEND_PERSONAL_UPDATE',
    'SUBMIT_UPDATE',
    'SHARE_PROGRESS',
    'REPORT_STATUS',
    'LOG_TEAM_UPDATE',
  ],
  validate: async (runtime: IAgentRuntime, message: Memory) => {
    return true;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: Record<string, unknown>,
    context: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<boolean> => {
    try {
      logger.info('=== RECORD TEAM MEMBER UPDATES HANDLER START ===');
      logger.info('Handler details:', {
        messageId: message.id,
        entityId: message.entityId,
        hasCallback: !!callback,
        stateKeys: Object.keys(state),
        contextKeys: Object.keys(context),
      });
      logger.info('Processing message:', {
        id: message.id,
        content: JSON.stringify(message.content),
        entityId: message.entityId,
        roomId: message.roomId,
        timestamp: message.metadata?.timestamp,
        text: message.content?.text,
        type: message.content?.type,
        metadata: JSON.stringify(message.metadata),
        fullMessage: JSON.stringify(message),
      });

      if (!callback) {
        logger.warn('No callback function provided');
        return false;
      }

      // Parse the update from the message
      try {
        const update = await parseTeamMemberUpdate(runtime, message);
        if (!update) {
          const template = `Please provide your update using the following format:

Server-name: [server name]
Check-in Type: [daily/weekly/sprint]
Current Progress: [what you've completed]
Next Steps: [upcoming tasks]
Blockers: [any blockers or "none"]

End your message with "sending my updates"`;

          await callback(
            {
              text: `❌ I was unable to process your update. ${template}`,
              source: 'discord',
            },
            []
          );
          return false;
        }

        // Store the update in memory
        const stored = await storeTeamMemberUpdate(runtime, update);
        if (!stored) {
          logger.error('Failed to store team member update');
          await callback(
            {
              text: '❌ There was an error storing your update. Please try again later.',
              source: 'discord',
            },
            []
          );
          return false;
        }

        // Post update to configured Discord channel
        const posted = await postUpdateToDiscordChannel(runtime, update);
        if (posted) {
          logger.info('Successfully posted team member update to Discord');
        } else {
          logger.warn('Could not post update to Discord, but continuing with normal flow');
        }

        // Send confirmation
        const content: Content = {
          text: `✅ Thanks for your update! I've recorded your progress details.${posted ? ' Your update has been posted to the configured channel.' : ''}`,
          source: 'discord',
        };

        logger.info('Sending confirmation to user');
        await callback(content, []);
        logger.info('Successfully recorded team member update');
        logger.info('=== RECORD TEAM MEMBER UPDATES HANDLER END ===');
        return true;
      } catch (error) {
        if (error.message.startsWith('MISSING_FIELDS:')) {
          const missingFields = error.message.split(':')[1].split(',');
          const missingFieldsList = missingFields.join(', ');

          await callback(
            {
              text: `❌ Your update is missing the following required fields: ${missingFieldsList}\n\nPlease include all required fields and try again:
• Server-name
• Check-in Type
• Current Progress
• Next Steps
• Blockers

Remember to end your message with "sending my updates"`,
              source: 'discord',
            },
            []
          );
          return false;
        }

        // Handle other errors
        logger.error('Unexpected error:', error);
        await callback(
          {
            text: '❌ An error occurred while processing your update. Please try again.',
            source: 'discord',
          },
          []
        );
        return false;
      }
    } catch (error) {
      logger.error('=== RECORD TEAM MEMBER UPDATES HANDLER ERROR ===');
      logger.error('Error details:', {
        name: error.name,
        message: error.message,
        stack: error.stack,
      });

      if (callback) {
        await callback(
          {
            text: '❌ An error occurred while processing your update. Please try again.',
            source: 'discord',
          },
          []
        );
      }
      return false;
    }
  },
  examples: [
    [
      {
        name: '{{name1}}',
        content: {
          text: `Server-name: Development Server
Check-in Type: Daily
What did you get done this week? Completed the API integration and fixed authentication bugs
Main Priority for next week: Deploy to staging environment and start beta testing
Blockers: None at the moment
Team morale: High, everyone is collaborating well

sending my updates`,
        },
      },
      {
        name: '{{botName}}',
        content: {
          text: "✅ Thank you for your update! I've recorded your progress details and will share them with the team.",
          actions: ['TEAM_MEMBER_UPDATES'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: `Server-name: Project X Server
Check-in Type: SPRINT
Progress: Fixed 3 critical bugs in the frontend
Next task: Code review and documentation
Roadblocks: Waiting on design assets from the design team
Estimated completion: End of next week

sending my updates`,
        },
      },
      {
        name: '{{botName}}',
        content: {
          text: '✅ Your status has been logged successfully. I will make sure the team is aware of your progress and blockers.',
          actions: ['TEAM_MEMBER_UPDATES'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: `Server-name: Engineering Team
Check-in Type: STANDUP
Weekly achievements: Implemented user authentication API and completed unit tests
Focus areas: Begin frontend integration
Technical challenges: Dependency issues with auth library
Questions for team: Do we need to support SSO for the initial release?

sending my updates`,
        },
      },
      {
        name: '{{botName}}',
        content: {
          text: '✅ Status recorded! Your individual work update has been saved and will be included in the next team report.',
          actions: ['TEAM_MEMBER_UPDATES'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: `Server-name: Product Development
Check-in Type: PROJECT_STATUS
Current state: Completed feature specification documents
Next milestone: Schedule technical planning session
Anticipated Launch Date: Q3 2023
Blockers: Resource allocation pending approval
Budget status: Within projections

sending my updates`,
        },
      },
      {
        name: '{{botName}}',
        content: {
          text: "✅ Your individual status has been logged. I've noted your blockers regarding resource allocation approval.",
          actions: ['TEAM_MEMBER_UPDATES'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: `Server-name: Marketing Team
Check-in Type: WEEKLY
This week: Completed social media campaign designs
Next week: Start A/B testing different ad copy
Customer feedback: Very positive on new landing page
Conversion rate: Up 15% from last week

sending my updates`,
        },
      },
      {
        name: '{{botName}}',
        content: {
          text: "✅ Thanks for your detailed update! I've recorded all the information you provided.",
          actions: ['TEAM_MEMBER_UPDATES'],
        },
      },
    ],
  ],
};
