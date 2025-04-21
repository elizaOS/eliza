import {
  type Action,
  ChannelType,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  ModelType,
  type State,
  createUniqueUuid,
  type UUID,
  getUserServerRole,
  logger,
} from '@elizaos/core';

interface TeamMember {
  section: string;
  tgName?: string;
  discordName?: string;
  format: string;
  serverId: string;
  serverName?: string;
  createdAt: string;
  updatesFormat?: string[];
}

/**
 * Creates a consistent room ID for team members storage
 * @param serverId The server ID
 * @returns A consistent room ID string
 */
function getTeamMembersRoomId(runtime: IAgentRuntime, serverId: string): UUID {
  // Create a consistent hash based on serverId
  const serverHash = serverId.replace(/[^a-zA-Z0-9]/g, '').substring(0, 8);

  const roomId = createUniqueUuid(runtime, `team-members-${serverHash}`);

  return roomId;
}

/**
 * Fetches team members for a specific server from memory
 * @param runtime The agent runtime
 * @param serverId The ID of the server to fetch team members for
 * @returns An array of team members
 */
async function fetchTeamMembersForServer(
  runtime: IAgentRuntime,
  serverId: string
): Promise<TeamMember[]> {
  try {
    logger.info(`Fetching team members for server ${serverId}`);

    // Create the room ID in a consistent way
    const serverSpecificRoomId = getTeamMembersRoomId(runtime, serverId);

    // Get all memories from the team members room
    const memories = await runtime.getMemories({
      roomId: serverSpecificRoomId,
      tableName: 'messages',
    });

    logger.info(`Retrieved ${memories.length} memories from room ${serverSpecificRoomId}`);

    // Filter to only include team member records
    const teamMemberMemories = memories.filter(
      (memory) =>
        memory.content && memory.content.type === 'team-member' && memory.content.teamMember
    );

    logger.info(`Found ${teamMemberMemories.length} team member records`);

    // Extract and return the team members
    const teamMembers = teamMemberMemories.map((memory) => memory.content.teamMember);

    // Log for debugging
    logger.info(`Successfully retrieved ${teamMembers.length} team members for server ${serverId}`);

    return teamMembers;
  } catch (error) {
    logger.error(`Error fetching team members for server ${serverId}:`, error);
    logger.error(`Error stack: ${error.stack}`);
    return [];
  }
}

/**
 * Checks if a team member already exists in the database
 * @param existingMembers The list of existing team members
 * @param newMember The new team member to check
 * @returns True if the member already exists, false otherwise
 */
function isDuplicateTeamMember(existingMembers: TeamMember[], newMember: TeamMember): boolean {
  return existingMembers.some((member) => {
    // Check if TG name matches (if both have TG names)
    if (
      member.tgName &&
      newMember.tgName &&
      member.tgName.toLowerCase() === newMember.tgName.toLowerCase()
    ) {
      logger.info(`Found duplicate TG name: ${newMember.tgName}`);
      return true;
    }

    // Check if Discord name matches (if both have Discord names)
    if (
      member.discordName &&
      newMember.discordName &&
      member.discordName.toLowerCase() === newMember.discordName.toLowerCase()
    ) {
      logger.info(`Found duplicate Discord name: ${newMember.discordName}`);
      return true;
    }

    return false;
  });
}

