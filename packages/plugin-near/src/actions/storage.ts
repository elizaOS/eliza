import {
  type ActionExample,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  ModelClass,
  type State,
  elizaLogger,
  type Action,
  composeContext,
  generateObject,
} from '@elizaos/core';
import { z } from 'zod';
import { StorageService } from '../services/StorageService';
import { NearPluginError, formatErrorMessage, isNearError } from '../core/errors';

export const StorageSetSchema = z.object({
  key: z.string(),
  value: z.any(),
  shared: z.boolean().optional(),
});

export const StorageGetSchema = z.object({
  key: z.string(),
  fromAgent: z.string().optional(),
});

const storageExamples: ActionExample[][] = [
  [
    {
      user: '{{user1}}',
      content: {
        text: 'Remember that the user prefers dark mode',
      },
    },
    {
      user: '{{agentName}}',
      content: {
        text: "I'll save your dark mode preference on-chain for future reference.",
        action: 'SAVE_MEMORY',
      },
    },
    {
      user: '{{agentName}}',
      content: {
        text: 'I\'ve saved that information on-chain under the key "user_preferences". This memory will persist across sessions and restarts.',
      },
    },
  ],
  [
    {
      user: '{{user1}}',
      content: {
        text: 'Save the analysis results for project X',
      },
    },
    {
      user: '{{agentName}}',
      content: {
        text: "I'll store the project X analysis results on-chain.",
        action: 'SAVE_MEMORY',
      },
    },
  ],
];

const saveMemoryAction: Action = {
  name: 'SAVE_MEMORY',
  similes: ['REMEMBER', 'STORE', 'SAVE_DATA', 'PERSIST'],
  description: 'Save important information to persistent on-chain storage',

  examples: [
    [
      {
        user: 'alice',
        content: {
          text: 'Remember that the user prefers dark mode interfaces',
          source: 'discord',
        },
      },
      {
        user: 'agent',
        content: {
          text: "I've saved that preference to my persistent memory. I'll remember that the user prefers dark mode interfaces.",
          source: 'discord',
          actions: ['SAVE_MEMORY'],
        },
      },
    ],
    [
      {
        user: 'bob',
        content: {
          text: 'Store the API endpoint as https://api.example.com/v2',
          source: 'telegram',
        },
      },
      {
        user: 'agent',
        content: {
          text: "I've stored the API endpoint (https://api.example.com/v2) in my persistent storage.",
          source: 'telegram',
          actions: ['SAVE_MEMORY'],
        },
      },
    ],
  ],

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
    const storageService = runtime.getService<StorageService>('near-storage' as any);
    if (!storageService) {
      elizaLogger.warn('Storage service not available');
      return false;
    }

    // Check if the message contains something to remember
    const text = message.content.text?.toLowerCase() || '';
    const hasStorageIntent =
      text.includes('remember') ||
      text.includes('store') ||
      text.includes('save') ||
      text.includes('persist');

    return hasStorageIntent;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<boolean> => {
    try {
      const storageService = runtime.getService<StorageService>('near-storage' as any);
      if (!storageService) {
        throw new Error('Storage service not available');
      }

      const text = message.content.text || '';

      // Extract what to remember
      let dataToStore: any = { text };
      let key = '';

      // Parse the intent
      if (text.includes('remember that')) {
        const match = text.match(/remember that (.+)/i);
        if (match) {
          dataToStore = { memory: match[1], timestamp: Date.now() };
          key = `memory:${Date.now()}`;
        }
      } else if (text.includes('store') || text.includes('save')) {
        // Try to extract key-value pairs
        const kvMatch = text.match(/(?:store|save)\s+(?:the\s+)?(\w+)\s+(?:as|=|:)\s+(.+)/i);
        if (kvMatch) {
          key = kvMatch[1];
          dataToStore = kvMatch[2];
        } else {
          key = `data:${Date.now()}`;
          dataToStore = { content: text, timestamp: Date.now() };
        }
      }

      if (!key) {
        key = `memory:${Date.now()}`;
      }

      // Store the data
      await storageService.set(key, dataToStore);

      elizaLogger.success(`Stored data with key: ${key}`);

      // Prepare response
      const response = `I've saved that information to my persistent memory (key: ${key}). I'll remember it for future reference.`;

      if (callback) {
        await callback({
          text: response,
          source: message.content.source,
          content: {
            key,
            stored: dataToStore,
          },
        });
      }

      return true;
    } catch (error) {
      elizaLogger.error('Failed to save memory:', error);

      if (callback) {
        await callback({
          text: 'I encountered an error while trying to save that information.',
          source: message.content.source,
        });
      }

      return false;
    }
  },
};

