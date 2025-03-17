import {
  type Action,
  type Content,
  type IAgentRuntime,
  type Memory,
  type UUID,
  createUniqueUuid,
  logger,
} from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';
import type { EmploymentStatus, PlatformContact, TeamMember, WeekDay } from '../../../types';

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
export const registerTeamMember: Action = {
  name: 'registerTeamMember',
  description: 'Registers a new team member in the system with platform-specific identifiers',
  similes: ['addTeamMember', 'createTeamMember'],
  validate: async (runtime: IAgentRuntime, message: any) => {
    // Check if required fields are present
    if (!message.name) {
      return false;
    }
    return true;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: any,
    state: any,
    context: any
  ): Promise<boolean> => {
    try {
      // Extract parameters from message
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

      // Check if team member already exists with the same name
      const existingMemories = await runtime.getMemories({
        tableName: 'messages',
        roomId: teamMembersRoomId,
      });

      const existingMember = (
        existingMemories as Array<Memory & { content: TeamMemberContent }>
      ).find((memory) => memory.content.member.name === name);

      if (existingMember) {
        logger.warn(`Team member with name ${name} already exists`);
        throw new Error(`Team member with name ${name} already exists`);
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
        name,
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

      // Save to memory manager
      // Create memory content with proper structure
      const teamMemberContent = {
        type: 'team-member',
        member: newTeamMember,
        discordHandle: discordHandle || undefined,
      } as Content;

      // Log the memory content being created
      logger.info(`Creating team member memory: ${JSON.stringify(teamMemberContent)}`);

      // Create memory in the team-members room
      await runtime.createMemory(
        {
          id: createUniqueUuid(runtime, `team-member-${name}`),
          entityId: runtime.agentId,
          agentId: runtime.agentId,
          content: teamMemberContent,
          roomId: teamMembersRoomId,
          createdAt: Date.now(),
        },
        'messages'
      );

      // Verify memory was created by retrieving it
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
      } else {
        logger.info(`Successfully verified team member ${name} was created`);
      }

      logger.info(`Successfully registered team member: ${name} with ID: ${newTeamMember.id}`);
      return true;
    } catch (error) {
      logger.error(`Error registering team member: ${error}`);
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
