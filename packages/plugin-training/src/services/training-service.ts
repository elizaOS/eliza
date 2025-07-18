import {
  Service,
  type IAgentRuntime,
  elizaLogger,
  ModelType,
  type Memory,
  type UUID,
} from '@elizaos/core';
import {
  TrainingError,
  ConfigurationError,
  DatabaseError,
  ProcessingError,
  ValidationError,
  ErrorHandler,
  withErrorHandling,
  withRetry,
  safely,
} from '../errors/training-errors.js';
import {
  type TrainingConfig,
  type TrainingConversation,
  type TrainingMessage,
  type TrainingJob,
  type DatasetStats,
  type TrainingServiceInterface,
  type CloudInstance,
  type ActionResult,
  type ProviderResult,
  type EvaluationResult,
} from '../types.js';
import { DataExtractor } from '../utils/data-extractor.js';
import { DatasetProcessor } from '../utils/dataset-processor.js';
import { HuggingFaceClient } from '../utils/huggingface-client.js';

export class TrainingService extends Service implements TrainingServiceInterface {
  static serviceType = 'training';
  capabilityDescription = 'Training data extraction and RLAIF training with Atropos';

  private dataExtractor: DataExtractor;
  private datasetProcessor: DatasetProcessor;
  private huggingFaceClient: HuggingFaceClient;
  private activeJobs: Map<string, TrainingJob> = new Map();

  constructor(runtime: IAgentRuntime) {
    super(runtime);
    this.dataExtractor = new DataExtractor(runtime);
    this.datasetProcessor = new DatasetProcessor(runtime);
    this.huggingFaceClient = new HuggingFaceClient(runtime);
  }

  static async start(runtime: IAgentRuntime): Promise<TrainingService> {
    const service = new TrainingService(runtime);
    await service.initialize();
    return service;
  }

  async initialize(): Promise<void> {
    elizaLogger.info('Initializing Training Service');

    // Validate configuration
    await this.validateConfiguration();

    // Initialize components
    await this.dataExtractor.initialize();
    await this.datasetProcessor.initialize();
    await this.huggingFaceClient.initialize();

    elizaLogger.info('Training Service initialized successfully');
  }

  /**
   * Safely access memory metadata without type assertions
   */
  private safeGetMemoryMetadata(memory: Memory, key: string): unknown {
    if (memory && typeof memory === 'object' && 'metadata' in memory) {
      const metadata = memory.metadata;
      if (metadata && typeof metadata === 'object' && key in metadata) {
        return metadata[key as keyof typeof metadata];
      }
    }
    return undefined;
  }

  /**
   * Safely set memory metadata
   */
  private safeSetMemoryMetadata(memory: Memory, key: string, value: unknown): void {
    if (memory && typeof memory === 'object') {
      if (!memory.metadata) {
        memory.metadata = {};
      }
      if (memory.metadata && typeof memory.metadata === 'object') {
        (memory.metadata as Record<string, unknown>)[key] = value;
      }
    }
  }

  private async validateConfiguration(): Promise<void> {
    const requiredSettings = ['HUGGING_FACE_TOKEN', 'ATROPOS_API_URL'];

    // Validate required configuration using error handler
    ErrorHandler.validateConfiguration(
      {
        HUGGING_FACE_TOKEN: this.runtime.getSetting('HUGGING_FACE_TOKEN'),
        ATROPOS_API_URL: this.runtime.getSetting('ATROPOS_API_URL'),
      },
      requiredSettings
    );

    // Check database connection with proper error handling
    try {
      await this.runtime.getConnection();
    } catch (error) {
      throw new DatabaseError(
        'connect',
        'Database connection not available for training data extraction',
        {
          component: 'TrainingService',
          error: error instanceof Error ? error.message : String(error),
        }
      );
    }
  }

  /**
   * Extract training data from the ElizaOS database
   */
  async extractTrainingData(config: TrainingConfig): Promise<TrainingConversation[]> {
    return await withRetry(
      async () => {
        elizaLogger.info('Starting training data extraction', { config });

        // Get all rooms and conversations
        const rooms = await this.dataExtractor.getAllRooms(config.extractionConfig);
        const conversations: TrainingConversation[] = [];

        for (const room of rooms) {
          const conversation = await safely(
            () => this.extractConversationData(room.id, config),
            'extract_conversation_data',
            { roomId: room.id }
          );

          if (conversation && this.isValidConversation(conversation, config)) {
            conversations.push(conversation);
          }
        }

        if (conversations.length === 0) {
          throw new ValidationError(
            'conversations',
            conversations.length,
            'At least one valid conversation required'
          );
        }

        elizaLogger.info(`Extracted ${conversations.length} training conversations`);
        return conversations;
      },
      'extract_training_data',
      { configType: 'TrainingConfig', roomCount: 0 },
      3
    );
  }

