import { type IAgentRuntime, elizaLogger } from '@elizaos/core';
import {
  type TrainingConfig,
  type TrainingConversation,
  type TrainingTrajectory,
  type TrainingResponse,
} from '../types.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';

/**
 * Processes training conversations into various dataset formats
 */
export class DatasetProcessor {
  private outputDir: string;

  constructor(private runtime: IAgentRuntime) {
    this.outputDir = path.join(process.cwd(), 'training-data');
  }

  async initialize(): Promise<void> {
    elizaLogger.info('Initializing Dataset Processor');

    // Create output directory
    await fs.mkdir(this.outputDir, { recursive: true });

    elizaLogger.info(`Dataset output directory: ${this.outputDir}`);
  }

  /**
   * Process conversations into training dataset
   */
  async processConversations(
    conversations: TrainingConversation[],
    config: TrainingConfig
  ): Promise<string> {
    elizaLogger.info(`Processing ${conversations.length} conversations into dataset`);

    try {
      // Filter and prepare conversations
      const preparedConversations = await this.prepareConversations(conversations, config);

      // Generate trajectories for RLAIF
      const trajectories = await this.generateTrajectories(preparedConversations, config);

      // Split into train/validation/test sets
      const splits = this.splitDataset(trajectories, config.datasetConfig.splitRatio);

      // Save in specified format
      const datasetPath = await this.saveDataset(splits, config);

      // Generate metadata
      await this.generateMetadata(splits, config, datasetPath);

      elizaLogger.info(`Dataset processed and saved to: ${datasetPath}`);
      return datasetPath;
    } catch (error) {
      elizaLogger.error('Error processing conversations:', error);
      throw error;
    }
  }

  private async prepareConversations(
    conversations: TrainingConversation[],
    config: TrainingConfig
  ): Promise<TrainingConversation[]> {
    let prepared = [...conversations];

    // Filter by quality if specified
    if (config.datasetConfig.minQuality) {
      prepared = prepared.filter(
        (conv) => (conv.metadata.quality || 0) >= config.datasetConfig.minQuality!
      );
    }

    // Filter by message length
    if (config.extractionConfig.minConversationLength) {
      prepared = prepared.filter(
        (conv) => conv.messages.length >= config.extractionConfig.minConversationLength!
      );
    }

    if (config.extractionConfig.maxConversationLength) {
      prepared = prepared.filter(
        (conv) => conv.messages.length <= config.extractionConfig.maxConversationLength!
      );
    }

    // Deduplicate if requested
    if (config.datasetConfig.deduplicate) {
      prepared = this.deduplicateConversations(prepared);
    }

    elizaLogger.info(`Prepared ${prepared.length} conversations after filtering`);
    return prepared;
  }

  private deduplicateConversations(conversations: TrainingConversation[]): TrainingConversation[] {
    const seen = new Set<string>();
    const deduplicated: TrainingConversation[] = [];

    for (const conversation of conversations) {
      // Create hash of conversation content
      const content = conversation.messages.map((m) => m.content).join('\n');
      const hash = crypto.createHash('sha256').update(content).digest('hex');

      if (!seen.has(hash)) {
        seen.add(hash);
        deduplicated.push(conversation);
      }
    }

    elizaLogger.info(`Deduplicated ${conversations.length - deduplicated.length} conversations`);
    return deduplicated;
  }

  private async generateTrajectories(
    conversations: TrainingConversation[],
    config: TrainingConfig
  ): Promise<TrainingTrajectory[]> {
    elizaLogger.info('Generating RLAIF trajectories');

    const trajectories: TrainingTrajectory[] = [];

    for (const conversation of conversations) {
      // Extract user-assistant pairs
      const pairs = this.extractUserAssistantPairs(conversation);

      for (const pair of pairs) {
        const trajectory = await this.createTrajectory(pair, config);
        if (trajectory) {
          trajectories.push(trajectory);
        }
      }
    }

    elizaLogger.info(`Generated ${trajectories.length} training trajectories`);
    return trajectories;
  }

