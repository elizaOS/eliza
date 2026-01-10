import {
  type IAgentRuntime,
  type Memory,
  type Action,
  type ActionResult,
  logger,
  ModelType,
  composePromptFromState,
} from '@elizaos/core';
import { MemoryService } from '../services/memory-service';
import { LongTermMemoryCategory, type MemoryExtraction } from '../types/index';

/**
 * Template for parsing what to remember
 */
const rememberTemplate = `# Task: Extract Information to Remember

The user has asked you to remember something. Extract what should be stored as a long-term memory.

# User's Request
{{userMessage}}

# Current Conversation Context
{{recentMessages}}

# Memory Categories
1. **identity**: User's name, role, identity
2. **expertise**: User's skills, knowledge domains
3. **projects**: Ongoing projects, recurring topics
4. **preferences**: Communication style, format preferences
5. **data_sources**: Frequently used files, databases, APIs
6. **goals**: Broader intentions and objectives
7. **constraints**: User-defined rules or limitations
8. **definitions**: Custom terms, acronyms, glossaries
9. **behavioral_patterns**: How the user tends to interact

# Instructions
Determine:
1. What exactly should be remembered
2. Which category it belongs to
3. How confident you are (0.0 to 1.0)

Respond in this XML format:
<memory>
  <category>appropriate_category</category>
  <content>Clear, factual statement of what to remember</content>
  <confidence>0.95</confidence>
  <reasoning>Brief explanation of why this is important to remember</reasoning>
</memory>`;

/**
 * Parse memory extraction from XML
 */
function parseRememberXML(xml: string): MemoryExtraction & { reasoning?: string } {
  const categoryMatch = xml.match(/<category>(.*?)<\/category>/);
  const contentMatch = xml.match(/<content>(.*?)<\/content>/);
  const confidenceMatch = xml.match(/<confidence>(.*?)<\/confidence>/);
  const reasoningMatch = xml.match(/<reasoning>(.*?)<\/reasoning>/);

  const category = categoryMatch?.[1].trim() as LongTermMemoryCategory;
  const content = contentMatch?.[1].trim() || '';
  const confidence = confidenceMatch ? parseFloat(confidenceMatch[1].trim()) : 0.9;
  const reasoning = reasoningMatch?.[1].trim();

  return { category, content, confidence, reasoning };
}

/**
 * Remember Action
 *
 * Allows users to explicitly ask the agent to remember information.
 * Examples:
 * - "Remember that I prefer Python over JavaScript"
 * - "Please remember I'm working on a startup project"
 * - "Keep in mind that I don't like verbose explanations"
 */
export const rememberAction: Action = {
  name: 'REMEMBER',
  description:
    'Store information in long-term memory when user explicitly asks to remember something',
  similes: [
    'STORE_MEMORY',
    'SAVE_PREFERENCE',
    'KEEP_IN_MIND',
    'MEMORIZE',
    'NOTE_THAT',
    'REMEMBER_THIS',
  ],

  validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    // Check if message contains explicit memory request
    const text = message.content.text?.toLowerCase() || '';

    const memoryKeywords = [
      'remember',
      'keep in mind',
      'note that',
      'save this',
      'memorize',
      "don't forget",
      'always remember',
      'store this',
      'make a note',
    ];

    return memoryKeywords.some((keyword) => text.includes(keyword));
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: Record<string, unknown>
  ): Promise<ActionResult> => {
    const memoryService = runtime.getService('memory') as MemoryService | null;
    if (!memoryService) {
      logger.error('MemoryService not found');
      return {
        success: false,
        data: {
          error: 'Memory service not available',
        },
      };
    }

    try {
      const { entityId, roomId } = message;

      // Get recent context
      const recentMessages = await runtime.getMemories({
        tableName: 'messages',
        roomId,
        count: 10,
        unique: false,
      });

      const formattedMessages = recentMessages
        .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
        .slice(-5) // Last 5 messages for context
        .map((msg) => {
          const sender = msg.entityId === runtime.agentId ? runtime.character.name : 'User';
          return `${sender}: ${msg.content.text || '[non-text message]'}`;
        })
        .join('\n');

      // Extract what to remember using LLM
      const state = await runtime.composeState(message);
      const prompt = composePromptFromState({
        state: {
          ...state,
          userMessage: message.content.text,
          recentMessages: formattedMessages,
        },
        template: rememberTemplate,
      });

      const response = await runtime.useModel(ModelType.TEXT_LARGE, {
        prompt,
      });

      const extraction = parseRememberXML(response);

      // Validate category
      if (!Object.values(LongTermMemoryCategory).includes(extraction.category)) {
        logger.warn(`Invalid memory category extracted: ${extraction.category}`);
        return {
          success: false,
          data: {
            error: 'Could not determine appropriate memory category',
          },
        };
      }

      if (!extraction.content) {
        return {
          success: false,
          data: {
            error: 'Could not extract clear information to remember',
          },
        };
      }

      // Store the memory
      const storedMemory = await memoryService.storeLongTermMemory({
        agentId: runtime.agentId,
        entityId,
        category: extraction.category,
        content: extraction.content,
        confidence: extraction.confidence,
        source: 'manual',
        metadata: {
          roomId,
          requestedAt: new Date().toISOString(),
          reasoning: extraction.reasoning,
        },
      });

      logger.info(`Stored manual memory: [${extraction.category}] ${extraction.content}`);

      // Generate confirmation message
      const categoryName = extraction.category
        .split('_')
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');

      const confirmationText = `I've made a note of that in my ${categoryName} memory: "${extraction.content}"`;

      return {
        success: true,
        data: {
          memory: storedMemory,
          category: extraction.category,
          content: extraction.content,
          reasoning: extraction.reasoning,
        },
        text: confirmationText,
      };
    } catch (error) {
      logger.error({ error }, 'Error in rememberAction:');
      return {
        success: false,
        data: {
          error: 'Failed to store memory',
        },
      };
    }
  },

  examples: [
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Remember that I prefer TypeScript over JavaScript',
        },
      },
      {
        name: '{{agent}}',
        content: {
          text: 'I\'ve made a note of that in my Preferences memory: "User prefers TypeScript over JavaScript"',
          action: 'REMEMBER',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: "Please keep in mind I'm working on a machine learning project",
        },
      },
      {
        name: '{{agent}}',
        content: {
          text: 'I\'ve made a note of that in my Projects memory: "User is working on a machine learning project"',
          action: 'REMEMBER',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: "Don't forget I use Python 3.11",
        },
      },
      {
        name: '{{agent}}',
        content: {
          text: 'I\'ve made a note of that in my Data Sources memory: "User uses Python 3.11"',
          action: 'REMEMBER',
        },
      },
    ],
  ],
};
