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
  updatesConfig?: {
    fields: string[];
  };
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
          "format": "value", // The format type (Text or other format)
          "updatesConfig": {
            "fields": ["field1", "field2", ...] // Array of field names for updates
          }
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

          if (!member.format) {
            logger.warn(`Skipping team member in section "${member.section}" missing format`);
            return false;
          }

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

        // Create consistent room ID for easier retrieval
        // Use the helper function to ensure consistency
        const serverSpecificRoomId = getTeamMembersRoomId(runtime, serverId);
        logger.info(`Using server-specific room ID: ${serverSpecificRoomId}`);

        // Fetch existing team members to check for duplicates
        logger.info(
          `Fetching existing team members for server ${serverId} to check for duplicates`
        );

        // Add table name to getMemories call
        const memories = await runtime.getMemories({
          roomId: serverSpecificRoomId as UUID,
          tableName: 'messages',
        });
        const existingConfig = memories.find((memory) => {
          logger.info('Checking memory:', memory);
          const isReportConfig = memory.content.type === 'report-channel-config';

          return isReportConfig;
        });
        logger.info(`Found ${memories.length} existing team members for server ${serverId}`);

        const existingTeamMembers = await fetchTeamMembersForServer(runtime, serverSpecificRoomId);

        // Store team members

        try {
          logger.info(
            `Processing ${validatedTeamMembers.length} team members for server ${serverId}`
          );

          try {
            await runtime.ensureRoomExists({
              id: serverSpecificRoomId,
              name: `Team Members - ${serverName}`,
              source: 'team-coordinator',
              type: ChannelType.GROUP,
              serverId: serverId,
            });
            logger.info(`Successfully ensured room exists with ID: ${serverSpecificRoomId}`);
          } catch (roomError) {
            logger.error(`Failed to ensure room exists: ${roomError.message}`);
            logger.error(`Room error stack: ${roomError.stack}`);
            // Continue attempting to store even if room creation fails
          }

          // Use validatedTeamMembers instead of teamMembers
          let successfulStores = 0;
          let skippedDuplicates = 0;

          for (const member of validatedTeamMembers) {
            // Add server information and timestamp
            const enrichedMember = {
              ...member,
              serverId: serverId,
              serverName: serverName,
              createdAt: new Date().toISOString(),
            };

            // Check if this team member already exists
            if (isDuplicateTeamMember(existingTeamMembers, enrichedMember)) {
              logger.info(`Skipping duplicate team member: ${member.tgName || member.discordName}`);
              skippedDuplicates++;
              continue;
            }

            // Fix: Ensure unique IDs even with special characters in names
            const memberIdBase = (member.tgName || member.discordName || 'unknown')
              .replace(/[^a-zA-Z0-9]/g, '')
              .substring(0, 12);

            const teamMemberMemory = {
              id: createUniqueUuid(
                runtime,
                `team-member-${serverId}-${memberIdBase}-${Date.now()}`
              ),
              entityId: runtime.agentId,
              agentId: runtime.agentId,
              content: {
                type: 'team-member',
                teamMember: enrichedMember,
                serverId: serverId, // Also include server ID at the content level for easier querying
                section: member.section, // Add section at content level for easier filtering
              },
              roomId: serverSpecificRoomId,
              createdAt: Date.now(),
            };

            logger.info(`Storing team member in memory for server ${serverId}:`, teamMemberMemory);
            try {
              await runtime.createMemory(teamMemberMemory, 'messages');
              successfulStores++;
              // Add to existingTeamMembers to prevent duplicates within this batch
              existingTeamMembers.push(enrichedMember);
            } catch (memoryError) {
              logger.error(`Failed to store team member ${memberIdBase}:`, memoryError);
            }
          }

          logger.info(
            `Successfully stored ${successfulStores} team members in memory for server ${serverId}`
          );
          logger.info(`Skipped ${skippedDuplicates} duplicate team members`);

          // Create an index memory for faster retrieval
          try {
            const indexMemory = {
              id: createUniqueUuid(runtime, `team-members-index-${serverId}`),
              entityId: runtime.agentId,
              agentId: runtime.agentId,
              content: {
                type: 'team-members-index',
                serverId: serverId,
                serverName: serverName,
                memberCount: existingTeamMembers.length, // Updated to include all members
                updatedAt: new Date().toISOString(),
                sections: [...new Set(existingTeamMembers.map((member) => member.section))], // Add list of sections
              },
              roomId: serverSpecificRoomId,
              createdAt: Date.now(),
            };

            await runtime.createMemory(indexMemory, 'messages');
            logger.info(`Created team members index for server ${serverId}`);
          } catch (indexError) {
            logger.error(`Failed to create team members index:`, indexError);
          }

          // After storing, fetch team members to verify storage and demonstrate retrieval
          logger.info(`Fetching team members for server ${serverId} to verify storage`);
          const storedTeamMembers = await fetchTeamMembersForServer(runtime, serverId);

          // Fix: Handle case where no team members are retrieved
          if (storedTeamMembers.length === 0) {
            logger.warn(`No team members retrieved after storage for server ${serverId}`);
            await callback(
              {
                text:
                  skippedDuplicates > 0
                    ? `✅ Processed ${successfulStores} new team members for server "${serverName}" (skipped ${skippedDuplicates} duplicates), but could not verify storage. They should be available for future use.`
                    : `✅ Processed ${successfulStores} team members for server "${serverName}", but could not verify storage. They should be available for future use.`,
              },
              []
            );
            return true;
          }

          // Create summary of stored team members by section
          const sectionSummary = storedTeamMembers.reduce(
            (acc, member) => {
              const section = member.section || 'Uncategorized';
              if (!acc[section]) {
                acc[section] = [];
              }
              const memberName = member.tgName || member.discordName || 'Unknown';
              if (!acc[section].includes(memberName)) {
                acc[section].push(memberName);
              }
              return acc;
            },
            {} as Record<string, string[]>
          );

          logger.info(`Team members by section:`, sectionSummary);

          // Include section summary in response
          const sectionList = Object.entries(sectionSummary)
            .map(([section, members]) => `**${section}**: ${members.join(', ')}`)
            .join('\n');

          // Send success message to the user with section summary
          logger.info('Sending success message to user with section summary');
          await callback(
            {
              text:
                skippedDuplicates > 0
                  ? `✅ Successfully added ${successfulStores} new team members for server "${serverName}" (skipped ${skippedDuplicates} duplicates).\n\nTeam members stored by section:\n${sectionList}`
                  : `✅ Successfully recorded ${successfulStores} team members for server "${serverName}".\n\nTeam members stored by section:\n${sectionList}`,
            },
            []
          );
        } catch (storageError) {
          logger.error(`Failed to store team members for server ${serverId}:`, storageError);
          logger.error('Error stack:', storageError.stack);

          await callback(
            {
              text: '❌ There was an error storing the team member information. Please try again.',
            },
            []
          );
          return false;
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
