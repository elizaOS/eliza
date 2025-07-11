import { promises as fs } from 'fs';
import { elizaLogger } from '@elizaos/core';
// Removed broken import - simple-types
// import { type TrainingExample, type JSONLEntry, type DatasetStats } from '../simple-types.js';

// Define the types inline for now
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

interface JSONLEntry {
  messages: Array<{
    role: 'system' | 'user' | 'assistant';
    content: string;
  }>;
}

interface DatasetStats {
  totalExamples: number;
  averageTokens: number;
  maxTokens: number;
  minTokens: number;
  averageQuality: number;
  tokenCount: number;
}

/**
 * Simple dataset builder for Together.ai format
 */
export class DatasetBuilder {
  private examples: TrainingExample[] = [];
  private dataDir: string;

  constructor(dataDir = './training-data') {
    this.dataDir = dataDir;
  }

  /**
   * Add a training example
   */
  async addExample(example: Omit<TrainingExample, 'id' | 'createdAt'>): Promise<string> {
    const id = `example-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const fullExample: TrainingExample = {
      ...example,
      id,
      createdAt: new Date(),
    };

    this.examples.push(fullExample);
    await this.saveExamples();
    return id;
  }

  /**
   * Load examples from file
   */
  async loadExamples(): Promise<void> {
    try {
      await fs.mkdir(this.dataDir, { recursive: true });
      const filePath = `${this.dataDir}/examples.json`;

      try {
        const content = await fs.readFile(filePath, 'utf-8');
        const data = JSON.parse(content);
        this.examples = data.map((ex: any) => ({
          ...ex,
          createdAt: new Date(ex.createdAt),
        }));
      } catch (error) {
        // File doesn't exist yet, start with empty array
        this.examples = [];
      }
    } catch (error) {
      throw new Error(
        `Failed to load examples: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Save examples to file
   */
  async saveExamples(): Promise<void> {
    try {
      await fs.mkdir(this.dataDir, { recursive: true });
      const filePath = `${this.dataDir}/examples.json`;
      await fs.writeFile(filePath, JSON.stringify(this.examples, null, 2));
    } catch (error) {
      throw new Error(
        `Failed to save examples: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Generate JSONL dataset
   */
  async generateJSONL(
    options: {
      includeThinking?: boolean;
      minQuality?: number;
      maxTokens?: number;
      outputPath?: string;
    } = {}
  ): Promise<string> {
    const {
      includeThinking = true,
      minQuality = 0.5,
      maxTokens = 4000,
      outputPath = `${this.dataDir}/dataset.jsonl`,
    } = options;

    try {
      // Filter examples by quality
      const filteredExamples = this.examples.filter((ex) => ex.quality >= minQuality);

      if (filteredExamples.length === 0) {
        throw new Error('No examples meet the quality threshold');
      }

      const jsonlEntries: string[] = [];

      for (const example of filteredExamples) {
        const entry: JSONLEntry = {
          messages: [
            {
              role: 'system',
              content:
                'You are an expert ElizaOS developer who creates high-quality plugins and MCP servers. You provide complete, working implementations that follow ElizaOS patterns.',
            },
            {
              role: 'user',
              content: example.request,
            },
          ],
        };

        // Build assistant response
        let assistantContent = '';
        if (includeThinking && example.thinking) {
          assistantContent += `<thinking>\n${example.thinking}\n</thinking>\n\n`;
        }
        assistantContent += example.response;

        // Check token count (rough estimation)
        const tokenCount =
          this.estimateTokens(JSON.stringify(entry)) + this.estimateTokens(assistantContent);
        if (tokenCount > maxTokens) {
          elizaLogger.warn(
            `Skipping example ${example.id}: exceeds token limit (${tokenCount} > ${maxTokens})`
          );
          continue;
        }

        entry.messages.push({
          role: 'assistant',
          content: assistantContent,
        });

        jsonlEntries.push(JSON.stringify(entry));
      }

      if (jsonlEntries.length === 0) {
        throw new Error('No examples passed token limit filter');
      }

      // Write JSONL file
      await fs.writeFile(outputPath, jsonlEntries.join('\n'));
      elizaLogger.info(
        `Generated JSONL dataset with ${jsonlEntries.length} examples: ${outputPath}`
      );

      return outputPath;
    } catch (error) {
      throw new Error(
        `Failed to generate JSONL: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Get dataset statistics
   */
  getStats(): DatasetStats {
    const totalExamples = this.examples.length;
    const averageQuality =
      totalExamples > 0
        ? this.examples.reduce((sum, ex) => sum + ex.quality, 0) / totalExamples
        : 0;

    const tokenCount = this.examples.reduce((sum, ex) => {
      const exampleText = `${ex.request} ${ex.response} ${ex.thinking || ''}`;
      return sum + this.estimateTokens(exampleText);
    }, 0);

    return {
      totalExamples,
      averageQuality,
      tokenCount,
      averageTokens: totalExamples > 0 ? tokenCount / totalExamples : 0,
      maxTokens: 0, // TODO: implement max token tracking
      minTokens: 0, // TODO: implement min token tracking
    };
  }

  /**
   * List all examples
   */
  listExamples(): TrainingExample[] {
    return [...this.examples];
  }

  /**
   * Remove example by ID
   */
  async removeExample(id: string): Promise<boolean> {
    const index = this.examples.findIndex((ex) => ex.id === id);
    if (index === -1) {
      return false;
    }

    this.examples.splice(index, 1);
    await this.saveExamples();
    return true;
  }

  /**
   * Validate JSONL format
   */
  async validateJSONL(filePath: string): Promise<{ valid: boolean; errors: string[] }> {
    const errors: string[] = [];

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.trim().split('\n');

      for (let i = 0; i < lines.length; i++) {
        try {
          const entry = JSON.parse(lines[i]);

          if (!entry.messages || !Array.isArray(entry.messages)) {
            errors.push(`Line ${i + 1}: Missing or invalid 'messages' array`);
            continue;
          }

          for (let j = 0; j < entry.messages.length; j++) {
            const message = entry.messages[j];
            if (!message.role || !message.content) {
              errors.push(`Line ${i + 1}, Message ${j + 1}: Missing 'role' or 'content'`);
            }
            if (!['system', 'user', 'assistant'].includes(message.role)) {
              errors.push(`Line ${i + 1}, Message ${j + 1}: Invalid role '${message.role}'`);
            }
          }
        } catch (parseError) {
          errors.push(
            `Line ${i + 1}: Invalid JSON - ${parseError instanceof Error ? parseError.message : String(parseError)}`
          );
        }
      }

      return { valid: errors.length === 0, errors };
    } catch (error) {
      return {
        valid: false,
        errors: [`Failed to read file: ${error instanceof Error ? error.message : String(error)}`],
      };
    }
  }

  /**
   * Simple token estimation (roughly 4 chars per token)
   */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
}
