import type {
  Action,
  Content,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from '@elizaos/core';
import { logger, stringToUuid } from '@elizaos/core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { KnowledgeService } from './service.ts';
import { AddKnowledgeOptions } from './types.ts';

/**
 * Action to process knowledge from files or text
 */
export const processKnowledgeAction: Action = {
  name: 'PROCESS_KNOWLEDGE',
  description:
    'Process and store knowledge from a file path or text content into the knowledge base',

  similes: [],

  examples: [
    [
      {
        name: 'user',
        content: {
          text: 'Process the document at /path/to/document.pdf',
        },
      },
      {
        name: 'assistant',
        content: {
          text: "I'll process the document at /path/to/document.pdf and add it to my knowledge base.",
          actions: ['PROCESS_KNOWLEDGE'],
        },
      },
    ],
    [
      {
        name: 'user',
        content: {
          text: 'Add this to your knowledge: The capital of France is Paris.',
        },
      },
      {
        name: 'assistant',
        content: {
          text: "I'll add that information to my knowledge base.",
          actions: ['PROCESS_KNOWLEDGE'],
        },
      },
    ],
  ],

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
    const text = message.content.text?.toLowerCase() || '';

    // Check if the message contains knowledge-related keywords
    const knowledgeKeywords = [
      'process',
      'add',
      'upload',
      'document',
      'knowledge',
      'learn',
      'remember',
      'store',
      'ingest',
      'file',
    ];

    const hasKeyword = knowledgeKeywords.some((keyword) => text.includes(keyword));

    // Check if there's a file path mentioned
    const pathPattern = /(?:\/[\w.-]+)+|(?:[a-zA-Z]:[\\/][\w\s.-]+(?:[\\/][\w\s.-]+)*)/;
    const hasPath = pathPattern.test(text);

    // Check if service is available
    const service = runtime.getService(KnowledgeService.serviceType);
    if (!service) {
      logger.warn('Knowledge service not available for PROCESS_KNOWLEDGE action');
      return false;
    }

    return hasKeyword || hasPath;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ) => {
    try {
      const service = runtime.getService<KnowledgeService>(KnowledgeService.serviceType);
      if (!service) {
        throw new Error('Knowledge service not available');
      }

      const text = message.content.text || '';

      // Extract file path from message
      const pathPattern = /(?:\/[\w.-]+)+|(?:[a-zA-Z]:[\\/][\w\s.-]+(?:[\\/][\w\s.-]+)*)/;
      const pathMatch = text.match(pathPattern);

      let response: Content;

      if (pathMatch) {
        // Process file from path
        const filePath = pathMatch[0];

        // Check if file exists
        if (!fs.existsSync(filePath)) {
          response = {
            text: `I couldn't find the file at ${filePath}. Please check the path and try again.`,
          };

          if (callback) {
            await callback(response);
          }
          return;
        }

        // Read file
        const fileBuffer = fs.readFileSync(filePath);
        const fileName = path.basename(filePath);
        const fileExt = path.extname(filePath).toLowerCase();

        // Determine content type
        let contentType = 'text/plain';
        if (fileExt === '.pdf') contentType = 'application/pdf';
        else if (fileExt === '.docx')
          contentType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
        else if (fileExt === '.doc') contentType = 'application/msword';
        else if (['.txt', '.md', '.tson', '.xml', '.csv'].includes(fileExt))
          contentType = 'text/plain';

        // Prepare knowledge options
        const knowledgeOptions: AddKnowledgeOptions = {
          clientDocumentId: stringToUuid(runtime.agentId + fileName + Date.now()),
          contentType,
          originalFilename: fileName,
          worldId: runtime.agentId,
          content: fileBuffer.toString('base64'),
          roomId: message.roomId,
          entityId: message.entityId,
        };

        // Process the document
        const result = await service.addKnowledge(knowledgeOptions);

        response = {
          text: `I've successfully processed the document "${fileName}". It has been split into ${result?.fragmentCount || 0} searchable fragments and added to my knowledge base.`,
        };
      } else {
        // Process direct text content
        const knowledgeContent = text
          .replace(/^(add|store|remember|process|learn)\s+(this|that|the following)?:?\s*/i, '')
          .trim();

        if (!knowledgeContent) {
          response = {
            text: 'I need some content to add to my knowledge base. Please provide text or a file path.',
          };

          if (callback) {
            await callback(response);
          }
          return;
        }

        // Prepare knowledge options for text
        const knowledgeOptions: AddKnowledgeOptions = {
          clientDocumentId: stringToUuid(runtime.agentId + 'text' + Date.now() + 'user-knowledge'),
          contentType: 'text/plain',
          originalFilename: 'user-knowledge.txt',
          worldId: runtime.agentId,
          content: knowledgeContent,
          roomId: message.roomId,
          entityId: message.entityId,
        };

        // Process the text
        await service.addKnowledge(knowledgeOptions);

        response = {
          text: `I've added that information to my knowledge base. It has been stored and indexed for future reference.`,
        };
      }

      if (callback) {
        await callback(response);
      }
    } catch (error) {
      logger.error({ error }, 'Error in PROCESS_KNOWLEDGE action');

      const errorResponse: Content = {
        text: `I encountered an error while processing the knowledge: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };

      if (callback) {
        await callback(errorResponse);
      }
    }
  },
};

/**
 * Action to search the knowledge base
 */
export const searchKnowledgeAction: Action = {
  name: 'SEARCH_KNOWLEDGE',
  description: 'Search the knowledge base for specific information',

  similes: [
    'search knowledge',
    'find information',
    'look up',
    'query knowledge base',
    'search documents',
    'find in knowledge',
  ],

  examples: [
    [
      {
        name: 'user',
        content: {
          text: 'Search your knowledge for information about quantum computing',
        },
      },
      {
        name: 'assistant',
        content: {
          text: "I'll search my knowledge base for information about quantum computing.",
          actions: ['SEARCH_KNOWLEDGE'],
        },
      },
    ],
  ],

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
    const text = message.content.text?.toLowerCase() || '';

    // Check if the message contains search-related keywords
    const searchKeywords = ['search', 'find', 'look up', 'query', 'what do you know about'];
    const knowledgeKeywords = ['knowledge', 'information', 'document', 'database'];

    const hasSearchKeyword = searchKeywords.some((keyword) => text.includes(keyword));
    const hasKnowledgeKeyword = knowledgeKeywords.some((keyword) => text.includes(keyword));

    // Check if service is available
    const service = runtime.getService(KnowledgeService.serviceType);
    if (!service) {
      return false;
    }

    return hasSearchKeyword && hasKnowledgeKeyword;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ) => {
    try {
      const service = runtime.getService<KnowledgeService>(KnowledgeService.serviceType);
      if (!service) {
        throw new Error('Knowledge service not available');
      }

      const text = message.content.text || '';

      // Extract search query
      const query = text
        .replace(/^(search|find|look up|query)\s+(your\s+)?knowledge\s+(base\s+)?(for\s+)?/i, '')
        .trim();

      if (!query) {
        const response: Content = {
          text: 'What would you like me to search for in my knowledge base?',
        };

        if (callback) {
          await callback(response);
        }
        return;
      }

      // Create search message
      const searchMessage: Memory = {
        ...message,
        content: {
          text: query,
        },
      };

      // Search knowledge
      const results = await service.getKnowledge(searchMessage);

      let response: Content;

      if (results.length === 0) {
        response = {
          text: `I couldn't find any information about "${query}" in my knowledge base.`,
        };
      } else {
        // Format results
        const formattedResults = results
          .slice(0, 3) // Top 3 results
          .map((item, index) => `${index + 1}. ${item.content.text}`)
          .join('\n\n');

        response = {
          text: `Here's what I found about "${query}":\n\n${formattedResults}`,
        };
      }

      if (callback) {
        await callback(response);
      }
    } catch (error) {
      logger.error({ error }, 'Error in SEARCH_KNOWLEDGE action');

      const errorResponse: Content = {
        text: `I encountered an error while searching the knowledge base: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };

      if (callback) {
        await callback(errorResponse);
      }
    }
  },
};

// Export all actions
export const knowledgeActions = [processKnowledgeAction, searchKnowledgeAction];
