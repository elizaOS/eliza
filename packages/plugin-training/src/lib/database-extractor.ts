import { type IAgentRuntime, type Memory, elizaLogger } from '@elizaos/core';
// Removed broken import - simple-types
// import { type TrainingExample } from '../simple-types.js';

// Define the type inline for now
interface TrainingExample {
  id: string;
  input: string;
  output: string;
  request: string;
  response: string;
  thinking?: string;
  quality: number;
  createdAt: Date;
  metadata?: Record<string, any>;
}

/**
 * Extract training data from ElizaOS database
 */
export class DatabaseExtractor {
  constructor(private runtime: IAgentRuntime) {}

  /**
   * Extract successful plugin creation conversations
   */
  async extractPluginCreations(): Promise<TrainingExample[]> {
    const examples: TrainingExample[] = [];

    try {
      // Search for plugin-related conversations
      const pluginMemories =
        (await (this.runtime as any).searchMemories?.({
          text: 'plugin OR create OR implement OR build',
          match_threshold: 0.7,
          count: 100,
        })) || [];

      // Group memories by conversation/room
      const conversationGroups = this.groupByConversation(pluginMemories);

      for (const [roomId, memories] of conversationGroups.entries()) {
        const conversation = this.sortMemoriesByTime(memories);
        const trainingPairs = this.extractRequestResponsePairs(conversation);

        for (const pair of trainingPairs) {
          if (this.isPluginCreationSuccess(pair)) {
            const example = await this.createTrainingExample(pair);
            if (example) {
              examples.push(example);
            }
          }
        }
      }

      elizaLogger.info(`✅ Extracted ${examples.length} plugin creation examples from database`);
      return examples;
    } catch (error) {
      elizaLogger.error('Error extracting plugin creations:', error);
      return [];
    }
  }

  /**
   * Extract general successful code completions
   */
  async extractCodeCompletions(): Promise<TrainingExample[]> {
    const examples: TrainingExample[] = [];

    try {
      // Search for code-related conversations
      const codeMemories =
        (await (this.runtime as any).searchMemories?.({
          text: 'code OR function OR class OR implement OR typescript OR javascript',
          match_threshold: 0.7,
          count: 100,
        })) || [];

      const conversationGroups = this.groupByConversation(codeMemories);

      for (const [roomId, memories] of conversationGroups.entries()) {
        const conversation = this.sortMemoriesByTime(memories);
        const trainingPairs = this.extractRequestResponsePairs(conversation);

        for (const pair of trainingPairs) {
          if (this.isCodeCompletionSuccess(pair)) {
            const example = await this.createTrainingExample(pair);
            if (example) {
              examples.push(example);
            }
          }
        }
      }

      elizaLogger.info(`✅ Extracted ${examples.length} code completion examples from database`);
      return examples;
    } catch (error) {
      elizaLogger.error('Error extracting code completions:', error);
      return [];
    }
  }

  /**
   * Extract all high-quality conversations
   */
  async extractAllSuccessfulInteractions(): Promise<TrainingExample[]> {
    const examples: TrainingExample[] = [];

    try {
      // Get recent high-quality memories
      const recentMemories =
        (await (this.runtime as any).getMemories?.({
          count: 500,
          unique: true,
        })) || [];

      const conversationGroups = this.groupByConversation(recentMemories);

      for (const [roomId, memories] of conversationGroups.entries()) {
        const conversation = this.sortMemoriesByTime(memories);
        const trainingPairs = this.extractRequestResponsePairs(conversation);

        for (const pair of trainingPairs) {
          const quality = this.assessInteractionQuality(pair);
          if (quality >= 0.7) {
            const example = await this.createTrainingExample(pair, quality);
            if (example) {
              examples.push(example);
            }
          }
        }
      }

      elizaLogger.info(`✅ Extracted ${examples.length} high-quality interactions from database`);
      return examples;
    } catch (error) {
      elizaLogger.error('Error extracting successful interactions:', error);
      return [];
    }
  }

  /**
   * Group memories by conversation/room
   */
  private groupByConversation(memories: Memory[]): Map<string, Memory[]> {
    const groups = new Map<string, Memory[]>();

    for (const memory of memories) {
      const roomId = memory.roomId || 'default';
      if (!groups.has(roomId)) {
        groups.set(roomId, []);
      }
      groups.get(roomId)!.push(memory);
    }

    return groups;
  }

  /**
   * Sort memories chronologically
   */
  private sortMemoriesByTime(memories: Memory[]): Memory[] {
    return memories.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  }

  /**
   * Extract request-response pairs from conversation
   */
  private extractRequestResponsePairs(conversation: Memory[]): Array<{
    request: Memory;
    response: Memory;
  }> {
    const pairs: Array<{ request: Memory; response: Memory }> = [];

    for (let i = 0; i < conversation.length - 1; i++) {
      const current = conversation[i];
      const next = conversation[i + 1];

      // User message followed by agent response
      if (current.entityId !== this.runtime.agentId && next.entityId === this.runtime.agentId) {
        pairs.push({
          request: current,
          response: next,
        });
      }
    }

    return pairs;
  }