  private async extractConversationData(
    roomId: UUID,
    config: TrainingConfig
  ): Promise<TrainingConversation | null> {
    return await ErrorHandler.handleError(
      new Error('Conversation data extraction'),
      'extract_conversation_data',
      { roomId, configType: 'TrainingConfig' },
      async () => {
        // Get all messages in the room with error handling
        const memories = await this.getMemoriesWithRetry(roomId);

        if (!memories || memories.length === 0) {
          throw new ValidationError(
            'memories',
            memories?.length || 0,
            'At least one memory required for conversation'
          );
        }

        // Convert memories to training messages
        const messages: TrainingMessage[] = [];
        for (const memory of memories) {
          const trainingMessage = await safely(
            () => this.convertMemoryToTrainingMessage(memory, config),
            'convert_memory_to_training_message',
            { memoryId: memory.id, roomId }
          );

          if (trainingMessage) {
            messages.push(trainingMessage);
          }
        }

        if (messages.length === 0) {
          throw new ProcessingError(
            'memory_conversion',
            'No valid training messages could be extracted from memories'
          );
        }

        // Get room metadata with error handling
        const [room, participants] = await Promise.all([
          safely(() => (this.runtime as any).adapter?.getRoom(roomId), 'get_room_metadata', {
            roomId,
          }),
          safely(
            () => (this.runtime as any).adapter?.getParticipantsForRoom(roomId),
            'get_room_participants',
            { roomId }
          ),
        ]);

        const conversation: TrainingConversation = {
          id: roomId,
          roomId,
          worldId: (room as any)?.worldId,
          agentId: this.runtime.agentId,
          participants: Array.isArray(participants) ? participants.map((p: any) => p.id) : [],
          messages,
          metadata: {
            startTime: Math.min(...messages.map((m) => m.timestamp)),
            endTime: Math.max(...messages.map((m) => m.timestamp)),
            messageCount: messages.length,
            actionCount: messages.reduce(
              (count, msg) => count + (msg.metadata?.actions?.length || 0),
              0
            ),
            successfulActions: messages.reduce(
              (count, msg) =>
                count + (msg.metadata?.actionResults?.filter((r) => r.success).length || 0),
              0
            ),
          },
        };

        // Calculate quality score with error handling
        conversation.metadata.quality =
          (await safely(
            () => this.calculateConversationQuality(conversation),
            'calculate_conversation_quality',
            { roomId, messageCount: messages.length }
          )) || 0.5; // Default neutral score on failure

        return conversation;
      }
    );
  }

  private async getMemoriesWithRetry(roomId: UUID): Promise<Memory[]> {
    return await withRetry(
      async () => {
        const adapter = (this.runtime as any).adapter;
        if (!adapter) {
          throw new DatabaseError('access', 'Database adapter not available', { roomId });
        }

        const memories = await adapter.getMemories({
          roomId,
          count: 10000,
          unique: true,
        });

        return memories || [];
      },
      'get_memories',
      { roomId },
      3
    );
  }