  private extractUserAssistantPairs(conversation: TrainingConversation) {
    const pairs: { user: string; assistant: string; metadata: any }[] = [];

    for (let i = 0; i < conversation.messages.length - 1; i++) {
      const userMsg = conversation.messages[i];
      const assistantMsg = conversation.messages[i + 1];

      if (userMsg.role === 'user' && assistantMsg.role === 'assistant') {
        pairs.push({
          user: userMsg.content,
          assistant: assistantMsg.content,
          metadata: {
            userMetadata: userMsg.metadata,
            assistantMetadata: assistantMsg.metadata,
            conversationId: conversation.id,
            timestamp: userMsg.timestamp,
          },
        });
      }
    }

    return pairs;
  }

  private async createTrajectory(
    pair: { user: string; assistant: string; metadata: any },
    config: TrainingConfig
  ): Promise<TrainingTrajectory | null> {
    try {
      // Generate alternative responses for RLAIF
      const responses = await this.generateAlternativeResponses(pair.user, pair.assistant, config);

      if (responses.length < 2) {
        return null; // Need at least 2 responses for comparison
      }

      const trajectory: TrainingTrajectory = {
        id: `traj-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
        prompt: pair.user,
        responses,
        scores: [], // Will be filled by RLAIF judging
        metadata: {
          domain: this.inferDomain(pair.user),
          difficulty: this.estimateDifficulty(pair.user),
          taskType: this.inferTaskType(pair.user),
          quality: pair.metadata.assistantMetadata?.quality || 0.5,
          timestamp: pair.metadata.timestamp,
        },
      };

      return trajectory;
    } catch (error) {
      elizaLogger.error('Error creating trajectory:', error);
      return null;
    }
  }

  private async generateAlternativeResponses(
    prompt: string,
    originalResponse: string,
    config: TrainingConfig
  ): Promise<TrainingResponse[]> {
    const responses: TrainingResponse[] = [];

    // Add the original response
    responses.push({
      text: originalResponse,
      metadata: {
        responseTime: 0,
        tokenCount: this.estimateTokenCount(originalResponse),
        confidence: 1.0,
      },
    });

    // Generate alternative responses using the model
    const maxVariants = Math.min(config.rlaifConfig.maxResponseVariants - 1, 3);

    for (let i = 0; i < maxVariants; i++) {
      try {
        const alternativeResponse = await this.runtime.useModel('TEXT_LARGE', {
          messages: [
            {
              role: 'system',
              content:
                'You are a helpful AI assistant. Provide a different but equally helpful response to the user query.',
            },
            {
              role: 'user',
              content: prompt,
            },
          ],
          temperature: 0.7 + i * 0.1, // Increase temperature for variety
          max_tokens: config.datasetConfig.maxTokens || 512,
        });

        responses.push({
          text:
            typeof alternativeResponse === 'string'
              ? alternativeResponse
              : (alternativeResponse as any).content || '',
          metadata: {
            responseTime: 0,
            tokenCount: this.estimateTokenCount(alternativeResponse),
            confidence: 0.8 - i * 0.1,
          },
        });
      } catch (error) {
        elizaLogger.warn(`Error generating alternative response ${i}:`, error);
      }
    }

    return responses;
  }

  private inferDomain(prompt: string): string {
    const lowerPrompt = prompt.toLowerCase();

    if (lowerPrompt.includes('code') || lowerPrompt.includes('program')) {
      return 'programming';
    }
    if (lowerPrompt.includes('data') || lowerPrompt.includes('analysis')) {
      return 'data-science';
    }
    if (lowerPrompt.includes('math') || lowerPrompt.includes('calculate')) {
      return 'mathematics';
    }
    if (lowerPrompt.includes('write') || lowerPrompt.includes('essay')) {
      return 'writing';
    }
    if (lowerPrompt.includes('explain') || lowerPrompt.includes('what is')) {
      return 'explanation';
    }
    if (lowerPrompt.includes('how to') || lowerPrompt.includes('step')) {
      return 'instruction';
    }

    return 'general';
  }

  private estimateDifficulty(prompt: string): number {
    // Simple heuristic based on prompt complexity
    const length = prompt.length;
    const questionWords = ['how', 'what', 'why', 'when', 'where', 'which'].filter((word) =>
      prompt.toLowerCase().includes(word)
    ).length;

    let difficulty = 0.3; // Base difficulty

    if (length > 200) {
      difficulty += 0.2;
    }
    if (questionWords > 2) {
      difficulty += 0.2;
    }
    if (prompt.includes('complex') || prompt.includes('detailed')) {
      difficulty += 0.3;
    }

    return Math.min(1.0, difficulty);
  }

  private inferTaskType(prompt: string): string {
    const lowerPrompt = prompt.toLowerCase();

    if (lowerPrompt.includes('explain') || lowerPrompt.includes('describe')) {
      return 'explanation';
    }
    if (lowerPrompt.includes('compare') || lowerPrompt.includes('difference')) {
      return 'comparison';
    }
    if (lowerPrompt.includes('analyze') || lowerPrompt.includes('evaluate')) {
      return 'analysis';
    }
    if (lowerPrompt.includes('create') || lowerPrompt.includes('generate')) {
      return 'generation';
    }
    if (lowerPrompt.includes('solve') || lowerPrompt.includes('calculate')) {
      return 'problem-solving';
    }
    if (lowerPrompt.includes('summarize') || lowerPrompt.includes('summary')) {
      return 'summarization';
    }

    return 'question-answering';
  }

  private estimateTokenCount(text: string | any): number {
    const textStr = typeof text === 'string' ? text : JSON.stringify(text);
    return Math.ceil(textStr.length / 4); // Rough estimation
  }

  private splitDataset(
    trajectories: TrainingTrajectory[],
    splitRatio: { train: number; validation: number; test: number }
  ) {
    // Shuffle trajectories
    const shuffled = [...trajectories].sort(() => Math.random() - 0.5);

    const total = shuffled.length;
    const trainSize = Math.floor(total * splitRatio.train);
    const validationSize = Math.floor(total * splitRatio.validation);

    return {
      train: shuffled.slice(0, trainSize),
      validation: shuffled.slice(trainSize, trainSize + validationSize),
      test: shuffled.slice(trainSize + validationSize),
    };
  }

  private async saveDataset(
    splits: {
      train: TrainingTrajectory[];
      validation: TrainingTrajectory[];
      test: TrainingTrajectory[];
    },
    config: TrainingConfig
  ): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const datasetDir = path.join(this.outputDir, `dataset-${timestamp}`);

    await fs.mkdir(datasetDir, { recursive: true });

    // Save each split
    for (const [splitName, data] of Object.entries(splits)) {
      const filename = `${splitName}.${config.datasetConfig.outputFormat}`;
      const filepath = path.join(datasetDir, filename);

      switch (config.datasetConfig.outputFormat) {
        case 'jsonl':
          await this.saveAsJSONL(data, filepath);
          break;
        case 'csv':
          await this.saveAsCSV(data, filepath);
          break;
        case 'parquet':
          await this.saveAsParquet(data, filepath);
          break;
        default:
          throw new Error(`Unsupported output format: ${config.datasetConfig.outputFormat}`);
      }

      elizaLogger.info(`Saved ${splitName} split (${data.length} samples) to ${filepath}`);
    }

    return datasetDir;
  }

  private async saveAsJSONL(data: TrainingTrajectory[], filepath: string): Promise<void> {
    const lines = data.map((item) => JSON.stringify(item)).join('\n');
    await fs.writeFile(filepath, lines, 'utf-8');
  }

  private async saveAsCSV(data: TrainingTrajectory[], filepath: string): Promise<void> {
    // Handle empty dataset
    if (data.length === 0) {
      // Write empty file or file with just headers
      const headers = 'id,prompt,responses,scores,domain,difficulty,taskType,quality,timestamp\n';
      await fs.writeFile(filepath, headers, 'utf-8');
      return;
    }

    // Convert to flat structure for CSV
    const csvData = data.map((trajectory) => ({
      id: trajectory.id,
      prompt: trajectory.prompt,
      responses: JSON.stringify(trajectory.responses),
      scores: JSON.stringify(trajectory.scores),
      domain: trajectory.metadata.domain,
      difficulty: trajectory.metadata.difficulty,
      taskType: trajectory.metadata.taskType,
      quality: trajectory.metadata.quality,
      timestamp: trajectory.metadata.timestamp,
    }));

    const header = `${Object.keys(csvData[0]).join(',')}\n`;
    const rows = csvData
      .map((row) =>
        Object.values(row)
          .map((value) => (typeof value === 'string' ? `"${value.replace(/"/g, '""')}"` : value))
          .join(',')
      )
      .join('\n');

