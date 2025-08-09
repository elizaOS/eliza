import { type IAgentRuntime, elizaLogger } from '@elizaos/core';
import { type JSONLDataset, type TrainingDataPoint, type TogetherAIConfig } from '../types.js';

/**
 * Processes and formats datasets for Together.ai fine-tuning
 */
export class JSONLDatasetProcessor {
  constructor(private runtime: IAgentRuntime) {}

  /**
   * Convert training data to Together.ai JSONL format
   */
  async convertToTogetherFormat(
    dataPoints: TrainingDataPoint[],
    options?: {
      includeThinking?: boolean;
      maxTokens?: number;
      systemPrompt?: string;
    }
  ): Promise<JSONLDataset> {
    elizaLogger.info(`Converting ${dataPoints.length} data points to Together.ai format`);

    const systemPrompt = options?.systemPrompt || this.getDefaultSystemPrompt();
    const jsonlEntries: any[] = [];
    const maxTokens = options?.maxTokens || 4096;

    for (const dataPoint of dataPoints) {
      try {
        const entry = await this.convertSingleDataPoint(dataPoint, systemPrompt, options);

        // Validate token count
        const tokenCount = this.estimateTokenCount(entry);
        if (tokenCount <= maxTokens) {
          jsonlEntries.push(entry);
        } else {
          elizaLogger.warn(
            `Skipping data point ${dataPoint.id}: exceeds token limit (${tokenCount} > ${maxTokens})`
          );
        }
      } catch (error) {
        elizaLogger.error(`Error converting data point ${dataPoint.id}:`, error);
      }
    }

    return {
      entries: jsonlEntries,
      totalEntries: jsonlEntries.length,
      format: 'together-ai',
      metadata: {
        totalSamples: jsonlEntries.length,
        trainSize: 0,
        validationSize: 0,
        testSize: 0,
        features: ['messages'],
        createdAt: new Date(),
        originalDataPoints: dataPoints.length,
        filteredOut: dataPoints.length - jsonlEntries.length,
        maxTokens,
        includeThinking: options?.includeThinking || false,
      },
    };
  }

  /**
   * Convert single data point to Together.ai format
   */
  private async convertSingleDataPoint(
    dataPoint: TrainingDataPoint,
    systemPrompt: string,
    options?: { includeThinking?: boolean }
  ): Promise<any> {
    const messages: any[] = [
      {
        role: 'system',
        content: systemPrompt,
      },
      {
        role: 'user',
        content: dataPoint.request || dataPoint.input?.prompt || '',
      },
    ];

    // Build assistant response
    let assistantContent = '';

    // Add thinking block if requested and available
    if (options?.includeThinking && (dataPoint.thinking || dataPoint.output?.reasoning)) {
      assistantContent += `${dataPoint.thinking || dataPoint.output?.reasoning || ''}\n\n`;
    }

    assistantContent +=
      dataPoint.response || dataPoint.output?.decision || dataPoint.output?.code || '';

    messages.push({
      role: 'assistant',
      content: assistantContent,
    });

    return {
      messages,
      metadata: {
        type: dataPoint.type || 'unknown',
        subtype: dataPoint.subtype || '',
        quality: dataPoint.quality || 0.5,
        created_at: (
          dataPoint.createdAt || new Date(dataPoint.timestamp || Date.now())
        ).toISOString(),
        data_point_id: dataPoint.id,
      },
    };
  }

  /**
   * Create specialized datasets for different model sizes
   */
  async createModelSpecificDatasets(
    dataPoints: TrainingDataPoint[],
    configs: {
      small: TogetherAIConfig;
      large: TogetherAIConfig;
    }
  ): Promise<{
    smallModelDataset: JSONLDataset;
    largeModelDataset: JSONLDataset;
  }> {
    elizaLogger.info('Creating model-specific datasets');

    // Small model dataset (simpler, less thinking)
    const smallModelDataset = await this.convertToTogetherFormat(dataPoints, {
      includeThinking: false, // Skip thinking for smaller model
      maxTokens: 2048, // Lower token limit
      systemPrompt: this.getSimpleSystemPrompt(),
    });

    // Large model dataset (complete with thinking)
    const largeModelDataset = await this.convertToTogetherFormat(dataPoints, {
      includeThinking: true, // Include full thinking process
      maxTokens: 8192, // Higher token limit
      systemPrompt: this.getAdvancedSystemPrompt(),
    });

    elizaLogger.info(
      `Created datasets - Small: ${smallModelDataset.totalEntries || smallModelDataset.entries?.length || 0}, Large: ${largeModelDataset.totalEntries || largeModelDataset.entries?.length || 0}`
    );

    return {
      smallModelDataset,
      largeModelDataset,
    };
  }

