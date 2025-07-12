import type { IAgentRuntime, TextGenerationParams, TextEmbeddingParams } from '@elizaos/core';
import { logger } from '@elizaos/core';

/**
 * Realistic Test Model Provider - Provides configurable but realistic AI model responses
 * Replaces hardcoded mock responses with intelligent, context-aware responses
 */
export class TestModelProvider {
  private responses: Map<string, string> = new Map();
  private patterns: Array<{ pattern: RegExp; response: string }> = [];
  private defaultResponse: string;
  private contextHistory: Array<{ prompt: string; response: string }> = [];

  constructor(
    defaultResponse: string = 'I understand and will help with that.',
    _options: {
      enableContextMemory?: boolean;
      maxContextHistory?: number;
    } = {}
  ) {
    this.defaultResponse = defaultResponse;

    // Add some intelligent default patterns
    this.addDefaultPatterns();
  }

  /**
   * Add realistic default response patterns
   */
  private addDefaultPatterns(): void {
    const defaultPatterns = [
      // Greeting patterns
      {
        pattern: /^(hello|hi|hey|greetings)/i,
        response: 'Hello! How can I help you today?',
      },
      {
        pattern: /(good morning|good afternoon|good evening)/i,
        response: 'Good day! What can I assist you with?',
      },

      // Task creation patterns
      {
        pattern: /(create|add|make).*?(todo|task|reminder)/i,
        response: "I'll create that task for you right away. Let me add it to your todo list.",
      },
      {
        pattern: /(schedule|plan|organize)/i,
        response: "I'll help you schedule that. Let me organize this for you.",
      },

      // Information requests
      {
        pattern: /(search|find|look|query).*?(for|about)/i,
        response: "Let me search for that information. I'll look into it right away.",
      },
      {
        pattern: /(what|how|when|where|why)/i,
        response: "Let me find that information for you. I'll provide a detailed answer.",
      },

      // Analysis and review
      {
        pattern: /(analyze|review|examine|check)/i,
        response: "I'll analyze this carefully and provide my assessment with detailed insights.",
      },
      {
        pattern: /(explain|describe|tell me about)/i,
        response: "I'll explain that in detail for you. Here's what you need to know.",
      },

      // Action requests
      {
        pattern: /(send|email|message|notify)/i,
        response: "I'll send that message for you. Let me take care of the communication.",
      },
      {
        pattern: /(delete|remove|cancel)/i,
        response: "I'll remove that for you. Let me handle the deletion safely.",
      },

      // File and data operations
      {
        pattern: /(save|store|backup)/i,
        response: "I'll save that information securely. Your data will be stored properly.",
      },
      {
        pattern: /(load|open|access)/i,
        response: "I'll access that resource for you. Let me retrieve the information.",
      },

      // Problem solving
      {
        pattern: /(fix|repair|solve|troubleshoot)/i,
        response:
          "I'll help troubleshoot this issue. Let me analyze the problem and find a solution.",
      },
      {
        pattern: /(help|assist|support)/i,
        response: "I'm here to help! Let me assist you with whatever you need.",
      },

      // Decision making
      {
        pattern: /(should|recommend|suggest|advise)/i,
        response: "Based on the information provided, I'd recommend the following approach.",
      },
      {
        pattern: /(choose|select|decide)/i,
        response: 'Let me help you make that decision. Here are the key factors to consider.',
      },

      // Confirmation and acknowledgment
      {
        pattern: /(yes|ok|okay|sure|agreed)/i,
        response: "Understood! I'll proceed with that as requested.",
      },
      {
        pattern: /(no|stop|cancel|abort)/i,
        response: "Alright, I'll stop that process. Is there anything else I can help with?",
      },

      // Complex reasoning patterns
      {
        pattern: /(if.*then|because|therefore|since)/i,
        response: 'I understand the logic. Let me work through this step by step.',
      },
      {
        pattern: /(compare|contrast|difference|similar)/i,
        response: "I'll compare these options and highlight the key differences and similarities.",
      },

      // Error handling
      {
        pattern: /(error|problem|issue|broken|failed)/i,
        response: "I see there's an issue. Let me investigate the problem and find a solution.",
      },
    ];

    this.patterns.push(...defaultPatterns);
  }