  /**
   * Check if this is a successful plugin creation
   */
  private isPluginCreationSuccess(pair: { request: Memory; response: Memory }): boolean {
    const requestText = pair.request.content.text?.toLowerCase() || '';
    const responseText = pair.response.content.text?.toLowerCase() || '';

    // Look for plugin creation keywords
    const pluginKeywords = ['plugin', 'create plugin', 'build plugin', 'implement plugin'];
    const hasPluginRequest = pluginKeywords.some((keyword) => requestText.includes(keyword));

    // Look for successful completion indicators
    const successIndicators = [
      'implementation',
      'complete',
      'working',
      'export',
      'index.ts',
      'plugin.ts',
      'actions',
      'providers',
    ];
    const hasSuccessResponse = successIndicators.some((indicator) =>
      responseText.includes(indicator)
    );

    return hasPluginRequest && hasSuccessResponse && responseText.length > 200;
  }

  /**
   * Check if this is a successful code completion
   */
  private isCodeCompletionSuccess(pair: { request: Memory; response: Memory }): boolean {
    const requestText = pair.request.content.text?.toLowerCase() || '';
    const responseText = pair.response.content.text?.toLowerCase() || '';

    // Look for code request keywords
    const codeKeywords = [
      'function',
      'class',
      'implement',
      'write code',
      'typescript',
      'javascript',
    ];
    const hasCodeRequest = codeKeywords.some((keyword) => requestText.includes(keyword));

    // Look for code blocks or implementation
    const hasCodeBlocks =
      responseText.includes('```') ||
      responseText.includes('export') ||
      responseText.includes('function');

    return hasCodeRequest && hasCodeBlocks && responseText.length > 100;
  }

  /**
   * Assess the quality of an interaction
   */
  private assessInteractionQuality(pair: { request: Memory; response: Memory }): number {
    const requestText = pair.request.content.text || '';
    const responseText = pair.response.content.text || '';

    let quality = 0.5; // Base quality

    // Length quality (longer responses often better)
    if (responseText.length > 500) {
      quality += 0.2;
    }
    if (responseText.length > 1000) {
      quality += 0.1;
    }

    // Code quality indicators
    if (responseText.includes('```')) {
      quality += 0.1;
    }
    if (responseText.includes('export')) {
      quality += 0.1;
    }
    if (responseText.includes('interface') || responseText.includes('type')) {
      quality += 0.1;
    }

    // Helpful response indicators
    if (responseText.includes("I'll") || responseText.includes('Let me')) {
      quality += 0.1;
    }
    if (responseText.includes('implementation') || responseText.includes('example')) {
      quality += 0.1;
    }

    // Penalty for short or unclear responses
    if (responseText.length < 50) {
      quality -= 0.3;
    }
    if (responseText.includes("I don't know") || responseText.includes("I can't")) {
      quality -= 0.2;
    }

    return Math.max(0, Math.min(1, quality));
  }

  /**
   * Create training example with thinking block
   */
  private async createTrainingExample(
    pair: { request: Memory; response: Memory },
    quality?: number
  ): Promise<TrainingExample | null> {
    try {
      const requestText = pair.request.content.text || '';
      const responseText = pair.response.content.text || '';

      if (!requestText || !responseText) {
        return null;
      }

      // Generate thinking block based on the successful response
      const thinking = this.generateThinkingBlock(requestText, responseText);

      const example: TrainingExample = {
        id: `extracted-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        input: requestText,
        output: responseText,
        request: requestText,
        response: responseText,
        thinking,
        quality: quality || this.assessInteractionQuality(pair),
        createdAt: new Date(pair.response.createdAt || Date.now()),
      };

      return example;
    } catch (error) {
      elizaLogger.error('Error creating training example:', error);
      return null;
    }
  }

  /**
   * Generate thinking block for successful completion
   */
  private generateThinkingBlock(request: string, response: string): string {
    const thinking: string[] = [];

    // Analyze what the request is asking for
    if (request.toLowerCase().includes('plugin')) {
      thinking.push('The user wants me to create a plugin for ElizaOS.');
      thinking.push('I need to understand the requirements and create a complete implementation.');
      thinking.push(
        'This should include proper TypeScript types, actions, providers, and follow ElizaOS patterns.'
      );
    } else if (
      request.toLowerCase().includes('function') ||
      request.toLowerCase().includes('implement')
    ) {
      thinking.push('The user needs me to implement a function or feature.');
      thinking.push(
        'I should provide a complete, working implementation with proper error handling.'
      );
    } else {
      thinking.push(
        'I need to understand what the user is asking for and provide a helpful, detailed response.'
      );
    }

    // Add implementation strategy based on response content
    if (response.includes('```')) {
      thinking.push("I'll provide code examples to illustrate the implementation.");
    }
    if (response.includes('export') || response.includes('interface')) {
      thinking.push('I need to structure this with proper TypeScript types and exports.');
    }
    if (response.includes('action') || response.includes('provider')) {
      thinking.push('This involves ElizaOS components like actions and providers.');
    }

    return thinking.join(' ');
  }
}