  /**
   * Filter dataset by quality and complexity
   */
  filterDataset(
    dataPoints: TrainingDataPoint[],
    criteria: {
      minQuality?: number;
      maxComplexity?: string;
      includeTypes?: string[];
      excludeTypes?: string[];
    }
  ): TrainingDataPoint[] {
    let filtered = [...dataPoints];

    // Filter by quality
    if (criteria.minQuality !== undefined) {
      filtered = filtered.filter((dp) => (dp.quality || 0) >= criteria.minQuality!);
    }

    // Filter by complexity
    if (criteria.maxComplexity) {
      const complexityOrder = ['simple', 'medium', 'complex'];
      const maxIndex = complexityOrder.indexOf(criteria.maxComplexity);
      if (maxIndex !== -1) {
        filtered = filtered.filter((dp) => {
          const complexity = dp.metadata?.thinking_block?.metadata?.complexity || 'medium';
          return complexityOrder.indexOf(complexity) <= maxIndex;
        });
      }
    }

    // Include specific types
    if (criteria.includeTypes && criteria.includeTypes.length > 0) {
      filtered = filtered.filter(
        (dp) =>
          criteria.includeTypes!.includes(dp.type || '') ||
          criteria.includeTypes!.includes(dp.subtype || '')
      );
    }

    // Exclude specific types
    if (criteria.excludeTypes && criteria.excludeTypes.length > 0) {
      filtered = filtered.filter(
        (dp) =>
          !criteria.excludeTypes!.includes(dp.type || '') &&
          !criteria.excludeTypes!.includes(dp.subtype || '')
      );
    }

    elizaLogger.info(`Filtered dataset: ${dataPoints.length} -> ${filtered.length} data points`);
    return filtered;
  }

  /**
   * Validate JSONL format for Together.ai
   */
  async validateJSONLFormat(dataset: JSONLDataset): Promise<{
    isValid: boolean;
    errors: string[];
    warnings: string[];
  }> {
    const errors: string[] = [];
    const warnings: string[] = [];

    for (let i = 0; i < (dataset.entries?.length || 0); i++) {
      const entry = dataset.entries![i];

      // Check required structure
      if (!entry.messages || !Array.isArray(entry.messages)) {
        errors.push(`Entry ${i}: Missing or invalid 'messages' array`);
        continue;
      }

      // Validate message structure
      for (let j = 0; j < entry.messages.length; j++) {
        const message = entry.messages[j];

        if (!message.role || !message.content) {
          errors.push(`Entry ${i}, Message ${j}: Missing 'role' or 'content'`);
        }

        if (!['system', 'user', 'assistant'].includes(message.role)) {
          errors.push(`Entry ${i}, Message ${j}: Invalid role '${message.role}'`);
        }

        if (typeof message.content !== 'string') {
          errors.push(`Entry ${i}, Message ${j}: Content must be a string`);
        }
      }

      // Check conversation flow
      const roles = entry.messages.map((m: any) => m.role);
      if (roles[0] !== 'system') {
        warnings.push(`Entry ${i}: Conversation should start with system message`);
      }

      // Check for proper user/assistant alternation
      const userAssistantRoles = roles.filter((r: string) => r !== 'system');
      for (let k = 0; k < userAssistantRoles.length - 1; k += 2) {
        if (userAssistantRoles[k] !== 'user' || userAssistantRoles[k + 1] !== 'assistant') {
          warnings.push(`Entry ${i}: User and assistant messages should alternate`);
          break;
        }
      }

      // Token count warning
      const tokenCount = this.estimateTokenCount(entry);
      if (tokenCount > 4096) {
        warnings.push(`Entry ${i}: High token count (${tokenCount}), may be truncated`);
      }
    }

    const isValid = errors.length === 0;

    if (isValid) {
      elizaLogger.info(`JSONL validation passed with ${warnings.length} warnings`);
    } else {
      elizaLogger.error(`JSONL validation failed with ${errors.length} errors`);
    }

    return { isValid, errors, warnings };
  }

