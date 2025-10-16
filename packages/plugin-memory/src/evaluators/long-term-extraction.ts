import {
  type IAgentRuntime,
  type Memory,
  type Evaluator,
  type UUID,
  logger,
  ModelType,
  composePromptFromState,
} from '@elizaos/core';
import { MemoryService } from '../services/memory-service';
import { LongTermMemoryCategory, type MemoryExtraction } from '../types/index';

/**
 * Template for extracting long-term memories
 */
const extractionTemplate = `# Task: Extract Long-Term Memory

You are analyzing a conversation to extract facts that should be remembered long-term about the user.

# Recent Messages
{{recentMessages}}

# Current Long-Term Memories
{{existingMemories}}

# Memory Categories
1. **identity**: User's name, role, identity (e.g., "I'm a data scientist")
2. **expertise**: User's skills, knowledge domains, or unfamiliarity with topics
3. **projects**: Ongoing projects, past interactions, recurring topics
4. **preferences**: Communication style, format preferences, verbosity, etc.
5. **data_sources**: Frequently used files, databases, APIs
6. **goals**: Broader intentions (e.g., "preparing for interview")
7. **constraints**: User-defined rules or limitations
8. **definitions**: Custom terms, acronyms, glossaries
9. **behavioral_patterns**: How the user tends to interact

# Instructions
Extract any NEW information that should be remembered long-term. For each item:
- Determine which category it belongs to
- Write a clear, factual statement
- Assess confidence (0.0 to 1.0)
- Only include information explicitly stated or strongly implied

If there are no new long-term facts to extract, respond with <memories></memories>

Respond in this XML format:
<memories>
  <memory>
    <category>identity</category>
    <content>User is a software engineer specializing in backend development</content>
    <confidence>0.95</confidence>
  </memory>
  <memory>
    <category>preferences</category>
    <content>Prefers code examples over lengthy explanations</content>
    <confidence>0.85</confidence>
  </memory>
</memories>`;

/**
 * Parse XML memory extraction response
 */
function parseMemoryExtractionXML(xml: string): MemoryExtraction[] {
  const memoryMatches = xml.matchAll(
    /<memory>[\s\S]*?<category>(.*?)<\/category>[\s\S]*?<content>(.*?)<\/content>[\s\S]*?<confidence>(.*?)<\/confidence>[\s\S]*?<\/memory>/g
  );

  const extractions: MemoryExtraction[] = [];

  for (const match of memoryMatches) {
    const category = match[1].trim() as LongTermMemoryCategory;
    const content = match[2].trim();
    const confidence = parseFloat(match[3].trim());

    // Validate category
    if (!Object.values(LongTermMemoryCategory).includes(category)) {
      logger.warn(`Invalid memory category: ${category}`);
      continue;
    }

    if (content && !isNaN(confidence)) {
      extractions.push({ category, content, confidence });
    }
  }

  return extractions;
}

/**
 * Long-term Memory Extraction Evaluator
 *
 * Analyzes conversations to extract persistent facts about users that should be remembered
 * across all future conversations.
 */
export const longTermExtractionEvaluator: Evaluator = {
  name: 'LONG_TERM_MEMORY_EXTRACTION',
  description: 'Extracts long-term facts about users from conversations',
  similes: ['MEMORY_EXTRACTION', 'FACT_LEARNING', 'USER_PROFILING'],

  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    // Only run on user messages (not agent's own)
    if (message.entityId === runtime.agentId) {
      return false;
    }

    if (!message.content?.text) {
      return false;
    }

    const memoryService = runtime.getService('memory') as MemoryService | null;
    if (!memoryService) {
      return false;
    }

    const config = memoryService.getConfig();
    if (!config.longTermExtractionEnabled) {
      return false;
    }

    // Run extraction periodically (every 10 messages from this user)
    // This is a simple heuristic - could be made more sophisticated
    const messages = await runtime.getMemories({
      tableName: 'messages',
      roomId: message.roomId,
      count: 10,
      unique: false,
    });

    // Simple check: run every 10 messages by checking if we have exactly 10
    return messages.length >= 10;
  },

  handler: async (runtime: IAgentRuntime, message: Memory): Promise<void> => {
    const memoryService = runtime.getService('memory') as MemoryService;
    if (!memoryService) {
      logger.error('MemoryService not found');
      return;
    }

    const config = memoryService.getConfig();
    const { entityId, roomId } = message;

    try {
      logger.info(`Extracting long-term memories for entity ${entityId}`);

      // Get recent conversation context
      const recentMessages = await runtime.getMemories({
        tableName: 'messages',
        roomId,
        count: 20,
        unique: false,
      });

      const formattedMessages = recentMessages
        .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
        .map((msg) => {
          const sender = msg.entityId === runtime.agentId ? runtime.character.name : 'User';
          return `${sender}: ${msg.content.text || '[non-text message]'}`;
        })
        .join('\n');

      // Get existing long-term memories
      const existingMemories = await memoryService.getLongTermMemories(entityId, undefined, 30);
      const formattedExisting =
        existingMemories.length > 0
          ? existingMemories
              .map((m) => `[${m.category}] ${m.content} (confidence: ${m.confidence})`)
              .join('\n')
          : 'None yet';

      // Generate extraction using LLM
      const state = await runtime.composeState(message);
      const prompt = composePromptFromState({
        state: {
          ...state,
          recentMessages: formattedMessages,
          existingMemories: formattedExisting,
        },
        template: extractionTemplate,
      });

      const response = await runtime.useModel(ModelType.TEXT_LARGE, {
        prompt,
      });

      const extractions = parseMemoryExtractionXML(response);

      logger.info(`Extracted ${extractions.length} long-term memories`);

      // Store each extracted memory
      for (const extraction of extractions) {
        if (extraction.confidence >= config.longTermConfidenceThreshold) {
          await memoryService.storeLongTermMemory({
            agentId: runtime.agentId,
            entityId,
            category: extraction.category,
            content: extraction.content,
            confidence: extraction.confidence,
            source: 'conversation',
            metadata: {
              roomId,
              extractedAt: new Date().toISOString(),
            },
          });

          logger.info(
            `Stored long-term memory: [${extraction.category}] ${extraction.content.substring(0, 50)}...`
          );
        } else {
          logger.debug(
            `Skipped low-confidence memory: ${extraction.content} (confidence: ${extraction.confidence})`
          );
        }
      }
    } catch (error) {
      logger.error({ error }, 'Error during long-term memory extraction:');
    }
  },

  examples: [],
};
