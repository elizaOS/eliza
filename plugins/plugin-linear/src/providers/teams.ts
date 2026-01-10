import type { IAgentRuntime, Memory, Provider, State } from '@elizaos/core';
import { LinearService } from '../services/linear';

export const linearTeamsProvider: Provider = {
  name: 'LINEAR_TEAMS',
  description: 'Provides context about Linear teams',
  get: async (runtime: IAgentRuntime, _message: Memory, _state: State) => {
    try {
      const linearService = runtime.getService<LinearService>('linear');
      if (!linearService) {
        return {
          text: 'Linear service is not available',
        };
      }
      
      const teams = await linearService.getTeams();
      
      if (teams.length === 0) {
        return {
          text: 'No Linear teams found',
        };
      }
      
      const teamsList = teams.map((team: any) => 
        `- ${team.name} (${team.key}): ${team.description || 'No description'}`
      );
      
      const text = `Linear Teams:\n${teamsList.join('\n')}`;
      
      return {
        text,
        data: {
          teams: teams.map((team: any) => ({
            id: team.id,
            name: team.name,
            key: team.key,
          })),
        },
      };
    } catch (error) {
      return {
        text: 'Error retrieving Linear teams',
      };
    }
  },
}; 