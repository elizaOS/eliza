// biome-ignore lint/style/useImportType: <explanation>
import { type Plugin } from '@elizaos/core';
import { registerTeamMember } from './actions/registerTeamMember';
import { updateTeamMember } from './actions/updateTeamMember';
import { checkInTeamMember } from './actions/checkInTeamMember';
import { listTeamMembers } from './actions/listTeamMembers';
// import { TeamCoordinatorService } from "./services/teamCoordinatorService";

/**
 * Plugin for team coordination functionality
 * Handles team member management, availability tracking, and check-ins
 */
export const teamCoordinatorPlugin: Plugin = {
  name: 'team-coordinator',
  description: 'Team coordination plugin for Jimmy',
  providers: [],
  actions: [registerTeamMember, updateTeamMember, checkInTeamMember, listTeamMembers],
  // services: [TeamCoordinatorService],
};
