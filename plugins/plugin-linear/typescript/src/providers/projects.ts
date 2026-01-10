import type { IAgentRuntime, Memory, Provider, State } from '@elizaos/core';
import { LinearService } from '../services/linear';

export const linearProjectsProvider: Provider = {
  name: 'LINEAR_PROJECTS',
  description: 'Provides context about active Linear projects',
  get: async (runtime: IAgentRuntime, _message: Memory, _state: State) => {
    try {
      const linearService = runtime.getService<LinearService>('linear');
      if (!linearService) {
        return {
          text: 'Linear service is not available',
        };
      }
      
      const projects = await linearService.getProjects();
      
      if (projects.length === 0) {
        return {
          text: 'No Linear projects found',
        };
      }
      
      // Filter active projects
      const activeProjects = projects.filter((project: any) => 
        project.state === 'started' || project.state === 'planned'
      );
      
      const projectsList = activeProjects.slice(0, 10).map((project: any) => 
        `- ${project.name}: ${project.state} (${project.startDate || 'No start date'} - ${project.targetDate || 'No target date'})`
      );
      
      const text = `Active Linear Projects:\n${projectsList.join('\n')}`;
      
      return {
        text,
        data: {
          projects: activeProjects.slice(0, 10).map((project: any) => ({
            id: project.id,
            name: project.name,
            state: project.state,
          })),
        },
      };
    } catch (error) {
      return {
        text: 'Error retrieving Linear projects',
      };
    }
  },
}; 