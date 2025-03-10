import {
  type Action,
  type IAgentRuntime,
  type Memory,
  type UUID,
  createUniqueUuid,
  logger,
} from "@elizaos/core";
import type { Project, TeamMember } from "../../../types";

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
  name: "listTeamMembers",
  description: "Lists all team members or filters by project",
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
      const teamMembersRoomId = createUniqueUuid(runtime, "team-members");
      
      // Retrieve all team member memories from the room
      const teamMemberMemories = await runtime.getMemoryManager("messages").getMemories({
        roomId: teamMembersRoomId
      });
      
      // Convert memories to TeamMember objects
      const allTeamMembers = (teamMemberMemories as Array<Memory & { content: TeamMemberContent }>)
        .map(memory => memory.content.member);
      
      if (projectId) {
        // If projectId is provided, we need to get the project data to filter team members
        const projectsRoomId = createUniqueUuid(runtime, "projects");
        const projectMemories = await runtime.getMemoryManager("messages").getMemories({
          roomId: projectsRoomId
        });
        
        // Find the specified project
        const projectMemory = (projectMemories as Array<Memory & { content: ProjectContent }>).find(memory => 
          memory.content.project && memory.content.project.id === projectId
        );
        
        if (!projectMemory || !projectMemory.content.project) {
          logger.warn(`Project with ID ${projectId} not found`);
          return [];
        }
        
        const project = projectMemory.content.project;
        
        // Filter team members by project
        const projectTeamMembers = allTeamMembers.filter(member => 
          project.teamMembers?.includes(member.id)
        );
        
        logger.info(`Found ${projectTeamMembers.length} team members for project ${projectId}`);
        return projectTeamMembers;
      }
      
      // Otherwise, return all team members
      logger.info(`Found ${allTeamMembers.length} team members total`);      
      return allTeamMembers;
    } catch (error) {
      logger.error(`Error listing team members: ${error}`);
      throw error;
    }
  },
};