  private async convertMemoryToTrainingMessage(
    memory: Memory,
    config: TrainingConfig
  ): Promise<TrainingMessage | null> {
    return await ErrorHandler.handleError(
      new Error('Memory to training message conversion'),
      'convert_memory_to_training_message',
      { memoryId: memory.id, entityId: memory.entityId },
      async () => {
        // Validate memory structure
        if (!memory.id) {
          throw new ValidationError('memory.id', memory.id, 'Memory ID is required');
        }

        if (!memory.content || typeof memory.content !== 'object') {
          throw new ValidationError(
            'memory.content',
            memory.content,
            'Memory content must be a valid object'
          );
        }

        const role = memory.entityId === this.runtime.agentId ? 'assistant' : 'user';

        const trainingMessage: TrainingMessage = {
          id: memory.id,
          role,
          content: memory.content.text || '',
          timestamp: memory.createdAt || Date.now(),
          entityId: memory.entityId,
          metadata: {
            thought: memory.content.thought,
            actions: memory.content.actions || [],
          },
        };

        // Validate content length
        if (trainingMessage.content.length === 0) {
          throw new ValidationError(
            'trainingMessage.content',
            trainingMessage.content,
            'Training message content cannot be empty'
          );
        }

        // Extract additional metadata if configured with error handling
        if (config.extractionConfig.includeActions) {
          trainingMessage.metadata!.actionResults =
            (await safely(() => this.extractActionResults(memory), 'extract_action_results', {
              memoryId: memory.id,
            })) || [];
        }

        if (config.extractionConfig.includeProviders) {
          trainingMessage.metadata!.providerResults =
            (await safely(() => this.extractProviderResults(memory), 'extract_provider_results', {
              memoryId: memory.id,
            })) || [];
        }

        if (config.extractionConfig.includeEvaluators) {
          trainingMessage.metadata!.evaluationResults =
            (await safely(
              () => this.extractEvaluationResults(memory),
              'extract_evaluation_results',
              { memoryId: memory.id }
            )) || [];
        }

        // Calculate token count if needed
        if (config.datasetConfig.maxTokens) {
          trainingMessage.metadata!.tokenCount =
            (await safely(
              () => this.estimateTokenCount(trainingMessage.content),
              'estimate_token_count',
              { contentLength: trainingMessage.content.length }
            )) || Math.ceil(trainingMessage.content.length / 4); // Fallback estimation
        }

        return trainingMessage;
      }
    );
  }

  private async extractActionResults(memory: Memory): Promise<ActionResult[]> {
    const results: ActionResult[] = [];

    try {
      // Extract from memory content actions field
      if (memory.content.actions && Array.isArray(memory.content.actions)) {
        for (const actionName of memory.content.actions) {
          // Look for action results in metadata
          const actionResult: ActionResult = {
            actionName,
            success: true, // Default to success
            duration: 0,
            input: memory.content,
            output: null,
            error: undefined,
            metadata: {},
          };

          // Check if there's action-specific metadata
          if ((memory.metadata as any as any)?.actionResults) {
            const storedResult = (memory.metadata as any as any).actionResults.find(
              (r: any) => r.actionName === actionName
            );
            if (storedResult) {
              Object.assign(actionResult, storedResult);
            }
          }

          // Extract duration from timestamps if available
          if ((memory.metadata as any as any)?.actionTimestamps?.[actionName]) {
            actionResult.duration =
              (memory.metadata as any as any).actionTimestamps[actionName].duration || 0;
          }

          // Check for errors in metadata
          if ((memory.metadata as any as any)?.actionErrors?.[actionName]) {
            actionResult.success = false;
            actionResult.error = (memory.metadata as any).actionErrors[actionName];
          }

          results.push(actionResult);
        }
      }

      // Also check for action results stored directly in content
      if (memory.content.actionResults && Array.isArray(memory.content.actionResults)) {
        results.push(...memory.content.actionResults);
      }
    } catch (error) {
      elizaLogger.error('Error extracting action results from memory:', error);
    }

    return results;
  }

  private async extractProviderResults(memory: Memory): Promise<ProviderResult[]> {
    const results: ProviderResult[] = [];

    try {
      // Extract from memory content providers field
      if (memory.content.providers && Array.isArray(memory.content.providers)) {
        for (const providerName of memory.content.providers) {
          const providerResult: ProviderResult = {
            providerName,
            success: true,
            duration: 0,
            data: null,
            error: undefined,
            metadata: {},
          };

          // Check if there's provider-specific metadata
          if ((memory.metadata as any as any)?.providerResults) {
            const storedResult = (memory.metadata as any).providerResults.find(
              (r: any) => r.providerName === providerName
            );
            if (storedResult) {
              Object.assign(providerResult, storedResult);
            }
          }

          // Extract provider data from state if available
          if ((memory.metadata as any as any)?.providerData?.[providerName]) {
            providerResult.data = (memory.metadata as any).providerData[providerName];
          }

          // Extract duration from timestamps if available
          if ((memory.metadata as any as any)?.providerTimestamps?.[providerName]) {
            providerResult.duration =
              (memory.metadata as any).providerTimestamps[providerName].duration || 0;
          }

          // Check for errors in metadata
          if ((memory.metadata as any as any)?.providerErrors?.[providerName]) {
            providerResult.success = false;
            providerResult.error = (memory.metadata as any).providerErrors[providerName];
          }

          results.push(providerResult);
        }
      }

      // Also check for provider results stored directly in content
      if (memory.content.providerResults && Array.isArray(memory.content.providerResults)) {
        results.push(...memory.content.providerResults);
      }

      // Extract from state data if available
      if ((memory.metadata as any as any)?.stateData?.providers) {
        const stateProviders = (memory.metadata as any).stateData.providers;
        for (const [providerName, data] of Object.entries(stateProviders)) {
          results.push({
            providerName,
            success: true,
            duration: 0,
            data,
            metadata: { source: 'state_data' },
          });
        }
      }
    } catch (error) {
      elizaLogger.error('Error extracting provider results from memory:', error);
    }

    return results;
  }

