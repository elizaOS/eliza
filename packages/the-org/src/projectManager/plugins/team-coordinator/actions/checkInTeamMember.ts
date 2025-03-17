import {
  type Action,
  type IAgentRuntime,
  type Memory,
  type UUID,
  createUniqueUuid,
  logger,
} from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';
import { isToday, getDay } from 'date-fns';
import type { DailyUpdate, TeamMember } from '../../../types';

/**
 * Interface for team member memory content
 */
interface TeamMemberContent {
  type: 'team-member';
  member: TeamMember;
  discordHandle?: string;
}

/**
 * Interface for daily update memory content
 */
interface DailyUpdateContent {
  type: 'daily-update';
  update: DailyUpdate;
}

/**
 * Determines if a team member should work today based on their work days schedule
 */
function shouldWorkToday(teamMember: TeamMember): boolean {
  if (!teamMember.availability?.workDays) {
    // Default to working on weekdays if work days not specified
    const today = new Date();
    const dayOfWeek = getDay(today);
    return dayOfWeek >= 1 && dayOfWeek <= 5; // Monday-Friday
  }

  // Get today's day of week (0 = Sunday, 1 = Monday, etc.)
  const today = new Date();
  const dayOfWeek = getDay(today);

  // Convert day of week to a day name that matches the TeamMember type
  const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const todayName = dayNames[dayOfWeek].toUpperCase();

  // Check if this day is in their work days
  return teamMember.availability?.workDays?.includes?.(todayName as any) ?? false;
}

/**
 * Sends a message to Discord
 */
async function sendDiscordMessage(
  runtime: IAgentRuntime,
  discordHandle: string,
  message: string
): Promise<boolean> {
  try {
    // This is where you would implement sending a message to Discord
    // Using whatever API or method is available in the runtime
    logger.info(`Sending Discord message to ${discordHandle}: ${message}`);

    // Mock implementation - this should be replaced with actual Discord API integration
    if (runtime?.hasPlugin && runtime?.hasPlugin('discord-connector')) {
      // Example of how this might work with a hypothetical Discord plugin
      await runtime?.executePluginAction('discord-connector', 'sendDirectMessage', {
        handle: discordHandle,
        content: message,
      });
      return true;
    }

    logger.warn('Discord connector not available. Message not sent.');
    return false;
  } catch (error) {
    logger.error(`Error sending Discord message: ${error}`);
    return false;
  }
}

/**
 * Action to record a daily check-in for a team member and send reminders
 */