    await fs.writeFile(filepath, header + rows, 'utf-8');
  }

  private async saveAsParquet(data: TrainingTrajectory[], filepath: string): Promise<void> {
    // For now, save as JSON and note that parquet conversion would need additional library
    elizaLogger.warn('Parquet format not yet implemented, saving as JSON');
    const jsonPath = filepath.replace('.parquet', '.json');
    await fs.writeFile(jsonPath, JSON.stringify(data, null, 2), 'utf-8');
  }

  private async generateMetadata(
    splits: any,
    config: TrainingConfig,
    datasetPath: string
  ): Promise<void> {
    const metadata = {
      dataset_info: {
        name: 'ElizaOS Training Dataset',
        version: '1.0.0',
        created_at: new Date().toISOString(),
        description: 'Training dataset extracted from ElizaOS agent conversations',
      },
      extraction_config: config.extractionConfig,
      dataset_config: config.datasetConfig,
      rlaif_config: config.rlaifConfig,
      statistics: {
        total_trajectories: Object.values(splits).reduce(
          (sum: number, split: any) => sum + split.length,
          0
        ),
        train_size: splits.train.length,
        validation_size: splits.validation.length,
        test_size: splits.test.length,
        domains: this.calculateDomainDistribution(splits),
        difficulty_distribution: this.calculateDifficultyDistribution(splits),
        task_type_distribution: this.calculateTaskTypeDistribution(splits),
      },
    };

    const metadataPath = path.join(datasetPath, 'metadata.json');
    await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf-8');

    elizaLogger.info(`Generated dataset metadata: ${metadataPath}`);
  }

  private calculateDomainDistribution(splits: any): Record<string, number> {
    const domains: Record<string, number> = {};

    for (const split of Object.values(splits)) {
      for (const trajectory of split as TrainingTrajectory[]) {
        const domain = trajectory.metadata.domain;
        domains[domain] = (domains[domain] || 0) + 1;
      }
    }

    return domains;
  }

  private calculateDifficultyDistribution(splits: any): Record<string, number> {
    const difficulties: Record<string, number> = { easy: 0, medium: 0, hard: 0 };

    for (const split of Object.values(splits)) {
      for (const trajectory of split as TrainingTrajectory[]) {
        const difficulty = trajectory.metadata.difficulty;
        if (difficulty < 0.4) {
          difficulties.easy++;
        } else if (difficulty < 0.7) {
          difficulties.medium++;
        } else {
          difficulties.hard++;
        }
      }
    }

    return difficulties;
  }

  private calculateTaskTypeDistribution(splits: any): Record<string, number> {
    const taskTypes: Record<string, number> = {};

    for (const split of Object.values(splits)) {
      for (const trajectory of split as TrainingTrajectory[]) {
        const taskType = trajectory.metadata.taskType;
        taskTypes[taskType] = (taskTypes[taskType] || 0) + 1;
      }
    }

    return taskTypes;
  }
}
