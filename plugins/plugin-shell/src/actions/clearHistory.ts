import {
  type Action,
  type ActionExample,
  type Content,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
  logger,
} from '@elizaos/core';
import { ShellService } from '../services/shellService';

export const clearHistory: Action = {
  name: 'CLEAR_SHELL_HISTORY',
  similes: ['RESET_SHELL', 'CLEAR_TERMINAL', 'CLEAR_HISTORY', 'RESET_HISTORY'],
  description: 'Clears the recorded history of shell commands for the current conversation',
  validate: async (runtime: IAgentRuntime, message: Memory, _state: State) => {
    // Check if shell service is available
    const shellService = runtime.getService<ShellService>('shell');
    if (!shellService) {
      return false;
    }
    
    // Check if message contains clear history intent
    const text = message.content.text?.toLowerCase() || '';
    const clearKeywords = ['clear', 'reset', 'delete', 'remove', 'clean'];
    const historyKeywords = ['history', 'terminal', 'shell', 'command'];
    
    // Must have at least one clear keyword and one history keyword
    const hasClearKeyword = clearKeywords.some(keyword => text.includes(keyword));
    const hasHistoryKeyword = historyKeywords.some(keyword => text.includes(keyword));
    
    return hasClearKeyword && hasHistoryKeyword;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State,
    _options: any,
    callback: HandlerCallback
  ) => {
    const shellService = runtime.getService<ShellService>('shell');
    
    if (!shellService) {
      await callback({
        text: 'Shell service is not available.',
        source: message.content.source,
      });
      return;
    }

    try {
      // Get conversation ID
      const conversationId = message.roomId || message.agentId;
      
      // Clear the history
      shellService.clearCommandHistory(conversationId);
      
      logger.info(`Cleared shell history for conversation: ${conversationId}`);

      const response: Content = {
        text: 'Shell command history has been cleared.',
        source: message.content.source,
      };

      await callback(response);
    } catch (error) {
      logger.error('Error clearing shell history:', error);
      await callback({
        text: `Failed to clear shell history: ${error instanceof Error ? error.message : 'Unknown error'}`,
        source: message.content.source,
      });
    }
  },
  examples: [
    [
      {
        name: '{{name1}}',
        content: {
          text: 'clear my shell history',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: 'Shell command history has been cleared.',
          actions: ['CLEAR_SHELL_HISTORY'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'reset the terminal history',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: 'Shell command history has been cleared.',
          actions: ['CLEAR_SHELL_HISTORY'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'delete command history',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: 'Shell command history has been cleared.',
          actions: ['CLEAR_SHELL_HISTORY'],
        },
      },
    ],
  ] as ActionExample[][],
} as Action;

export default clearHistory; 