export const checkInTeamMember: Action = {
  name: 'checkInTeamMember',
  description:
    "Records a daily check-in for a team member or sends reminders to team members who haven't checked in",
  similes: ['logDailyUpdate', 'submitCheckIn', 'remindTeamMembers'],
  validate: async (runtime: IAgentRuntime, message: any) => {
    // If this is a reminder request, we only need projectId
    if (message?.isReminder) {
      return Boolean(message?.projectId);
    }

    // For regular check-ins, we need teamMemberId, projectId, and summary
    return Boolean(message?.teamMemberId && message?.projectId && message?.summary);
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
        projectId,
        summary,
        tasksCompleted = [],
        tasksInProgress = [],
        blockers = '',
        hoursWorked = 0,
        discordHandle = '',
        isReminder = false,
      } = message;

      // Create a unique room ID for team members
      const teamMembersRoomId = createUniqueUuid(runtime, 'team-members');

      // Verify team members exist
      const teamMemberMemories = await runtime.getMemories({
        tableName: 'messages',
        roomId: teamMembersRoomId,
      });

      const typedTeamMemberMemories = teamMemberMemories as Array<
        Memory & { content: TeamMemberContent }
      >;

      // If this is a reminder request, send reminders to team members who haven't checked in
      if (isReminder) {
        logger.info(`Sending reminders to team members for project ID: ${projectId}`);

        // Create a unique room ID for daily updates
        const dailyUpdatesRoomId = createUniqueUuid(runtime, 'daily-updates');

        // Get all daily updates
        const dailyUpdateMemories = await runtime.getMemories({
          tableName: 'messages',
          roomId: dailyUpdatesRoomId,
        });

        const typedDailyUpdateMemories = dailyUpdateMemories as Array<
          Memory & { content: DailyUpdateContent }
        >;

        // Get today's date in YYYY-MM-DD format
        const today = new Date().toISOString().split('T')[0];

        // Filter team members who are assigned to the specified project
        // This assumes that team members have a projects array in their data
        const projectTeamMembers = typedTeamMemberMemories.filter((memory) => {
          const member = memory.content.member;
          return member?.projects?.includes(projectId as UUID);
        });

        // For each team member in the project
        let remindersSent = 0;
        for (const memberMemory of projectTeamMembers) {
          const member = memberMemory.content.member;
          const discordHandle = memberMemory.content.discordHandle;

          // Skip if no Discord handle available
          if (!discordHandle) {
            logger.warn(`No Discord handle available for team member ${member.id}`);
            continue;
          }

          // Check if they've already checked in today
          const hasCheckedInToday = typedDailyUpdateMemories.some(
            (memory) =>
              memory.content.update.teamMemberId === member.id &&
              memory.content.update.projectId === projectId &&
              memory.content.update.date === today
          );

          // If they haven't checked in and they're expected to work today
          if (!hasCheckedInToday && shouldWorkToday(member)) {
            // Send reminder via Discord
            const reminderMessage = `Hey ${member.name}! Just a friendly reminder to submit your daily check-in for project ${projectId}.`;
            const sent = await sendDiscordMessage(runtime, discordHandle, reminderMessage);

            if (sent) {
              remindersSent++;
              logger.info(`Sent reminder to ${member.name} (${discordHandle})`);
            }
          }
        }

        logger.info(`Sent ${remindersSent} reminders to team members for project ${projectId}`);
        return remindersSent > 0;
      }

      // For regular check-in processing:
      logger.info(
        `Recording check-in for team member ID: ${teamMemberId}, project ID: ${projectId}`
      );

      // Find the team member with the given ID
      const teamMemberMemory = typedTeamMemberMemories.find(
        (memory) => memory.content.member.id === teamMemberId
      );

      if (!teamMemberMemory) {
        logger.error(`Team member with ID ${teamMemberId} not found`);
        return false;
      }

      const teamMember = teamMemberMemory.content.member;

      // Create new daily update
      const today = new Date().toISOString().split('T')[0]; // Get YYYY-MM-DD format

      // Create a unique room ID for daily updates
      const dailyUpdatesRoomId = createUniqueUuid(runtime, 'daily-updates');

      // Get all daily updates
      const dailyUpdateMemories = await runtime.getMemories({
        tableName: 'messages',
        roomId: dailyUpdatesRoomId,
      });

      // Find if there's an existing update for today's date for this team member and project
      const existingUpdateMemory = (
        dailyUpdateMemories as Array<Memory & { content: DailyUpdateContent }>
      ).find(
        (memory) =>
          memory.content.update.teamMemberId === teamMemberId &&
          memory.content.update.projectId === projectId &&
          memory.content.update.date === today
      );

      if (existingUpdateMemory) {
        logger.warn(
          `Team member ${teamMemberId} already checked in for project ${projectId} today`
        );

        // Update the existing check-in
        const updatedDailyUpdate: DailyUpdate = {
          ...existingUpdateMemory.content.update,
          summary,
          tasksCompleted: tasksCompleted?.map((id) => id as UUID),
          tasksInProgress: tasksInProgress?.map((id) => id as UUID),
          blockers,
          hoursWorked,
        };

        // Save updated check-in to memory
        await runtime.createMemory(
          {
            id: existingUpdateMemory.id,
            entityId: runtime.agentId,
            agentId: runtime.agentId,
            content: {
              type: 'daily-update',
              update: updatedDailyUpdate,
            },
            roomId: dailyUpdatesRoomId,
            createdAt: existingUpdateMemory.createdAt,
          },
          'messages'
        );

        // Also update the team member's last check-in date
        const updatedTeamMember: TeamMember = {
          ...teamMember,
          lastCheckIn: new Date().toISOString(),
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
              discordHandle: teamMemberMemory.content.discordHandle,
            },
            roomId: teamMembersRoomId,
            createdAt: teamMemberMemory.createdAt,
          },
          'messages'
        );

        logger.info(`Updated existing check-in for team member ${teamMemberId}`);
        return true;
      }

      // Create new check-in record
      const dailyUpdate: DailyUpdate = {
        id: uuidv4() as UUID,
        teamMemberId: teamMemberId as UUID,
        projectId: projectId as UUID,
        date: today,
        summary,
        tasksCompleted: tasksCompleted?.map((id) => id as UUID),
        tasksInProgress: tasksInProgress?.map((id) => id as UUID),
        blockers,
        hoursWorked,
      };

      // Save new check-in to memory
      await runtime.createMemory(
        {
          id: createUniqueUuid(runtime, `daily-update-${teamMemberId}-${projectId}-${today}`),
          entityId: runtime.agentId,
          agentId: runtime.agentId,
          content: {
            type: 'daily-update',
            update: dailyUpdate,
          },
          roomId: dailyUpdatesRoomId,
          createdAt: Date.now(),
        },
        'messages'
      );

      // Update team member's last check-in date
      const updatedTeamMember: TeamMember = {
        ...teamMember,
        lastCheckIn: new Date().toISOString(),
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
            discordHandle: teamMemberMemory.content.discordHandle,
          },
          roomId: teamMembersRoomId,
          createdAt: teamMemberMemory.createdAt,
        },
        'messages'
      );

      logger.info(`Successfully recorded check-in for team member ${teamMemberId}`);
      return true;
    } catch (error) {
      logger.error(`Error recording check-in: ${error}`);
      return false;
    }
  },
  examples: [
    [
      {
        name: 'john',
        content: { text: 'I want to check in for project Alpha' },
      },
      {
        name: 'jimmy',
        content: {
          text: "I'll record your check-in for project Alpha. Please provide a summary of your work today.",
          actions: ['checkInTeamMember'],
        },
      },
    ],
    [
      {
        name: 'admin',
        content: { text: 'Send check-in reminders to all team members on Project Beta' },
      },
      {
        name: 'jimmy',
        content: {
          text: "I'll send reminders to all team members who haven't checked in yet for Project Beta.",
          actions: ['checkInTeamMember'],
        },
      },
    ],
  ],
};