const retrieveMemoryAction: Action = {
  name: 'RETRIEVE_MEMORY',
  similes: ['RECALL', 'GET_MEMORY', 'FETCH_DATA', 'REMEMBER_WHAT'],
  description: 'Retrieve previously stored information from persistent storage',

  examples: [
    [
      {
        user: 'alice',
        content: {
          text: 'What did I tell you to remember about my preferences?',
          source: 'discord',
        },
      },
      {
        user: 'agent',
        content: {
          text: 'Let me check my memories... I remember that you prefer dark mode interfaces.',
          source: 'discord',
          actions: ['RETRIEVE_MEMORY'],
        },
      },
    ],
    [
      {
        user: 'bob',
        content: {
          text: 'Recall the API endpoint I gave you',
          source: 'telegram',
        },
      },
      {
        user: 'agent',
        content: {
          text: 'I found the stored API endpoint: https://api.example.com/v2',
          source: 'telegram',
          actions: ['RETRIEVE_MEMORY'],
        },
      },
    ],
  ],

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
    const storageService = runtime.getService<StorageService>('near-storage' as any);
    if (!storageService) {
      return false;
    }

    const text = message.content.text?.toLowerCase() || '';
    const hasRetrieveIntent =
      text.includes('recall') ||
      text.includes('what did') ||
      text.includes('retrieve') ||
      text.includes('fetch') ||
      (text.includes('get') && text.includes('memory'));

    return hasRetrieveIntent;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<boolean> => {
    try {
      const storageService = runtime.getService<StorageService>('near-storage' as any);
      if (!storageService) {
        throw new Error('Storage service not available');
      }

      const text = message.content.text || '';

      // Try to extract specific key
      let searchKey = '';
      const keyMatch = text.match(/(?:recall|retrieve|get|fetch)\s+(?:the\s+)?(\w+)/i);
      if (keyMatch) {
        searchKey = keyMatch[1];
      }

      let retrievedData = null;
      let foundKey = '';

      if (searchKey) {
        // Try direct key lookup
        retrievedData = await storageService.get(searchKey);
        if (retrievedData) {
          foundKey = searchKey;
        }
      }

      // If no direct match, search through recent memories
      if (!retrievedData) {
        const keys = await storageService.listKeys();

        // Search for relevant keys
        for (const key of keys) {
          if (searchKey && key.includes(searchKey)) {
            retrievedData = await storageService.get(key);
            foundKey = key;
            break;
          }

          // Check memory keys for recent memories
          if (key.startsWith('memory:')) {
            const data = await storageService.get(key);
            if (data && typeof data === 'object' && 'memory' in data) {
              // Check if this memory is relevant
              if (
                !searchKey ||
                (data.memory as string).toLowerCase().includes(searchKey.toLowerCase())
              ) {
                retrievedData = data;
                foundKey = key;
                break;
              }
            }
          }
        }
      }

      let response: string;
      if (retrievedData) {
        if (typeof retrievedData === 'object' && 'memory' in retrievedData) {
          response = `I found a stored memory: "${retrievedData.memory}"`;
        } else if (typeof retrievedData === 'string') {
          response = `I retrieved the stored data: ${retrievedData}`;
        } else {
          response = `I found stored data (${foundKey}): ${JSON.stringify(retrievedData, null, 2)}`;
        }
      } else {
        response = searchKey
          ? `I couldn't find any stored data matching "${searchKey}"`
          : "I couldn't find any relevant stored memories";
      }

      if (callback) {
        await callback({
          text: response,
          source: message.content.source,
          content: {
            key: foundKey,
            retrieved: retrievedData,
          },
        });
      }

      return true;
    } catch (error) {
      elizaLogger.error('Failed to retrieve memory:', error);

      if (callback) {
        await callback({
          text: 'I encountered an error while trying to retrieve that information.',
          source: message.content.source,
        });
      }

      return false;
    }
  },
};

export const storageActions = [saveMemoryAction, retrieveMemoryAction];