  /**
   * Generate text response based on prompt
   */
  async generateText(params: TextGenerationParams): Promise<string> {
    const prompt = params.prompt;

    try {
      // Check for exact matches first
      const exactMatch = this.responses.get(prompt);
      if (exactMatch) {
        this.addToHistory(prompt, exactMatch);
        return exactMatch;
      }

      // Check pattern matches
      for (const { pattern, response } of this.patterns) {
        if (pattern.test(prompt)) {
          const contextualResponse = this.makeContextual(response, prompt);
          this.addToHistory(prompt, contextualResponse);
          return contextualResponse;
        }
      }

      // Generate intelligent default response
      const intelligentResponse = this.generateIntelligentDefault(prompt);
      this.addToHistory(prompt, intelligentResponse);
      return intelligentResponse;
    } catch (error) {
      logger.warn(
        `Error in test model provider: ${error instanceof Error ? error.message : String(error)}`
      );
      return this.defaultResponse;
    }
  }

  /**
   * Generate embeddings for text (mock implementation with consistent vectors)
   */
  async generateEmbedding(params: TextEmbeddingParams): Promise<number[]> {
    const text = params.text;

    // Create deterministic but realistic embeddings based on text content
    const hash = this.simpleHash(text);
    const embedding = [];

    // Generate 1536-dimensional embedding (OpenAI standard)
    for (let i = 0; i < 1536; i++) {
      const value = Math.sin(hash + i) * 0.5; // Values between -0.5 and 0.5
      embedding.push(value);
    }

    return embedding;
  }

  /**
   * Generate object-structured responses
   */
  async generateObject(params: any): Promise<Record<string, any>> {
    const prompt = params.prompt;

    // Parse the prompt to determine what kind of object to return
    if (prompt.includes('thought') || prompt.includes('reasoning')) {
      return {
        thought: 'I need to think about this carefully and provide a helpful response.',
        reasoning: "Based on the context provided, here's my analysis.",
        confidence: 0.85,
      };
    }

    if (prompt.includes('action') || prompt.includes('execute')) {
      return {
        action: 'RESPOND',
        parameters: {},
        confidence: 0.9,
      };
    }

    if (prompt.includes('memory') || prompt.includes('remember')) {
      return {
        shouldStore: true,
        importance: 0.7,
        category: 'conversation',
      };
    }

    // Default structured response
    return {
      response: await this.generateText({ prompt, ...params }),
      confidence: 0.8,
      metadata: {
        timestamp: Date.now(),
        model: 'test-model',
      },
    };
  }

  /**
   * Make response more contextual based on prompt content
   */
  private makeContextual(response: string, prompt: string): string {
    // Extract key terms from prompt to make response more specific
    const keyTerms = this.extractKeyTerms(prompt);

    if (keyTerms.length > 0) {
      // Add specific reference to what was requested
      const term = keyTerms[0];
      return response.replace(
        /that|this|it/g,
        term.length > 20 ? `that ${term.substring(0, 20)}...` : `that ${term}`
      );
    }

    return response;
  }

  /**
   * Generate intelligent default response based on prompt analysis
   */
  private generateIntelligentDefault(prompt: string): string {
    const lowerPrompt = prompt.toLowerCase();

    // Detect question type
    if (lowerPrompt.includes('?')) {
      return "That's a great question. Let me provide you with a comprehensive answer based on the available information.";
    }

    // Detect command/request
    if (lowerPrompt.match(/^(please|can you|could you|would you)/)) {
      return "Of course! I'll take care of that for you right away.";
    }

    // Detect complex reasoning
    if (lowerPrompt.length > 200) {
      return 'I understand this is a complex request. Let me work through this systematically and provide you with a detailed response.';
    }

    // Detect emotional content
    if (lowerPrompt.match(/(angry|sad|frustrated|excited|happy|worried)/)) {
      return "I understand how you're feeling. Let me help you work through this thoughtfully.";
    }

    return this.defaultResponse;
  }

  /**
   * Extract key terms from prompt for contextualization
   */
  private extractKeyTerms(prompt: string): string[] {
    // Simple keyword extraction - remove common words and extract meaningful terms
    const commonWords = new Set([
      'the',
      'a',
      'an',
      'and',
      'or',
      'but',
      'in',
      'on',
      'at',
      'to',
      'for',
      'of',
      'with',
      'by',
      'i',
      'you',
      'he',
      'she',
      'it',
      'we',
      'they',
      'this',
      'that',
      'these',
      'those',
      'is',
      'are',
      'was',
      'were',
      'be',
      'been',
      'being',
      'have',
      'has',
      'had',
      'do',
      'does',
      'did',
      'will',
      'would',
      'could',
      'should',
      'can',
      'may',
      'might',
      'must',
    ]);

    const words = prompt
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 2 && !commonWords.has(word));

