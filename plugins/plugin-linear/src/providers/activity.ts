import type { IAgentRuntime, Memory, Provider, State } from '@elizaos/core';
import { LinearService } from '../services/linear';
import type { LinearActivityItem } from '../types';

export const linearActivityProvider: Provider = {
  name: 'LINEAR_ACTIVITY',
  description: 'Provides context about recent Linear activity',
  get: async (runtime: IAgentRuntime, _message: Memory, _state: State) => {
    try {
      const linearService = runtime.getService<LinearService>('linear');
      if (!linearService) {
        return {
          text: 'Linear service is not available',
        };
      }
      
      const activity = linearService.getActivityLog(10);
      
      if (activity.length === 0) {
        return {
          text: 'No recent Linear activity',
        };
      }
      
      const activityList = activity.map((item: LinearActivityItem) => {
        const status = item.success ? '✓' : '✗';
        const time = new Date(item.timestamp).toLocaleTimeString();
        return `${status} ${time}: ${item.action} ${item.resource_type} ${item.resource_id}`;
      });
      
      const text = `Recent Linear Activity:\n${activityList.join('\n')}`;
      
      return {
        text,
        data: {
          activity: activity.slice(0, 10),
        },
      };
    } catch (error) {
      return {
        text: 'Error retrieving Linear activity',
      };
    }
  },
}; 