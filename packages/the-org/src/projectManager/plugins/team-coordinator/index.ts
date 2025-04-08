// biome-ignore lint/style/useImportType: <explanation>
import type { IAgentRuntime, Plugin } from '@elizaos/core';
import { checkInFormatAction } from './actions/checkInFormatAction';
import { CheckInService } from './services/CheckInService';
import { logger } from '@elizaos/core';
import { listCheckInSchedules } from './actions/listCheckInSchedules';
import { TeamUpdateTrackerService } from './services/TeamUpdateTrackerService';
import { recordTeamMemberUpdates } from './actions/recordTeamMemberUpdates';
import { recordCheckInAction } from './actions/recordCheckInAction';
import { generateReport } from './actions/reportGenerationAction';
import { registerTasks } from './tasks';

/**
 * Plugin for team coordination functionality
 * Handles team member management, availability tracking, and check-ins
 */
export const teamCoordinatorPlugin: Plugin = {
  name: 'team-coordinator',
  description: 'Team Coordinator plugin for managing team activities',
  providers: [],
  actions: [
    checkInFormatAction,
    recordTeamMemberUpdates,
    listCheckInSchedules,
    generateReport,
    recordCheckInAction,
  ],
  init: async (config: Record<string, string>, runtime: IAgentRuntime) => {
    try {
      logger.info('Initializing Team Coordinator plugin...');

      // Register the services
      logger.info('Registering TeamUpdateTrackerService...');
      await runtime.registerService(TeamUpdateTrackerService);

      // Register and start the CheckIn service
      logger.info('Registering CheckInService...');
      await runtime.registerService(CheckInService);

      // Register tasks
      logger.info('Registering team coordinator tasks...');
      await registerTasks(runtime);

      logger.info('Team Coordinator plugin initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize Team Coordinator plugin:', error);
      throw error;
    }
  },
  // List services that should be registered by the runtime
  services: [TeamUpdateTrackerService, CheckInService],
};

export function initialize(runtime: IAgentRuntime) {
  // Initialize services
  new CheckInService(runtime);
  // new ScheduleService(runtime);

  // Return actions
  return {
    actions: [
      checkInFormatAction,
      recordTeamMemberUpdates,
      listCheckInSchedules,
      generateReport,
      recordCheckInAction,
    ],
  };
}

export default {
  initialize,
};
