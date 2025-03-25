// biome-ignore lint/style/useImportType: <explanation>
import type { IAgentRuntime, Plugin } from '@elizaos/core';
import { registerTeamMember } from './actions/registerTeamMember';
import { updateTeamMember } from './actions/updateTeamMember';
import { checkInTeamMember } from './actions/checkInTeamMember';
import { CheckInService } from './services/CheckInService';
import { logger } from '@elizaos/core';
import { listCheckInSchedules } from './actions/listCheckInSchedules';
import { DiscordChannelService } from './services/DiscordChannelService';
import { recordTeamMemberUpdates } from './actions/recordTeamMemberUpdates';
import { listTeamMemberUpdates } from './actions/listTeamMemberUpdates';
// import { listTeamMembers } from './actions/listTeamMembers';

/**
 * Plugin for team coordination functionality
 * Handles team member management, availability tracking, and check-ins
 */
export const teamCoordinatorPlugin: Plugin = {
  name: 'team-coordinator',
  description: 'Team Coordinator plugin for managing team activities',
  providers: [],
  actions: [
    checkInTeamMember,
    recordTeamMemberUpdates,
    listTeamMemberUpdates,
    listCheckInSchedules,
  ],
  init: async (config: Record<string, string>, runtime: IAgentRuntime) => {
    try {
      logger.info('Initializing Team Coordinator plugin...');

      // Register the services
      logger.info('Registering DiscordChannelService...');
      await runtime.registerService(DiscordChannelService);

      // Register and start the CheckIn service
      logger.info('Registering CheckInService...');
      await runtime.registerService(CheckInService);

      logger.info('Team Coordinator plugin initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize Team Coordinator plugin:', error);
      throw error;
    }
  },
  // List services that should be registered by the runtime
  services: [DiscordChannelService, CheckInService],
};

export function initialize(runtime: IAgentRuntime) {
  // Initialize services
  new CheckInService(runtime);
  // new ScheduleService(runtime);

  // Return actions
  return {
    actions: [
      checkInTeamMember,
      recordTeamMemberUpdates,
      listTeamMemberUpdates,
      listCheckInSchedules,
    ],
  };
}

export default {
  initialize,
};
