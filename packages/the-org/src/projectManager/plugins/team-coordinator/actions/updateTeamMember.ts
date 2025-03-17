import {
  type Action,
  type IAgentRuntime,
  type Memory,
  type UUID,
  createUniqueUuid,
  logger,
} from '@elizaos/core';
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
 * Action to update an existing team member in the system
 */
export const updateTeamMember: Action = {
  name: 'updateTeamMember',
  description: "Updates an existing team member's information",
  similes: ['modifyTeamMember', 'editTeamMember'],
  validate: async (runtime: IAgentRuntime, message: any) => {
    // Basic validation logic - just check if teamMemberId exists
    return Boolean(message?.teamMemberId);
  },
  handler: async (
    runtime: IAgentRuntime,
    message: any,
    state: any,
    context: any
  ): Promise<boolean> => {
    try {
      const {
        teamMemberId,
        name,
        workDays,
        workHoursStart,
        workHoursEnd,
        timeZone,
        hoursPerWeek,
        employmentStatus,
        contacts,
        skills,
        discordHandle,
      } = message;

      logger.info(`Updating team member with ID: ${teamMemberId}`);

      // Create a unique room ID for team members
      const teamMembersRoomId = createUniqueUuid(runtime, 'team-members');

      // Get all team member memories
      const teamMemberMemories = await runtime.getMemories({
        tableName: 'messages',
        roomId: teamMembersRoomId,
      });

      // Find the team member with the given ID
      const teamMemberMemory = (
        teamMemberMemories as Array<Memory & { content: TeamMemberContent }>
      ).find((memory) => memory.content.member.id === teamMemberId);

      if (!teamMemberMemory) {
        logger.warn(`Team member with ID ${teamMemberId} not found`);
        return false;
      }

      const teamMember = teamMemberMemory.content.member;

      // Update team member object with new values
      const updatedTeamMember: TeamMember = {
        ...teamMember,
        name: name || teamMember.name,
        availability: {
          workDays: workDays || teamMember.availability.workDays,
          workHours: {
            start: workHoursStart || teamMember.availability.workHours.start,
            end: workHoursEnd || teamMember.availability.workHours.end,
          },
          timeZone: timeZone || teamMember.availability.timeZone,
          hoursPerWeek: hoursPerWeek || teamMember.availability.hoursPerWeek,
          employmentStatus: employmentStatus || teamMember.availability.employmentStatus,
        },
        contacts: contacts || teamMember.contacts,
        skills: skills || teamMember.skills,
      };

      // Save updated team member to memory
      await runtime.createMemory(
        {
          id: teamMemberMemory.id,
          entityId: runtime.agentId,
          agentId: runtime.agentId,
          content: {
            type: 'team-member',
            member: updatedTeamMember,
            discordHandle: discordHandle || teamMemberMemory.content.discordHandle,
          },
          roomId: teamMembersRoomId,
          createdAt: teamMemberMemory.createdAt,
        },
        'messages'
      );

      logger.info(`Successfully updated team member: ${updatedTeamMember.name}`);
      return true;
    } catch (error) {
      logger.error(`Error updating team member: ${error}`);
      return false;
    }
  },
  examples: [
    [
      {
        name: 'admin',
        content: { text: "Update John's timezone to EST" },
      },
      {
        name: 'jimmy',
        content: { text: "I'll update John's timezone to EST", actions: ['updateTeamMember'] },
      },
    ],
  ],
};