  private async extractEvaluationResults(memory: Memory): Promise<EvaluationResult[]> {
    const results: EvaluationResult[] = [];

    try {
      // Extract evaluations from memory metadata
      if (
        (memory.metadata as any as any)?.evaluationResults &&
        Array.isArray((memory.metadata as any).evaluationResults)
      ) {
        results.push(...(memory.metadata as any).evaluationResults);
      }

      // Extract from evaluators field in content
      if (memory.content.evaluators && Array.isArray(memory.content.evaluators)) {
        for (const evaluatorName of memory.content.evaluators) {
          const evaluationResult: EvaluationResult = {
            evaluatorName,
            success: true,
            duration: 0,
            insights: [],
            facts: [],
            relationships: [],
            error: undefined,
            metadata: {},
          };

          // Check if there's evaluator-specific metadata
          if ((memory.metadata as any as any)?.evaluatorResults) {
            const storedResult = (memory.metadata as any).evaluatorResults.find(
              (r: any) => r.evaluatorName === evaluatorName
            );
            if (storedResult) {
              Object.assign(evaluationResult, storedResult);
            }
          }

          // Extract facts if stored in memory
          if ((memory.metadata as any as any)?.extractedFacts) {
            evaluationResult.facts = (memory.metadata as any).extractedFacts;
          }

          // Extract relationships if stored in memory
          if ((memory.metadata as any as any)?.extractedRelationships) {
            evaluationResult.relationships = (memory.metadata as any).extractedRelationships;
          }

          // Extract insights if stored in memory
          if ((memory.metadata as any as any)?.insights) {
            evaluationResult.insights = (memory.metadata as any).insights;
          }

          // Extract duration from timestamps if available
          if ((memory.metadata as any as any)?.evaluatorTimestamps?.[evaluatorName]) {
            evaluationResult.duration =
              (memory.metadata as any).evaluatorTimestamps[evaluatorName].duration || 0;
          }

          // Check for errors in metadata
          if ((memory.metadata as any as any)?.evaluatorErrors?.[evaluatorName]) {
            evaluationResult.success = false;
            evaluationResult.error = (memory.metadata as any).evaluatorErrors[evaluatorName];
          }

          results.push(evaluationResult);
        }
      }

      // Look for fact extraction results in other memory types
      if (this.runtime) {
        try {
          // Search for related fact memories in the same room
          const factMemories = await (this.runtime as any).messageManager?.getMemories({
            roomId: memory.roomId,
            tableName: 'facts',
            unique: false,
            count: 10,
          });

          if (factMemories?.length > 0) {
            // Create evaluation result for fact extraction
            const factEvaluation: EvaluationResult = {
              evaluatorName: 'EXTRACT_FACTS',
              success: true,
              duration: 0,
              facts: factMemories.map((m: any) => m.content.text).filter(Boolean),
              insights: [],
              relationships: [],
              metadata: { source: 'fact_memories', count: factMemories.length },
            };
            results.push(factEvaluation);
          }
        } catch (error) {
          elizaLogger.debug('Could not retrieve fact memories:', error);
        }
      }
    } catch (error) {
      elizaLogger.error('Error extracting evaluation results from memory:', error);
    }

    return results;
  }

