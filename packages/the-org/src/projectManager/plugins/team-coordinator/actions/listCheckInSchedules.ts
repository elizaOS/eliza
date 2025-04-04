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
import type { CheckInSchedule } from '../../../types';

export async function fetchCheckInSchedules(runtime: IAgentRuntime): Promise<CheckInSchedule[]> {
  try {
    logger.info('=== FETCH CHECK-IN SCHEDULES START ===');

    // Create a unique room ID for check-in schedules
    const checkInSchedulesRoomId = createUniqueUuid(runtime, 'check-in-schedules');
    logger.info(`Generated check-in schedules room ID: ${checkInSchedulesRoomId}`);

    // Get memories from the check-in schedules room
    logger.info('Attempting to fetch memories from room...');
    const memories = await runtime.getMemories({
      roomId: checkInSchedulesRoomId,
      tableName: 'messages',
    });
    logger.info(`Found ${memories.length} total memories in check-in schedules room`);

    // Log first few memories for debugging
    memories.slice(0, 3).forEach((memory, index) => {
      logger.info(`Memory ${index} content:`, {
        id: memory.id,
        type: memory.content?.type,
        hasSchedule: !!memory.content?.schedule,
        contentKeys: Object.keys(memory.content || {}),
      });
    });

    // Extract and return schedules from memories
    const schedules = memories
      .filter((memory) => {
        const isValidType = memory?.content?.type === 'team-member-checkin-schedule';
        const hasSchedule = !!memory?.content?.schedule;
        logger.info(`Memory ${memory.id} validation:`, {
          isValidType,
          hasSchedule,
          contentType: memory?.content?.type,
        });
        return isValidType && hasSchedule;
      })
      .map((memory) => {
        const schedule = memory.content?.schedule as CheckInSchedule;
        logger.info(`Processing schedule from memory ${memory.id}:`, {
          scheduleId: schedule?.scheduleId,
          teamMemberId: schedule?.teamMemberId,
          frequency: schedule?.frequency,
        });
        return schedule;
      })
      .filter((schedule): schedule is CheckInSchedule => {
        const isValid = schedule !== undefined;
        if (!isValid) {
          logger.warn('Found invalid schedule:', schedule);
        }
        return isValid;
      });

    logger.info(`Successfully extracted ${schedules.length} valid schedules`);
    logger.info('=== FETCH CHECK-IN SCHEDULES END ===');
    // Log detailed information about each schedule for debugging
    logger.info('=== DETAILED SCHEDULES LOG ===');
    logger.info('All schedules:', JSON.stringify(schedules, null, 2));
    logger.info('=== END DETAILED SCHEDULES LOG ===');
    return schedules;
  } catch (error) {
    logger.error('=== FETCH CHECK-IN SCHEDULES ERROR ===');
    logger.error('Error details:', {
      name: error.name,
      message: error.message,
      stack: error.stack,
    });
    throw error;
  }
}

function formatSchedule(schedule: CheckInSchedule): string {
  logger.info('Formatting schedule:', {
    scheduleId: schedule.scheduleId,
    teamMemberName: schedule.teamMemberUserName || schedule.teamMemberName,
    checkInType: schedule.checkInType,
    frequency: schedule.frequency,
    checkInTime: schedule.checkInTime,
  });

  const formatted = `
📅 Schedule ID: ${schedule.scheduleId}
👤 Team Member: ${schedule.teamMemberUserName || schedule.teamMemberName || schedule.teamMemberId || 'Unknown'}
📝 Type: ${schedule.checkInType}
📺 Channel ID: ${schedule.channelId}
⏰ Time: ${schedule.checkInTime}
🔄 Frequency: ${schedule.frequency}
📋 Created: ${new Date(schedule.createdAt).toLocaleString()}
`;

  logger.info('Successfully formatted schedule');
  return formatted;
}

export const listCheckInSchedules: Action = {
  name: 'listCheckInSchedules',
  description: 'Lists all check-in schedules for team members',
  similes: ['showCheckIns', 'getCheckInSchedules', 'viewCheckInSchedules'],
  validate: async (runtime: IAgentRuntime, message: Memory) => {
    logger.info('Validating listCheckInSchedules action:', {
      messageId: message.id,
      entityId: message.entityId,
      contentType: message.content?.type,
    });
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
      logger.info('=== LIST CHECK-IN SCHEDULES HANDLER START ===');
      logger.info('Handler details:', {
        messageId: message.id,
        entityId: message.entityId,
        hasCallback: !!callback,
        stateKeys: Object.keys(state),
        contextKeys: Object.keys(context),
      });

      if (!callback) {
        logger.warn('No callback function provided');
        return false;
      }

      // Fetch all check-in schedules
      logger.info('Fetching check-in schedules...');
      const schedules = await fetchCheckInSchedules(runtime);
      logger.info(`Retrieved ${schedules.length} schedules`);

      if (schedules.length === 0) {
        logger.info('No schedules found, sending empty response');
        await callback(
          {
            text: '📝 No check-in schedules found. Use the check-in command to create a new schedule.',
            source: 'discord',
          },
          []
        );
        return true;
      }

      // Format the schedules into a readable message
      logger.info('Formatting schedules for display...');
      const formattedSchedules = schedules.map(formatSchedule).join('\n-------------------\n');

      const content: Content = {
        text: `📋 Check-in Schedules (${schedules.length} total):\n${formattedSchedules}`,
        source: 'discord',
      };

      logger.info('Sending formatted schedules to callback');
      await callback(content, []);
      logger.info('Successfully sent check-in schedules list');
      logger.info('=== LIST CHECK-IN SCHEDULES HANDLER END ===');
      return true;
    } catch (error) {
      logger.error('=== LIST CHECK-IN SCHEDULES HANDLER ERROR ===');
      logger.error('Error details:', {
        name: error.name,
        message: error.message,
        stack: error.stack,
      });

      if (callback) {
        await callback(
          {
            text: '❌ Error retrieving check-in schedules. Please try again.',
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
        name: 'admin',
        content: { text: 'Show me all check-in schedules' },
      },
      {
        name: 'jimmy',
        content: {
          text: "Here are all the check-in schedules I've found",
          actions: ['listCheckInSchedules'],
        },
      },
    ],
    [
      {
        name: 'admin',
        content: { text: 'List team check-ins' },
      },
      {
        name: 'jimmy',
        content: {
          text: "I'll show you all active check-in schedules",
          actions: ['listCheckInSchedules'],
        },
      },
    ],
    [
      {
        name: 'admin',
        content: { text: 'list of checkins' },
      },
      {
        name: 'jimmy',
        content: {
          text: "I'll show you all active check-in schedules",
          actions: ['listCheckInSchedules'],
        },
      },
    ],
  ],
};