export const addTeamMemberAction: Action = {
  name: 'ADD_TEAM_MEMBER',
  description:
    'Add team members into different sections with their TG names and update formats for organizational tracking and updates.',
  similes: ['ADD_TEAM_MEMBER', 'REGISTER_MEMBER', 'TRACK_TEAM', 'ADD_TO_SECTION', 'ORGANIZE_TEAM'],
  validate: async (runtime: IAgentRuntime, message: Memory, state: State) => {
    try {
      // Basic validation
      const room = state.data.room ?? (await runtime.getRoom(message.roomId));
      logger.info('Room data:', JSON.stringify(room, null, 2));

      if (!room) {
        logger.error('No room found for message');
        return false;
      }

      const serverId = room.serverId;
      if (!serverId) {
        logger.error('No server ID found for room');
        return false;
      }

      // Store server ID in state for the handler
      state.data.serverId = serverId;
      state.data.serverName = room.name || 'Unknown Server';

      // Check if user is an admin
      logger.info(`Checking if user ${message.entityId} is an admin for server ${serverId}`);
      const userRole = await getUserServerRole(runtime, message.entityId, serverId);
      logger.info(`User role: ${userRole}`);

      state.data.isAdmin = true;
      return true;
    } catch (error) {
      logger.error('Error in addTeamMemberAction validation:', error);
      logger.error(`Error stack: ${error.stack}`);
      return false;
    }
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: Record<string, unknown>,
    context: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<boolean> => {
    try {
      logger.info('=== RECORD-TEAM-MEMBER HANDLER START ===');
      logger.info('Message content received:', JSON.stringify(message.content, null, 2));

      if (!callback) {
        logger.warn('No callback function provided');
        return false;
      }

      // Extract user message
      const userText = message.content.text as string;
      if (!userText) {
        logger.warn('No text content found in message');
        return false;
      }

      // Get server ID from state
      const serverId = state.data.serverId as string;
      const serverName = state.data.serverName as string;

      if (!serverId) {
        logger.error('No server ID found in state');
        await callback(
          {
            text: '❌ Failed to identify the server. Please try again.',
          },
          []
        );
        return false;
      }

      logger.info(`Processing team members for server: ${serverId} (${serverName})`);

      // Example parsing team member data from input
      try {
        logger.info('Sending text to AI for parsing team member details');
        const prompt = `Extract team member information from this text:
        
        Return ONLY a valid JSON array of team member objects with these exact keys:
        [{
          "section": "value", // The section name
          "tgName": "value", // The TG name including the @ symbol if present
          "discordName":"value", // The Discord name including the @ symbol if present
          "updatesFormat": ["question1", "question2", ...] // Array of Questions to be asked from users
          // questions format can be in this form Main Priority for next week , What did you get done this week? or Blockers
        }] 

        The text can be super randomized like this 


        Section
        TG name
        Format
        Housekeeping
        @accelxr
        Text
        Operations Update
        @accelxr
        Main Priority for next week
        What did you get done this week?
        Blockers
        DevRel
        @nisita0
        Main Priority for next week
        What did you get done this week?
        Blockers

        so extract values properly
        Also sometime it will contain TG and somtime discord so leave the field blank if not provided any of it

        
        Text to parse: "${userText}"`;

        // TODO : after this all things are to be done like recordChecKInAction fuck this code

        logger.info('Team member parsing prompt:', prompt);

        const parsedResponse = await runtime.useModel(ModelType.TEXT_LARGE, {
          prompt,
          stopSequences: [],
        });

        logger.info('Raw AI response for team member details:', parsedResponse);

        // Parse the response
        let teamMembers = [];
        try {
          const cleanedResponse = parsedResponse.replace(/```json\n?|\n?```/g, '').trim();
          teamMembers = JSON.parse(cleanedResponse);

          // Fix: Ensure teamMembers is an array
          if (!Array.isArray(teamMembers)) {
            logger.warn('Parsed response is not an array, converting to array');
            teamMembers = [teamMembers];
          }

          logger.info('Successfully parsed team member configuration:', teamMembers);
        } catch (parseError) {
          logger.error('Failed to parse AI response as JSON:', parseError);
          logger.error('Raw response was:', parsedResponse);
          throw new Error('Failed to parse team member data from response');
        }

        // Validate that either TG or Discord name is present for each team member
        const validatedTeamMembers = teamMembers.filter((member) => {
          // Fix: Check for required fields
          if (!member.section) {
            logger.warn('Skipping team member missing section');
            return false;
          }

          // if (!member.format) {
          //   logger.warn(`Skipping team member in section "${member.section}" missing format`);
          //   return false;
          // }

          const hasTgName = !!member.tgName && member.tgName.trim() !== '';
          const hasDiscordName = !!member.discordName && member.discordName.trim() !== '';

          if (!hasTgName && !hasDiscordName) {
            logger.warn(
              `Skipping team member in section "${member.section}" - missing both TG and Discord names`
            );
            return false;
          }
          return true;
        });

        if (validatedTeamMembers.length < teamMembers.length) {
          logger.warn(
            `Filtered out ${teamMembers.length - validatedTeamMembers.length} team members due to missing required information`
          );
        }

        if (validatedTeamMembers.length === 0) {
          logger.error('No valid team members found after validation');
          await callback(
            {
              text: '❌ Could not identify any team members with valid information. Please ensure each team member has a section, format, and either a Telegram or Discord username.',
            },
            []
          );
          return false;
        }

        logger.info(
          `Validated ${validatedTeamMembers.length} team members with proper information`
        );

        const serverHash = serverId.replace(/[^a-zA-Z0-9]/g, '');

        const roomIdForStoringTeamMembers = createUniqueUuid(
          runtime,
          `store-team-members-${serverHash}`
        );

        // Add table name to getMemories call
        const memoriesForStoringTeamMembers = await runtime.getMemories({
          roomId: roomIdForStoringTeamMembers as UUID,
          tableName: 'messages',
        });

        const existingConfig = memoriesForStoringTeamMembers.find((memory) => {
          logger.info('Checking memory:', memory);
          const isTeamMembersExist = memory.content.type === 'store-team-members-memory';
          return isTeamMembersExist;
        });
        logger.info('Found existing config:', existingConfig);

        if (!existingConfig) {
          logger.info('No existing store-team-members-memory found, creating new one');
          try {
            // Store all the validatedTeamMembers in the config
            const config = {
              teamMembers: validatedTeamMembers,
              lastUpdated: Date.now(),
              serverId: serverId,
            };

            logger.info('Creating store-team-members channel config:', config);

            // First create the room to avoid foreign key constraint error
            logger.info(`Creating room with ID: ${roomIdForStoringTeamMembers}`);
            try {
              await runtime.ensureRoomExists({
                id: roomIdForStoringTeamMembers as UUID,
                name: 'Storing Members config',
                source: 'team-coordinator',
                type: ChannelType.GROUP,
              });
              logger.info(`Successfully created room with ID: ${roomIdForStoringTeamMembers}`);
            } catch (roomError) {
              logger.error(`Failed to create room: ${roomError.message}`);
              logger.error(`Room error stack: ${roomError.stack}`);
            }

            const memory = {
              id: createUniqueUuid(runtime, `store-team-members-${serverHash}`),
              entityId: runtime.agentId,
              agentId: runtime.agentId,
              content: {
                type: 'store-team-members-memory',
                config,
              },
              roomId: roomIdForStoringTeamMembers,
              createdAt: Date.now(),
            };

            await runtime.createMemory(memory, 'messages');
            logger.info('Successfully stored new report channel config');
          } catch (configError) {
            logger.error('Failed to store report channel config:', configError);
            logger.error('Error stack:', configError.stack);
          }
        } else {
          logger.info('Found existing team members config, checking for new members to add');

          // Fetch existing team members from the config
          const existingTeamMembers = existingConfig.content.config?.teamMembers || [];
          logger.info(`Found ${existingTeamMembers.length} existing team members`);

          // Filter out team members that already exist
          const newTeamMembers = validatedTeamMembers.filter(
            (newMember) => !isDuplicateTeamMember(existingTeamMembers, newMember)
          );

          if (newTeamMembers.length === 0) {
            logger.info('No new team members to add, all are already registered');

            // Format team members into a readable list
            const teamMembersList = existingTeamMembers
              .map((member: TeamMember, index: number) => {
                const section = member.section || 'Unassigned';
                const format = member.format || 'Text';

                let platformInfo = '';
                if (member.tgName) {
                  platformInfo = `Telegram: ${member.tgName}`;
                } else if (member.discordName) {
                  platformInfo = `Discord: ${member.discordName}`;
                }

                const updateFields =
                  member.updatesFormat?.length > 0
                    ? `\n   Fields: ${member.updatesFormat?.join(', ')}`
                    : '';

                return `${index + 1}. Section: ${section} | ${platformInfo}${updateFields}`;
              })
              .join('\n');

            // Add a callback here to respond when no new members are added
            await callback(
              {
                text: `✅ All team members are already registered!\n\nCurrent team members:\n${teamMembersList}`,
              },
              []
            );
          } else {
            // Add new team members to the existing list
            logger.info(`Adding ${newTeamMembers.length} new team members to existing config`);

            const updatedTeamMembers = [...existingTeamMembers, ...newTeamMembers];

            // Update the config with the new team members
            const updatedConfig = {
              ...(existingConfig.content.config as Record<string, unknown>),
              teamMembers: updatedTeamMembers,
              lastUpdated: Date.now(),
            };

            // Update the memory with the new config
            await runtime.updateMemory({
              id: existingConfig.id,
              ...existingConfig,
              content: {
                ...existingConfig.content,
                config: updatedConfig,
              },
            });

            logger.info(
              `Successfully updated team members config with ${newTeamMembers.length} new members`
            );

            // Format the newly added team members for the response
            const newMembersList = newTeamMembers
              .map((member, index) => {
                const section = member.section || 'Unassigned';
                const format = member.format || 'Text';

                let platformInfo = '';
                if (member.tgName) {
                  platformInfo = `Telegram: ${member.tgName}`;
                } else if (member.discordName) {
                  platformInfo = `Discord: ${member.discordName}`;
                }

                return `${index + 1}. Section: ${section} | Format: ${format} | ${platformInfo}`;
              })
              .join('\n');

            // Add a callback here to respond when new members are added
            const allTeamMembers = updatedTeamMembers;
            const teamMembersList = allTeamMembers
              .map((member, index) => {
                const section = member.section || 'Unassigned';

                let platformInfo = '';
                if (member.tgName) {
                  platformInfo = `Telegram: ${member.tgName}`;
                } else if (member.discordName) {
                  platformInfo = `Discord: ${member.discordName}`;
                }

                let updateFields = '';
                if (member.updatesFormat && member.updatesFormat?.length > 0) {
                  updateFields = ` | Update Fields: ${member.updatesFormat?.join(', ')}`;
                }

                return `${index + 1}. Section: ${section} | ${platformInfo}${updateFields}`;
              })
              .join('\n');

            await callback(
              {
                text: `✅ Team members have been successfully updated!\n\nCurrent team members:\n${teamMembersList}`,
              },
              []
            );
          }

          // Return early since we've already sent the callback
          return true;
        }

        logger.info('fetching updated members from memory');

        // Fetch the updated team members to include in the response
        const updatedMemories = await runtime.getMemories({
          roomId: roomIdForStoringTeamMembers as UUID,
          tableName: 'messages',
        });

        const updatedConfig = updatedMemories.find(
          (memory) => memory.content.type === 'store-team-members-memory'
        );

        if (updatedConfig && updatedConfig.content.config?.teamMembers) {
          const allTeamMembers = updatedConfig.content.config.teamMembers;
          logger.info(`Retrieved ${allTeamMembers.length} total team members for response`);

          // Format all team members for the response
          const teamMembersList = allTeamMembers
            .map((member, index) => {
              const section = member.section || 'Unassigned';
              const format = member.format || 'Text';

              let platformInfo = '';
              if (member.tgName) {
                platformInfo = `Telegram: ${member.tgName}`;
              } else if (member.discordName) {
                platformInfo = `Discord: ${member.discordName}`;
              }

              let updateFields = '';
              if (member.updatesFormat && member.updatesFormat?.length > 0) {
                updateFields = ` | Update Fields: ${member.updatesFormat?.join(', ')}`;
              }

              return `${index + 1}. Section: ${section} | ${platformInfo}${updateFields}`;
            })
            .join('\n');

          await callback(
            {
              text: `✅ Team members have been successfully added!\n\nCurrent team members:\n${teamMembersList}`,
            },
            []
          );
        } else {
          await callback(
            {
              text: `✅ Team members have been successfully added!`,
            },
            []
          );
        }
      } catch (parsingError) {
        logger.error('Failed to parse team member information:', parsingError);
        logger.error('Error stack:', parsingError.stack);

        await callback(
          {
            text: '❌ There was an issue processing the team member information. Please check the format and try again.',
          },
          []
        );
        return false;
      }

      return true;
    } catch (error) {
      logger.error('=== TEAM-MEMBER HANDLER ERROR ===');
      logger.error(`Error processing team member recording: ${error}`);
      logger.error(`Error stack: ${error.stack}`);

      if (callback) {
        await callback(
          {
            text: '❌ An unexpected error occurred while recording team members. Please try again later.',
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
          text: 'Record these team members:\nSection: Housekeeping\nTG name: @accelxr\nFormat: Text\n\nSection: DevRel\nTG name: @nisita0\nFormat: Main Priority for next week\nWhat did you get done this week?\nBlockers',
        },
      },
      {
        name: '{{botName}}',
        content: {
          text: "I'll record these team members for you",
          actions: ['ADD_TEAM_MEMBER'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'Add team members to sections: Operations Update @accelxr with Text format, and DevRel @nisita0 with update fields',
        },
      },
      {
        name: '{{botName}}',
        content: {
          text: "I'll add these team members to their respective sections",
          actions: ['ADD_TEAM_MEMBER'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'Can you help me organize my team members by section?',
        },
      },
      {
        name: '{{botName}}',
        content: {
          text: 'I can help you record and organize your team members by section. Please provide the details.',
          actions: ['ADD_TEAM_MEMBER'],
        },
      },
    ],
  ],
};
