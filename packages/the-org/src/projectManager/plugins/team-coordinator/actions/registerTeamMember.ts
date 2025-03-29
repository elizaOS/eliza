import {
  type Action,
  type Content,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type UUID,
  createUniqueUuid,
  logger,
} from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';
import type { EmploymentStatus, PlatformContact, TeamMember, WeekDay } from '../../../types';

// Import any required Discord.js specific types if needed for TypeScript
type DiscordMessageSource = { source: 'discord'; messageId?: string; channelId?: string };

/**
 * Interface for team member memory content
 */
interface TeamMemberContent {
  type: 'team-member';
  member: TeamMember;
  discordHandle?: string;
}

/**
 * Action to register a new team member in the system
 */
/**
 * Sends a registration form with dropdown options to Discord
 * @param callback The callback function to send the message
 */
async function sendRegistrationForm(callback: HandlerCallback): Promise<void> {
  logger.info('Sending registration form with dropdown options to Discord...');

  const content: Content = {
    text: 'Please complete the following form to register a new team member:',
    source: 'discord',
    components: [
      {
        type: 1, // ACTION_ROW
        components: [
          {
            type: 3, // SELECT_MENU
            custom_id: 'employment_status',
            placeholder: 'Select Employment Status',
            options: [
              { label: 'Full Time', value: 'FULL_TIME', description: '40 hours per week' },
              { label: 'Part Time', value: 'PART_TIME', description: '20-30 hours per week' },
              { label: 'Freelance', value: 'FREELANCE', description: 'Contract based' },
              { label: 'None', value: 'NONE', description: 'No formal employment' },
            ],
          },
        ],
      },
      {
        type: 1, // ACTION_ROW
        components: [
          {
            type: 3, // SELECT_MENU
            custom_id: 'work_days',
            placeholder: 'Select Work Days',
            min_values: 1,
            max_values: 7,
            options: [
              { label: 'Monday', value: 'MONDAY' },
              { label: 'Tuesday', value: 'TUESDAY' },
              { label: 'Wednesday', value: 'WEDNESDAY' },
              { label: 'Thursday', value: 'THURSDAY' },
              { label: 'Friday', value: 'FRIDAY' },
              { label: 'Saturday', value: 'SATURDAY' },
              { label: 'Sunday', value: 'SUNDAY' },
            ],
          },
        ],
      },
      {
        type: 1, // ACTION_ROW
        components: [
          {
            type: 3, // SELECT_MENU
            custom_id: 'timezone',
            placeholder: 'Select Timezone',
            options: [
              { label: 'UTC', value: 'UTC', description: 'Coordinated Universal Time' },
              { label: 'EST', value: 'America/New_York', description: 'Eastern Standard Time' },
              { label: 'CST', value: 'America/Chicago', description: 'Central Standard Time' },
              { label: 'MST', value: 'America/Denver', description: 'Mountain Standard Time' },
              { label: 'PST', value: 'America/Los_Angeles', description: 'Pacific Standard Time' },
              { label: 'IST', value: 'Asia/Kolkata', description: 'Indian Standard Time' },
              { label: 'JST', value: 'Asia/Tokyo', description: 'Japan Standard Time' },
              {
                label: 'AEST',
                value: 'Australia/Sydney',
                description: 'Australian Eastern Standard Time',
              },
            ],
          },
        ],
      },
      {
        type: 1, // ACTION_ROW
        components: [
          {
            type: 2, // BUTTON
            style: 1, // PRIMARY
            custom_id: 'submit_registration',
            label: 'Submit',
          },
          {
            type: 2, // BUTTON
            style: 2, // SECONDARY
            custom_id: 'cancel_registration',
            label: 'Cancel',
          },
        ],
      },
    ],
  };

  try {
    logger.info('Sending registration form to Discord...');
    await callback(content, []);
    logger.info('Successfully sent registration form');
  } catch (error) {
    logger.error(`Error sending registration form: ${error}`);
    throw error;
  }
}