  /**
   * Save dataset to file
   */
  async saveDataset(dataset: JSONLDataset, filePath: string): Promise<void> {
    elizaLogger.info(`Saving dataset to ${filePath}`);

    const content = (dataset.entries || []).map((entry) => JSON.stringify(entry)).join('\n');

    const fs = await import('fs/promises');
    await fs.writeFile(filePath, content, 'utf-8');

    elizaLogger.info(`Saved ${dataset.totalEntries} entries to ${filePath}`);
  }

  /**
   * Load dataset from file
   */
  async loadDataset(filePath: string): Promise<JSONLDataset> {
    elizaLogger.info(`Loading dataset from ${filePath}`);

    const fs = await import('fs/promises');
    const content = await fs.readFile(filePath, 'utf-8');

    const entries = content
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));

    const dataset: JSONLDataset = {
      entries,
      totalEntries: entries.length,
      format: 'together-ai',
      metadata: {
        totalSamples: entries.length,
        trainSize: 0,
        validationSize: 0,
        testSize: 0,
        features: ['messages'],
        createdAt: new Date(),
        source: filePath,
        loadedAt: new Date(),
      },
    };

    elizaLogger.info(`Loaded ${dataset.totalEntries} entries from ${filePath}`);
    return dataset;
  }

  /**
   * Augment dataset with variations
   */
  async augmentDataset(
    dataset: JSONLDataset,
    augmentationConfig: {
      paraphrase?: boolean;
      addNoise?: boolean;
      varyComplexity?: boolean;
      maxAugmentations?: number;
    }
  ): Promise<JSONLDataset> {
    elizaLogger.info('Augmenting dataset with variations');

    const augmentedEntries = [...(dataset.entries || [])];
    const maxAugmentations = augmentationConfig.maxAugmentations || dataset.entries?.length || 0;
    let augmentationCount = 0;

    for (const entry of dataset.entries || []) {
      if (augmentationCount >= maxAugmentations) {
        break;
      }

      // Paraphrase user requests
      if (augmentationConfig.paraphrase) {
        const paraphrased = await this.paraphraseEntry(entry);
        if (paraphrased) {
          augmentedEntries.push(paraphrased);
          augmentationCount++;
        }
      }

      // Add complexity variations
      if (augmentationConfig.varyComplexity) {
        const simplified = await this.simplifyEntry(entry);
        if (simplified) {
          augmentedEntries.push(simplified);
          augmentationCount++;
        }
      }
    }

    return {
      ...dataset,
      entries: augmentedEntries,
      totalEntries: augmentedEntries.length,
      metadata: {
        ...dataset.metadata,
        augmented: true,
        originalSize: dataset.entries?.length || 0,
        augmentationCount,
      },
    };
  }

  private getDefaultSystemPrompt(): string {
    return `You are an expert ElizaOS developer who creates high-quality plugins and MCP servers. You approach problems systematically:

1. Analyze the requirements carefully
2. Plan the architecture and implementation
3. Write clean, maintainable TypeScript code
4. Follow ElizaOS conventions and patterns
5. Provide complete, working implementations

When creating plugins or MCP servers, you think through the problem step by step and provide comprehensive solutions that integrate seamlessly with the ElizaOS ecosystem.`;
  }

  private getSimpleSystemPrompt(): string {
    return 'You are an ElizaOS developer who creates plugins and MCP servers. Provide clean, working implementations that follow ElizaOS patterns.';
  }

  private getAdvancedSystemPrompt(): string {
    return `You are a senior ElizaOS architect with deep expertise in plugin development and MCP server creation. You think through complex problems systematically and provide comprehensive, production-ready solutions.

Your approach:
1. Thoroughly analyze requirements and constraints
2. Design robust, scalable architectures
3. Consider edge cases and error handling
4. Write self-documenting, maintainable code
5. Follow best practices and design patterns
6. Provide complete implementations with proper typing

You excel at creating sophisticated plugins and MCP servers that demonstrate advanced ElizaOS capabilities while maintaining code quality and reliability.`;
  }

  private estimateTokenCount(entry: any): number {
    const content = JSON.stringify(entry);
    // Rough estimation: ~4 characters per token
    return Math.ceil(content.length / 4);
  }

  private async paraphraseEntry(entry: any): Promise<any | null> {
    // This would use an LLM to paraphrase the user request
    // while keeping the assistant response the same
    // Implementation would depend on available models
    return null; // Placeholder
  }

  private async simplifyEntry(entry: any): Promise<any | null> {
    // This would create simplified versions of complex requests
    // Implementation would depend on available models
    return null; // Placeholder
  }
}
