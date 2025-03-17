import {
  type Action,
  type ActionExample,
  type IAgentRuntime,
  type Memory,
  type UUID,
  createUniqueUuid,
  logger,
} from '@elizaos/core';
import type { Project, TeamMember } from '../../../types';

/**
 * Helper function to format team members for display
 * @param teamMembers Array of team members to format
 * @returns Formatted string of team members
 */
function formatTeamMembersForDisplay(teamMembers: TeamMember[]): string {
  if (!teamMembers || teamMembers.length === 0) {
    return 'No team members found.';
  }

  return teamMembers
    .map((member, index) => {
      const roleInfo = member.role ? ` (${member.role})` : '';
      const availabilityInfo =
        member.availability?.employmentStatus ||
        (typeof member.availability === 'string' ? member.availability : '');
      const emailInfo = member.email ? ` - ${member.email}` : '';

      return `${index + 1}. ${member.name}${roleInfo}${emailInfo} - ${availabilityInfo}`;
    })
    .join('\n');
}

/**
 * Interface for team member memory content
 */
interface TeamMemberContent {
  type: 'team-member';
  member: TeamMember;
  discordHandle?: string;
}

/**
 * Interface for project memory content
 */
interface ProjectContent {
  type: 'project';
  project: Project;
}

/**
 * Action to list all team members or filter by project
 */
export const listTeamMembers: Action = {
  name: 'listTeamMembers',
  similes: ['GET_TEAM_MEMBERS', 'FETCH_TEAM_MEMBERS', 'LIST_MEMBERS'],
  description: 'Lists all team members or filters by project',
  validate: async (runtime: IAgentRuntime, message: any) => {
    return true;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: any,
    state: any,
    context: any
  ): Promise<TeamMember[]> => {
    const projectId = message?.projectId;
    try {
      logger.info(`Listing team members${projectId ? ` for project: ${projectId}` : ''}`);

      // Create a unique room ID for team members (must match the one in registerTeamMember)
      const teamMembersRoomId = createUniqueUuid(runtime, 'team-members');
      logger.info(`Team members room ID: ${teamMembersRoomId}`);

      // Retrieve all team member memories from the room
      const teamMemberMemories = await runtime.getMemories({
        roomId: teamMembersRoomId,
        tableName: 'messages',
      });

      // Log the raw memories for debugging
      logger.info(`Raw team member memories: ${JSON.stringify(teamMemberMemories)}`);

      // Filter memories by type and convert to TeamMember objects
      const allTeamMembers = teamMemberMemories
        .filter(
          (memory) => memory && memory.content?.type === 'team-member' && memory.content?.member
        )
        .map((memory) => (memory.content as unknown as TeamMemberContent).member);

      console.log(allTeamMembers, 'allTeammembers');
      if (projectId) {
        // If projectId is provided, we need to get the project data to filter team members
        const projectsRoomId = createUniqueUuid(runtime, 'projects');
        const projectMemories = await runtime.getMemories({
          roomId: projectsRoomId,
          tableName: 'messages',
        });

        // Find the specified project
        const projectMemory = (projectMemories as Array<Memory & { content: ProjectContent }>).find(
          (memory) => memory.content.project && memory.content.project.id === projectId
        );

        if (!projectMemory || !projectMemory.content.project) {
          logger.warn(`Project with ID ${projectId} not found`);
          return [];
        }

        const project = projectMemory.content.project;

        // Filter team members by project
        const projectTeamMembers = allTeamMembers.filter((member) =>
          project.teamMembers?.includes(member.id)
        );

        logger.info(`Found ${projectTeamMembers.length} team members for project ${projectId}`);
        return projectTeamMembers;
      }

      // Otherwise, return all team members
      logger.info(`Found ${allTeamMembers.length} team members total`);

      if (allTeamMembers.length === 0) {
        logger.warn('No team members found! Check if team members have been registered correctly.');
      } else {
        logger.info(
          `Team members: ${JSON.stringify(allTeamMembers.map((m) => ({ id: m.id, name: m.name })))}`
        );
      }

      return allTeamMembers;
    } catch (error) {
      logger.error(`Error listing team members: ${error}`);
      throw error;
    }
  },

  examples: [
    [
      {
        name: 'TeamMember1',
        content: {
          text: 'Get all team members',
        },
      },
      {
        name: 'TeamCoordinator',
        content: {
          text: 'Here are all our registered team members:\n\n1. Alice (Developer) - Full-time\n2. Bob (Designer) - Part-time\n3. Charlie (Manager) - Full-time',
          actions: ['listTeamMembers'],
          result: [
            {
              id: 'member1',
              name: 'Alice',
              role: 'Developer',
              email: 'alice@example.com',
              availability: 'Full-time',
            },
            {
              id: 'member2',
              name: 'Bob',
              role: 'Designer',
              email: 'bob@example.com',
              availability: 'Part-time',
            },
            {
              id: 'member3',
              name: 'Charlie',
              role: 'Manager',
              email: 'charlie@example.com',
              availability: 'Full-time',
            },
          ],
        },
      },
    ],
    [
      {
        name: 'TeamMember1',
        content: {
          text: 'Who are all the team members?',
        },
      },
      {
        name: 'TeamCoordinator',
        content: {
          text: 'The full team roster includes:\n\n- Alice (alice@example.com): Developer, Full-time\n- Bob (bob@example.com): Designer, Part-time\n- Charlie (charlie@example.com): Manager, Full-time',
          actions: ['listTeamMembers'],
          result: [
            {
              id: 'member1',
              name: 'Alice',
              role: 'Developer',
              email: 'alice@example.com',
              availability: 'Full-time',
            },
            {
              id: 'member2',
              name: 'Bob',
              role: 'Designer',
              email: 'bob@example.com',
              availability: 'Part-time',
            },
            {
              id: 'member3',
              name: 'Charlie',
              role: 'Manager',
              email: 'charlie@example.com',
              availability: 'Full-time',
            },
          ],
        },
      },
    ],
  ] as ActionExample[][],
};
