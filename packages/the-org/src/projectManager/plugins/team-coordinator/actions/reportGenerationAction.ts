import {
  type Action,
  type Content,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  ModelType,
  type UUID,
  createUniqueUuid,
  logger,
} from '@elizaos/core';
import type { TeamMemberUpdate } from '../../../types';

export async function generateTeamReport(
  runtime: IAgentRuntime,
  standupType: string,
  roomId?: string
): Promise<string> {
  try {
    logger.info('=== GENERATE TEAM REPORT START ===');
    logger.info(`Generating report for standup type: ${standupType}`);

    const roomIdLocal = createUniqueUuid(runtime, 'report-channel-config');

    // Get all messages from the room that match the standup type
    const memories = await runtime.getMemories({
      tableName: 'messages',
      agentId: runtime.agentId,
    });

    logger.info(`Retrieved ${memories.length} total messages from room`);

    // Filter for team member updates with matching standup type
    const updates = memories
      .filter((memory) => {
        const content = memory.content as {
          type?: string;
          update?: TeamMemberUpdate;
        };
        const contentType = content?.type;
        const requestedType = standupType.toLowerCase();
        const checkInType = content?.update?.checkInType;

        return contentType === 'team-member-update';
        // && checkInType === standupType
      })
      .map((memory) => (memory.content as { update: TeamMemberUpdate })?.update)
      .filter((update): update is TeamMemberUpdate => !!update)
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    logger.info(`Found ${updates.length} updates matching standup type: ${standupType}`);

    // Generate the report
    let report = `📊 **Team Progress Report - ${standupType} Standups**\n\n`;

    if (updates.length === 0) {
      report += `No updates found for "${standupType}" standups in this room.\n`;
      return report;
    }

    // Group updates by team member
    const updatesByMember: Record<string, TeamMemberUpdate[]> = {};
    for (const update of updates) {
      logger.info(
        `Processing update for team member: ${update.teamMemberName || 'Unknown'} (${update.teamMemberId})`
      );
      if (!updatesByMember[update.teamMemberId]) {
        updatesByMember[update.teamMemberId] = [];
      }
      updatesByMember[update.teamMemberId].push(update);
    }

    // Generate report for each team member
    for (const [teamMemberId, memberUpdates] of Object.entries(updatesByMember)) {
      const teamMemberName = memberUpdates[0]?.teamMemberName || 'Unknown';
      logger.info(`Generating report section for: ${teamMemberName} (${teamMemberId})`);
      report += `👤 **${teamMemberName}** (ID: ${teamMemberId})\n\n`;

      // Create prompt for analysis
      const prompt = `Analyze these team member updates and provide a detailed productivity report highlighting:
      1. Overall Progress: What major tasks/milestones were completed?
      2. Current Focus: What are they actively working on?
      3. Productivity Analysis: Are they meeting deadlines? Any patterns in their work?
      4. Blockers Impact: How are blockers affecting their progress?
      5. Recommendations: What could improve their productivity?

      Updates data: ${JSON.stringify(memberUpdates, null, 2)}`;

      logger.info('Generating productivity analysis for team member:', teamMemberName);

      try {
        const analysis = await runtime.useModel(ModelType.TEXT_LARGE, {
          prompt,
          stopSequences: [],
        });

        report += `📋 **Productivity Analysis**:\n${analysis}\n\n`;
        report += `📅 **Recent Updates**:\n`;

        // Add last 3 updates for reference
        const recentUpdates = memberUpdates.slice(0, 3);
        for (const update of recentUpdates) {
          report += `\n🕒 ${new Date(update.timestamp).toLocaleString()}\n`;
          report += `▫️ Progress: ${update.currentProgress}\n`;
          report += `▫️ Blockers: ${update.blockers}\n`;
          report += `▫️ Next Steps: ${update.nextSteps}\n`;
          report += `▫️ Anticipated Launch Date: ${update.AnticipatedLaunchDate || 'Not specified'}\n`;
        }
      } catch (error) {
        logger.error('Error generating analysis:', error);
        report += '❌ Error generating analysis. Showing raw updates:\n\n';

        for (const update of memberUpdates) {
          report += `Update from ${new Date(update.timestamp).toLocaleString()}:\n`;
          report += `▫️ Current Progress: ${update.currentProgress}\n`;
          report += `▫️ Blockers: ${update.blockers}\n`;
          report += `▫️ Next Steps: ${update.nextSteps}\n`;
          report += `▫️ Anticipated Launch Date: ${update.AnticipatedLaunchDate || 'Not specified'}\n`;
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
  name: 'GENERATE_REPORT',
  description: 'Generates a comprehensive report of team member updates and productivity analysis',
  similes: [
    'CREATE_REPORT',
    'TEAM_REPORT',
    'GET_TEAM_REPORT',
    'SHOW_TEAM_REPORT',
    'PRODUCE_TEAM_ANALYSIS',
  ],
  validate: async (runtime: IAgentRuntime, message: Memory) => {
    logger.info('Validating generateReport action');
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
      logger.info('=== GENERATE REPORT HANDLER START ===');

      if (!callback) {
        logger.warn('No callback function provided');
        return false;
      }

      // Extract standup type from message text
      const text = message.content?.text as string;
      if (!text) {
        logger.warn('No text content found in message');
        return false;
      }
      let standupType: string;

      // Use AI to parse the input text and extract standup type
      try {
        const prompt = `Extract the standup type from this text. try to understand the sentence , it's feel and after understand give output in these values: STANDUP, SPRINT, MENTAL_HEALTH, PROJECT_STATUS, RETRO. 
        if you can't figure out any standup type make STANDUP as default. answer should be one word "${text}"`;

        const parsedType = await runtime.useModel(ModelType.TEXT_LARGE, {
          prompt,
          stopSequences: [],
        });

        logger.info('AI parsed standup type:', parsedType);

        if (!state.standupType && !parsedType) {
          logger.info('Asking for standup type');
          const template = `Please select a check-in type:
          - Daily Standup (STANDUP)
          - Sprint Check-in (SPRINT) 
          - Mental Health Check-in (MENTAL_HEALTH)
          - Project Status Update (PROJECT_STATUS)
          - Team Retrospective (RETRO)`;

          const promptContent: Content = {
            text: template,
            source: 'discord',
          };
          await callback(promptContent, []);
          return true;
        }

        standupType = ((state.standupType as string) || parsedType)?.toLowerCase()?.trim();

        logger.info('Generating report with parameters:', {
          standupType,
          roomId: message.roomId,
        });

        // Validate standup type with more flexible matching
        const validTypes = ['standup', 'sprint', 'mental_health', 'project_status', 'retro'];
        const isValidType = validTypes.some((type) => standupType === type);

        if (!isValidType) {
          await callback(
            {
              text: 'Invalid check-in type. Please select one of: Daily Standup, Sprint Check-in, Mental Health Check-in, Project Status Update, or Team Retrospective',
              source: 'discord',
            },
            []
          );
          return false;
        }
      } catch (aiError) {
        logger.error('Error using AI to parse input:', aiError);
        await callback(
          {
            text: "I couldn't understand the check-in type. Please try again with a valid type.",
            source: 'discord',
          },
          []
        );
        return false;
      }

      // Generate the report
      const report = await generateTeamReport(runtime, standupType, message.roomId);

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

      if (callback) {
        const errorContent: Content = {
          text: '❌ An error occurred while generating the report. Please try again.',
          source: 'discord',
        };
        await callback(errorContent, []);
      }
      return false;
    }
  },
  examples: [
    [
      {
        name: '{{name1}}',
        content: { text: 'Generate report' },
      },
      {
        name: '{{botName}}',
        content: {
          text: "I'll generate a daily standup report for you",
          actions: ['GENERATE_REPORT'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: { text: 'generate a report' },
      },
      {
        name: '{{botName}}',
        content: {
          text: "I'll create a sprint check-in report",
          actions: ['GENERATE_REPORT'],
        },
      },
    ],
  ],
};