    return [...new Set(words)].slice(0, 3); // Return unique terms, max 3
  }

  /**
   * Simple hash function for deterministic embeddings
   */
  private simpleHash(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash);
  }

  /**
   * Add interaction to context history
   */
  private addToHistory(prompt: string, response: string): void {
    this.contextHistory.push({ prompt, response });

    // Keep only recent history
    if (this.contextHistory.length > 10) {
      this.contextHistory.shift();
    }
  }

  /**
   * Set a specific response for a prompt
   */
  setResponse(prompt: string, response: string): void {
    this.responses.set(prompt, response);
  }

  /**
   * Add a pattern-based response
   */
  addPattern(pattern: RegExp, response: string): void {
    this.patterns.unshift({ pattern, response }); // Add to beginning for priority
  }

  /**
   * Set the default response
   */
  setDefaultResponse(response: string): void {
    this.defaultResponse = response;
  }

  /**
   * Clear all custom responses and patterns
   */
  clear(): void {
    this.responses.clear();
    this.patterns.length = 0;
    this.contextHistory.length = 0;
    this.addDefaultPatterns(); // Re-add defaults
  }

  /**
   * Get conversation history
   */
  getHistory(): Array<{ prompt: string; response: string }> {
    return [...this.contextHistory];
  }
}

/**
 * Create a test model provider with specific scenarios
 */
export function createTestModelProvider(
  scenarios: Array<{ prompt: RegExp | string; response: string }> = [],
  defaultResponse?: string
): TestModelProvider {
  const provider = new TestModelProvider(defaultResponse);

  for (const scenario of scenarios) {
    if (scenario.prompt instanceof RegExp) {
      provider.addPattern(scenario.prompt, scenario.response);
    } else {
      provider.setResponse(scenario.prompt, scenario.response);
    }
  }

  return provider;
}

/**
 * Create specialized model provider for different types of testing
 */
export function createSpecializedModelProvider(
  type: 'conversational' | 'analytical' | 'creative' | 'factual'
): TestModelProvider {
  const provider = new TestModelProvider();

  switch (type) {
    case 'conversational':
      provider.addPattern(
        /.*/,
        "That's interesting! Let me respond thoughtfully to what you've shared."
      );
      break;

    case 'analytical':
      provider.addPattern(
        /.*/,
        "Let me analyze this systematically. Based on the data and context provided, here's my assessment."
      );
      break;

    case 'creative':
      provider.addPattern(
        /.*/,
        'What a creative challenge! Let me think outside the box and explore innovative possibilities.'
      );
      break;

    case 'factual':
      provider.addPattern(
        /.*/,
        "Based on factual information and established knowledge, here's an accurate response."
      );
      break;
  }

  return provider;
}

/**
 * Model handler wrapper that integrates with ElizaOS runtime
 */
export function createModelHandler(provider: TestModelProvider) {
  return async (runtime: IAgentRuntime, params: any): Promise<any> => {
    const modelType = params.modelType || 'TEXT_LARGE';

    switch (modelType) {
      case 'TEXT_SMALL':
      case 'TEXT_LARGE':
        return await provider.generateText(params);

      case 'TEXT_EMBEDDING':
        return await provider.generateEmbedding(params);

      case 'OBJECT_SMALL':
      case 'OBJECT_LARGE':
        return await provider.generateObject(params);

      default:
        return await provider.generateText(params);
    }
  };
}

/**
 * Test scenario builder for common testing patterns
 */
export class TestScenarioBuilder {
  private scenarios: Array<{ prompt: RegExp | string; response: string }> = [];

  addGreeting(response: string = 'Hello! How can I help you?'): this {
    this.scenarios.push({
      prompt: /^(hello|hi|hey)/i,
      response,
    });
    return this;
  }

  addTaskCreation(response: string = "I'll create that task for you."): this {
    this.scenarios.push({
      prompt: /(create|add|make).*?(todo|task)/i,
      response,
    });
    return this;
  }

  addSearch(response: string = 'Let me search for that information.'): this {
    this.scenarios.push({
      prompt: /(search|find|look)/i,
      response,
    });
    return this;
  }

  addCustom(prompt: RegExp | string, response: string): this {
    this.scenarios.push({ prompt, response });
    return this;
  }

  build(defaultResponse?: string): TestModelProvider {
    return createTestModelProvider(this.scenarios, defaultResponse);
  }
}

/**
 * Convenience function to quickly create test scenarios
 */
export function scenarios(): TestScenarioBuilder {
  return new TestScenarioBuilder();
}