export const registerTeamMember: Action = {
  name: 'registerTeamMember',
  description: 'Registers a new team member in the system with platform-specific identifiers',
  similes: ['addTeamMember', 'createTeamMember'],
  validate: async (runtime: IAgentRuntime, message: any) => {
    return true;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: any,
    state: any,
    context: any,
    callback?: HandlerCallback
  ): Promise<boolean> => {
    try {
      logger.info('Starting team member registration process');

      // Check if we have a callback function for sending responses
      if (!callback) {
        logger.warn('No callback function provided - cannot send Discord interface');
        return false;
      }

      // Send the registration form first
      logger.info('Sending registration form to Discord...');
      await sendRegistrationForm(callback);

      // Return true after sending the form - we'll handle the actual registration
      // when we receive the form submission
      return true;

      // The rest of the registration logic will be handled when we receive
      // the form submission event
      const {
        name,
        workDays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
        workHoursStart = '09:00',
        workHoursEnd = '17:00',
        timeZone = 'UTC',
        hoursPerWeek = 40,
        employmentStatus = 'FULL_TIME',
        contacts = [],
        skills = [],
        discordHandle = '',
      } = message;

      logger.info(`Registering new team member: ${name}`);

      // Create a unique room ID for team members
      const teamMembersRoomId = createUniqueUuid(runtime, 'team-members');
      logger.info(`Creating team members room with ID: ${teamMembersRoomId}`);

      // First, create the room if it doesn't exist
      try {
        await runtime.createRoom({
          id: teamMembersRoomId,
          name: 'Team Members',
          description: 'Room for storing team member information',
          createdAt: Date.now(),
          entityId: runtime.agentId,
          agentId: runtime.agentId,
          type: 'team',
        });
        logger.info('Created team members room successfully');
      } catch (error) {
        // If room already exists, that's fine - we'll use the existing one
        if (error.message?.includes('duplicate key')) {
          logger.info('Team members room already exists, using existing room');
        } else {
          logger.error(`Error creating team members room: ${error}`);
          throw error;
        }
      }

      // Add Discord handle to contacts if provided
      if (discordHandle) {
        contacts.push({
          platform: 'DISCORD',
          identifier: discordHandle,
        });
      }

      // Create new team member
      const newTeamMember: TeamMember = {
        id: uuidv4() as UUID,
        name: name || 'Unknown',
        availability: {
          workDays: workDays as WeekDay[],
          workHours: {
            start: workHoursStart,
            end: workHoursEnd,
          },
          timeZone,
          hoursPerWeek,
          employmentStatus: employmentStatus as EmploymentStatus,
        },
        contacts,
        skills,
        dateAdded: new Date().toISOString(),
      };

      // Check if team member already exists
      try {
        const existingMemories = await runtime.getMemories({
          tableName: 'messages',
          roomId: teamMembersRoomId,
        });

        const existingMember = (
          existingMemories as Array<Memory & { content: TeamMemberContent }>
        ).find((memory) => memory.content.member.name === newTeamMember.name);

        if (existingMember) {
          logger.warn(`Team member with name ${newTeamMember.name} already exists`);
          throw new Error(`Team member with name ${newTeamMember.name} already exists`);
        }

        // Create memory content
        const teamMemberContent = {
          type: 'team-member',
          member: newTeamMember,
          discordHandle: discordHandle || undefined,
        } as Content;

        logger.info(`Creating team member memory: ${JSON.stringify(teamMemberContent)}`);

        // Create memory in the team-members room
        await runtime.createMemory(
          {
            id: createUniqueUuid(runtime, `team-member-${newTeamMember.name}`),
            entityId: runtime.agentId,
            agentId: runtime.agentId,
            content: teamMemberContent,
            roomId: teamMembersRoomId,
            createdAt: Date.now(),
          },
          'messages'
        );

        logger.info(`Successfully created team member: ${newTeamMember.name}`);
      } catch (error) {
        logger.error(`Error in team member creation process: ${error}`);
        throw error;
      }

      logger.info('Verifying team member memory creation...');

      const verifyMemories = await runtime.getMemories({
        roomId: teamMembersRoomId,
        tableName: 'messages',
      });

      logger.info(`Team members room now has ${verifyMemories.length} memories`);
      const verifyMember = verifyMemories.find(
        (memory) =>
          memory.content?.type === 'team-member' &&
          (memory.content as unknown as TeamMemberContent).member?.id === newTeamMember.id
      );

      if (!verifyMember) {
        logger.warn(`Team member ${name} was not found after creation!`);
        logger.warn(
          `Available memories: ${JSON.stringify(verifyMemories.map((m) => ({ id: m.id, type: m.content?.type })))}`
        );
      } else {
        logger.info(
          `Successfully verified team member ${name} was created with ID: ${newTeamMember.id}`
        );
        logger.info(`Memory ID: ${verifyMember.id}`);
      }

      logger.info(`Successfully registered team member: ${name} with ID: ${newTeamMember.id}`);
      return true;
    } catch (error) {
      logger.error(`Error registering team member: ${error}`);
      logger.error(`Error stack: ${error.stack}`);
      return false;
    }
  },
  examples: [
    [
      {
        name: 'admin',
        content: { text: 'Register John as a team member' },
      },
      {
        name: 'jimmy',
        content: { text: "I'll register John as a team member", actions: ['registerTeamMember'] },
      },
    ],
  ],
};