  private async estimateTokenCount(text: string): Promise<number> {
    try {
      // Use more accurate token estimation
      // This approximates common tokenization patterns

      // Remove extra whitespace and normalize
      const normalized = text.trim().replace(/\s+/g, ' ');

      // Split by common token boundaries
      const words = normalized.split(/\s+/);
      const punctuation = (normalized.match(/[.,!?;:()[\]{}'"]/g) || []).length;
      const numbers = (normalized.match(/\d+/g) || []).length;

      // Estimate subword tokens
      let tokenCount = 0;

      for (const word of words) {
        if (word.length <= 3) {
          tokenCount += 1; // Short words are usually one token
        } else if (word.length <= 6) {
          tokenCount += Math.ceil(word.length / 4); // Medium words
        } else {
          tokenCount += Math.ceil(word.length / 3.5); // Longer words split more
        }
      }

      // Add tokens for punctuation and numbers
      tokenCount += punctuation;
      tokenCount += numbers * 0.5; // Numbers are often subword tokens

      // Add some overhead for special tokens
      tokenCount = Math.ceil(tokenCount * 1.1);

      return Math.max(1, tokenCount);
    } catch (error) {
      elizaLogger.error('Error estimating token count:', error);
      // Fallback to simple estimation
      return Math.max(1, Math.ceil(text.length / 4));
    }
  }

  private isValidConversation(conversation: TrainingConversation, config: TrainingConfig): boolean {
    const { minConversationLength, maxConversationLength } = config.extractionConfig;

    if (minConversationLength && conversation.messages.length < minConversationLength) {
      return false;
    }

    if (maxConversationLength && conversation.messages.length > maxConversationLength) {
      return false;
    }

    return true;
  }

  private async calculateConversationQuality(conversation: TrainingConversation): Promise<number> {
    try {
      let score = 0.0;
      const messages = conversation.messages;

      if (messages.length === 0) {
        return 0.0;
      }

      // 1. Action success rate (0.0 - 0.3)
      if (conversation.metadata.actionCount > 0) {
        const successRate =
          conversation.metadata.successfulActions / conversation.metadata.actionCount;
        score += successRate * 0.3;
      } else {
        score += 0.1; // Small bonus for conversations without actions
      }

      // 2. Message quality metrics (0.0 - 0.25)
      const messageLengths = messages.map((m) => m.content.length);
      const avgLength = messageLengths.reduce((a, b) => a + b, 0) / messageLengths.length;
      const lengthVariance = this.calculateVariance(messageLengths);

      // Reward meaningful message lengths (not too short, not too long)
      if (avgLength >= 20 && avgLength <= 500) {
        score += 0.15;
      } else if (avgLength >= 10) {
        score += 0.1;
      }

      // Reward length diversity (avoid repetitive responses)
      if (lengthVariance > 100) {
        score += 0.1;
      }

      // 3. Conversation flow quality (0.0 - 0.25)
      const userMessages = messages.filter((m) => m.role === 'user');
      const assistantMessages = messages.filter((m) => m.role === 'assistant');

      // Check for proper turn-taking
      if (userMessages.length > 0 && assistantMessages.length > 0) {
        const ratio =
          Math.min(userMessages.length, assistantMessages.length) /
          Math.max(userMessages.length, assistantMessages.length);
        score += ratio * 0.15; // Reward balanced conversations
      }

      // Reward multi-turn conversations
      if (messages.length >= 4) {
        score += 0.1;
      }

      // 4. Content quality indicators (0.0 - 0.2)
      let contentQuality = 0;

      // Check for diverse vocabulary
      const allText = messages.map((m) => m.content.toLowerCase()).join(' ');
      const words = allText.split(/\s+/);
      const uniqueWords = new Set(words);
      const vocabularyDiversity = uniqueWords.size / words.length;

      if (vocabularyDiversity > 0.6) {
        contentQuality += 0.1;
      } else if (vocabularyDiversity > 0.4) {
        contentQuality += 0.05;
      }

      // Check for thoughtful responses (has metadata like thought or reasoning)
      const thoughtfulResponses = assistantMessages.filter(
        (m) => m.metadata?.thought || (m.metadata?.actions?.length || 0) > 0
      ).length;

      if (thoughtfulResponses > 0) {
        contentQuality += Math.min(0.1, (thoughtfulResponses / assistantMessages.length) * 0.1);
      }

      score += contentQuality;

      // 5. Penalty adjustments

      // Penalize very short conversations
      if (messages.length < 2) {
        score *= 0.5;
      }

      // Penalize conversations with errors
      const errorMessages = messages.filter(
        (m) => (m.metadata as any)?.error || (m.content && m.content.includes('error'))
      );
      if (errorMessages.length > 0) {
        score *= 1 - (errorMessages.length / messages.length) * 0.3;
      }

      // Ensure score is within bounds
      return Math.max(0.0, Math.min(1.0, score));
    } catch (error) {
      elizaLogger.error('Error calculating conversation quality:', error);
      return 0.5; // Default neutral score
    }
  }

  private calculateVariance(numbers: number[]): number {
    if (numbers.length === 0) {
      return 0;
    }

    const mean = numbers.reduce((a, b) => a + b, 0) / numbers.length;
    const squaredDiffs = numbers.map((n) => Math.pow(n - mean, 2));
    return squaredDiffs.reduce((a, b) => a + b, 0) / numbers.length;
  }

  /**
   * Prepare dataset from extracted conversations
   */
  async prepareDataset(
    conversations: TrainingConversation[],
    config: TrainingConfig
  ): Promise<string> {
    elizaLogger.info(`Preparing dataset from ${conversations.length} conversations`);

    return await this.datasetProcessor.processConversations(conversations, config);
  }

  /**
   * Upload dataset to Hugging Face
   */
  async uploadToHuggingFace(datasetPath: string, config: TrainingConfig): Promise<string> {
    elizaLogger.info('Uploading dataset to Hugging Face', { datasetPath });

    return await this.huggingFaceClient.uploadDataset(datasetPath, config);
  }

  /**
   * Start RLAIF training with Atropos
   */
  async startTraining(config: TrainingConfig): Promise<TrainingJob> {
    return await withRetry(
      async () => {
        elizaLogger.info('Starting RLAIF training', { config });

        // Validate configuration before starting
        if (!(config as any).trainingConfig) {
          throw new ConfigurationError('Training configuration is required', 'trainingConfig');
        }

        const jobId = `training-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

        const job: TrainingJob = {
          id: jobId,
          status: 'pending',
          config,
          startTime: new Date(),
        };

        this.activeJobs.set(jobId, job);

        try {
          // Start Atropos training with error handling
          // await this.atroposBridge.startTraining(job); // Temporarily removed until implemented

          job.status = 'running';
          elizaLogger.info(`Training job ${jobId} started successfully`);

          return job;
        } catch (error) {
          job.status = 'failed';
          job.error = error instanceof Error ? error.message : String(error);

          const trainingError = ErrorHandler.normalizeError(error, 'start_training', {
            jobId,
            configType: 'TrainingConfig',
          });

          elizaLogger.error(`Failed to start training job ${jobId}`, trainingError.toLogContext());
          throw trainingError;
        }
      },
      'start_training',
      { configType: 'TrainingConfig' },
      2
    );
  }

  /**
   * Monitor training progress
   */
  async monitorTraining(jobId: string): Promise<TrainingJob> {
    const job = this.activeJobs.get(jobId);
    if (!job) {
      throw new Error(`Training job ${jobId} not found`);
    }

    // Get updated status from Atropos
    // const status = await this.atroposBridge.getTrainingStatus(jobId); // Temporarily removed until implemented
    const status = { status: 'unknown', progress: 0 }; // Placeholder

    // Update job with latest status
    Object.assign(job, status);

    return job;
  }

  /**
   * Deploy training to cloud
   */
  async deployToCloud(config: TrainingConfig): Promise<CloudInstance> {
    elizaLogger.info('Deploying training to cloud', { config });

    // return await this.cloudDeployment.deployTraining(config); // Temporarily removed until implemented
    throw new Error('Cloud deployment not available yet');
  }

  /**
   * Stop training job
   */
  async stopTraining(jobId: string): Promise<void> {
    const job = this.activeJobs.get(jobId);
    if (!job) {
      throw new Error(`Training job ${jobId} not found`);
    }

    // await this.atroposBridge.stopTraining(jobId); // Temporarily removed until implemented

    job.status = 'cancelled';
    job.endTime = new Date();

    elizaLogger.info(`Training job ${jobId} stopped`);
  }

  /**
   * Get training statistics
   */
  async getTrainingStats(): Promise<DatasetStats> {
    elizaLogger.info('Calculating training statistics');

    return await this.dataExtractor.getDatasetStats();
  }

  async stop(): Promise<void> {
    elizaLogger.info('Stopping Training Service');

    // Stop all active training jobs
    for (const jobId of this.activeJobs.keys()) {
      try {
        await this.stopTraining(jobId);
      } catch (error) {
        elizaLogger.error(`Error stopping training job ${jobId}:`, error);
      }
    }

    // Cleanup components
    // await this.atroposBridge.cleanup(); // Temporarily removed until implemented
    // await this.cloudDeployment.cleanup(); // Temporarily removed until implemented

    elizaLogger.info('Training Service stopped');
  }
}
