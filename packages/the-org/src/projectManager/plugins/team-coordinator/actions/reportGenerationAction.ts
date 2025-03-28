import {
  type Action,
  type Content,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type UUID,
  logger,
} from '@elizaos/core';
import { fetchCheckInSchedules } from './listCheckInSchedules';

interface TeamMemberUpdate {
  type: 'team-member-update';
  updateId: UUID;
  teamMemberId: UUID;
  currentProgress: string;
  workingOn: string;
  nextSteps: string;
  blockers: string;
  eta: string;
  timestamp: string;
  channelId?: UUID;
}

async function generateTeamReport(runtime: IAgentRuntime): Promise<string> {
  try {
    logger.info('=== GENERATE TEAM REPORT START ===');

    // Fetch all check-in schedules
    const schedules = await fetchCheckInSchedules(runtime);
    logger.info(`Retrieved ${schedules.length} check-in schedules`);

    // Get updates for each team member with a schedule
    const reportData = await Promise.all(
      schedules.map(async (schedule) => {
        const memories = await runtime.getMemories({
          entityId: schedule.teamMemberId as UUID,
          tableName: 'messages',
        });

        const updates = memories
          .filter(
            (memory) =>
              memory.content?.type === 'team-member-update' &&
              (memory.content as { update: TeamMemberUpdate })?.update?.teamMemberId ===
                schedule.teamMemberId
          )
          .map((memory) => (memory.content as { update: TeamMemberUpdate })?.update)
          .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

        logger.info(`Found ${updates.length} updates for team member ${schedule.teamMemberId}`);
        return { schedule, updates };
      })
    );

    // Generate the report
    let report = '📊 **Team Progress Report**\n\n';

    for (const { schedule, updates } of reportData) {
      report += `👤 **Team Member ID: ${schedule.teamMemberId}**\n`;
      report += `📅 Check-in Schedule: ${schedule.frequency} at ${schedule.checkInTime}\n\n`;

      if (updates.length === 0) {
        report += '❗ No updates submitted\n';
      } else {
        // Prepare updates data for AI summarization
        const updatesForAI = updates.map((update) => ({
          timestamp: new Date(update.timestamp).toLocaleString(),
          currentProgress: update.currentProgress,
          workingOn: update.workingOn,
          blockers: update.blockers,
          nextSteps: update.nextSteps,
          eta: update.eta,
        }));

        logger.info('Preparing AI prompt for updates summarization');

        // Create AI prompt for summarization
        const prompt = `Please analyze these team member updates and provide a concise summary highlighting:
        1. Key progress points and achievements
        2. Main ongoing work items
        3. Common blockers or challenges
        4. Overall timeline and next steps
        
        Updates data: ${JSON.stringify(updatesForAI, null, 2)}`;

        try {
          // Call AI service for summarization
          const aiService = runtime.getService('ai');
          logger.info('Calling AI service for updates summarization');

          // First check if the service exists and has the required method
          if (!aiService || typeof (aiService as any).generateText !== 'function') {
            throw new Error('AI service not properly configured');
          }

          const summary = await (aiService as any).generateText(prompt);
          report += `AI Summary:\n${summary}\n\n`;
        } catch (aiError) {
          logger.error('Error generating AI summary:', aiError);
          // Fallback to regular updates if AI fails
          report += 'All Updates:\n\n';
          for (const update of updates) {
            report += `Update from ${new Date(update.timestamp).toLocaleString()}:\n`;
            report += `▫️ Current Progress: ${update.currentProgress}\n`;
            report += `▫️ Working On: ${update.workingOn}\n`;
            report += `▫️ Blockers: ${update.blockers}\n`;
            report += `▫️ Next Steps: ${update.nextSteps}\n`;
            report += `▫️ ETA: ${update.eta}\n\n`;
          }
        }
      }
      report += '\n-------------------\n\n';
    }

    logger.info('Successfully generated team report');
    logger.info('=== GENERATE TEAM REPORT END ===');
    return report;
  } catch (error) {
    logger.error('Error generating team report:', error);
    throw error;
  }
}

export const generateReport: Action = {
  name: 'generateReport',
  description: 'Generates a comprehensive report of team member updates and check-in schedules',
  similes: ['createReport', 'teamReport', 'getTeamReport', 'showTeamReport'],
  validate: async (runtime: IAgentRuntime, message: Memory) => {
    logger.info('Validating generateReport action');

    // Check if user is an admin or owner
    const isAdmin = message.content?.role === 'admin' || message.content?.role === 'owner';
    logger.info(`User validation - isAdmin: ${isAdmin}`);

    return isAdmin;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: Record<string, unknown>,
    context: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<boolean> => {
    try {
      logger.info('=== GENERATE REPORT HANDLER START ===');

      if (!callback) {
        logger.warn('No callback function provided');
        return false;
      }

      const report = await generateTeamReport(runtime);

      const content: Content = {
        text: report,
        source: 'discord',
      };

      await callback(content, []);
      logger.info('=== GENERATE REPORT HANDLER END ===');
      return true;
    } catch (error) {
      logger.error('=== GENERATE REPORT HANDLER ERROR ===');
      logger.error('Error details:', {
        name: error.name,
        message: error.message,
        stack: error.stack,
      });

      // Don't call callback again if there's an error
      return false;
    }
  },
  examples: [
    [
      {
        name: 'owner',
        content: { text: 'Generate team report' },
      },
      {
        name: 'jimmy',
        content: {
          text: "I'll generate a comprehensive team report for you",
          actions: ['generateReport'],
        },
      },
    ],
    [
      {
        name: 'owner',
        content: { text: 'Show me the team progress report' },
      },
      {
        name: 'jimmy',
        content: {
          text: "I'll create a team progress report",
          actions: ['generateReport'],
        },
      },
    ],
  ],
};
