import {
  type Action,
  type ActionResult,
  type IAgentRuntime,
  type Memory,
  type State,
  type HandlerCallback,
  elizaLogger,
  ModelType,
} from '@elizaos/core';
import { type TrainingConfig, type TrainingServiceInterface } from '../types.js';
import { type TrainingService } from '../services/training-service.js';

/**
 * Action to extract training data from the ElizaOS database
 */
export const extractTrainingDataAction: Action = {
  name: 'EXTRACT_TRAINING_DATA',
  similes: ['EXTRACT_DATA', 'PREPARE_TRAINING_DATA', 'GET_TRAINING_DATA'],
  description:
    'Extract training data from ElizaOS conversations for model fine-tuning. Can be chained with START_TRAINING to immediately begin training or GENERATE_TRAINING_DATA to create synthetic examples.',

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
    // Check if training service is available
    const trainingService = runtime.getService<TrainingServiceInterface>('training');
    if (!trainingService) {
      elizaLogger.warn('Training service not available');
      return false;
    }

    // Check if user has permission to extract training data
    const trustService = runtime.getService('trust');
    if (trustService && typeof (trustService as any).getTrustScore === 'function') {
      try {
        const trustScore = await (trustService as any).getTrustScore(message.entityId);
        if (trustScore < 0.8) {
          elizaLogger.warn('Insufficient trust score for training data extraction');
          return false;
        }
      } catch (error) {
        elizaLogger.warn('Could not check trust score, proceeding with extraction');
      }
    }

    // Check if message contains extraction request
    const text = message.content.text?.toLowerCase();
    if (!text) {
      return false;
    }

    const extractionKeywords = [
      'extract training data',
      'prepare dataset',
      'export conversations',
      'create training set',
      'generate training data',
      'extract conversation data',
    ];

    return extractionKeywords.some((keyword) => text.includes(keyword));
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    elizaLogger.info('Executing EXTRACT_TRAINING_DATA action');

    try {
      const trainingService = runtime.getService<TrainingService>('training');
      if (!trainingService) {
        throw new Error('Training service not available');
      }

      // Parse extraction configuration from message
      const config = await parseExtractionConfig(runtime, message, state);

      await callback?.({
        text: 'Starting training data extraction...',
        thought: 'Beginning extraction process with provided configuration',
        actions: ['EXTRACT_TRAINING_DATA'],
      });

      // Extract training data
      elizaLogger.info('Extracting training conversations');
      const conversations = await trainingService.extractTrainingData(config);

      // Prepare dataset
      elizaLogger.info('Processing conversations into dataset');
      const datasetPath = await trainingService.prepareDataset(conversations, config);

      // Get statistics
      const stats = await trainingService.getTrainingStats();

      const responseText = `✅ Training data extraction completed!

**Dataset Statistics:**
- Total Conversations: ${stats.totalConversations}
- Total Messages: ${stats.totalMessages}
- Average Conversation Length: ${stats.averageConversationLength.toFixed(1)} messages
- Average Message Length: ${stats.averageMessageLength.toFixed(1)} characters
- Unique Participants: ${stats.participantCount}
- Time Span: ${stats.timeSpan.durationDays} days
- Successful Actions: ${stats.actionStats.successfulActions}/${stats.actionStats.totalActions}
- Average Quality Score: ${stats.qualityMetrics.averageQuality.toFixed(2)}

**Dataset Location:** \`${datasetPath}\`

**Format:** ${config.datasetConfig.outputFormat.toUpperCase()}
**Splits:** ${(config.datasetConfig.splitRatio.train * 100).toFixed(0)}% train, ${(config.datasetConfig.splitRatio.validation * 100).toFixed(0)}% validation, ${(config.datasetConfig.splitRatio.test * 100).toFixed(0)}% test

The dataset is ready for RLAIF training with Atropos!`;

      await callback?.({
        text: responseText,
        thought: 'Successfully extracted and processed training data',
        actions: ['EXTRACT_TRAINING_DATA'],
      });

      return {
        text: `Training data extracted: ${conversations.length} conversations processed`,
        data: {
          actionName: 'EXTRACT_TRAINING_DATA',
          config,
          conversations: conversations.slice(0, 5), // Sample for context
          datasetPath,
        },
        values: {
          success: true,
          datasetPath,
          totalConversations: conversations.length,
          datasetStats: stats,
        },
      };
    } catch (error) {
      elizaLogger.error('Error in EXTRACT_TRAINING_DATA action:', error);

      await callback?.({
        text: `❌ Error extracting training data: ${error instanceof Error ? error.message : String(error)}`,
        thought: 'Training data extraction failed',
        actions: ['EXTRACT_TRAINING_DATA'],
      });

      return {
        text: `Failed to extract training data: ${error instanceof Error ? error.message : String(error)}`,
        data: {
          actionName: 'EXTRACT_TRAINING_DATA',
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
        values: {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
  },

  examples: [
    // Multi-action: Extract data then start training
    [
      {
        name: 'User',
        content: {
          text: 'Extract training data from the last 30 days and start RLAIF training',
        },
      },
      {
        name: 'Assistant',
        content: {
          text: "I'll extract training data from the last 30 days and then start RLAIF training.",
          thought: 'User wants extraction followed by training',
          actions: ['EXTRACT_TRAINING_DATA', 'START_TRAINING'],
        },
      },
    ],
    // Multi-action: Extract then generate synthetic examples
    [
      {
        name: 'User',
        content: {
          text: 'Extract existing conversations and generate additional training examples',
        },
      },
      {
        name: 'Assistant',
        content: {
          text: "I'll extract existing conversations and then generate additional synthetic training examples.",
          thought: 'User wants real and synthetic data combination',
          actions: ['EXTRACT_TRAINING_DATA', 'GENERATE_TRAINING_DATA'],
        },
      },
    ],
    // Multi-action: Check status, extract, and monitor
    [
      {
        name: 'User',
        content: {
          text: 'Check training status, extract new data if needed, and monitor the process',
        },
      },
      {
        name: 'Assistant',
        content: {
          text: "I'll check the training status, extract new data if needed, and set up monitoring.",
          thought: 'User wants conditional extraction with monitoring',
          actions: ['CHECK_TRAINING_STATUS', 'EXTRACT_TRAINING_DATA', 'MONITOR_TRAINING'],
        },
      },
    ],
    [
      {
        name: 'User',
        content: {
          text: 'Extract training data from the last 30 days for fine-tuning',
        },
      },
      {
        name: 'Assistant',
        content: {
          text: "I'll extract training data from conversations in the last 30 days. Let me configure the extraction parameters and process the data for fine-tuning.",
          thought: 'User wants to extract recent conversation data for training purposes',
          actions: ['EXTRACT_TRAINING_DATA'],
        },
      },
    ],
  ],
};

/**
 * Parse extraction configuration from user message and state
 */
async function parseExtractionConfig(
  runtime: IAgentRuntime,
  message: Memory,
  state?: State
): Promise<TrainingConfig> {
  const text = message.content.text || '';

  // Use LLM to extract configuration parameters from natural language
  const configPrompt = `Parse the following request for training data extraction and return a JSON configuration:

Request: "${text}"

Extract these parameters if mentioned:
- Date range (startDate, endDate)
- Minimum/maximum conversation length
- Quality threshold
- Specific plugins to include/exclude
- Output format preference
- RLAIF configuration

Provide reasonable defaults for missing parameters.

Return only valid JSON with this structure:
{
  "extractionConfig": {
    "startDate": "YYYY-MM-DD or null",
    "endDate": "YYYY-MM-DD or null", 
    "minConversationLength": number,
    "maxConversationLength": number,
    "includeActions": boolean,
    "includeProviders": boolean,
    "includeEvaluators": boolean,
    "includePlugins": ["plugin-name"],
    "excludePlugins": ["plugin-name"]
  },
  "datasetConfig": {
    "outputFormat": "jsonl|csv|parquet",
    "splitRatio": {"train": 0.8, "validation": 0.1, "test": 0.1},
    "maxTokens": number,
    "deduplicate": boolean,
    "minQuality": number
  },
  "rlaifConfig": {
    "judgeModel": "gpt-4",
    "preferenceDescription": "helpful and harmless responses",
    "maxResponseVariants": 3,
    "scoringStrategy": "pairwise",
    "rewardThreshold": 0.7
  },
  "atroposConfig": {
    "apiUrl": "http://localhost:8000",
    "environment": "rlaif",
    "batchSize": 4,
    "maxSteps": 1000,
    "learningRate": 1e-5,
    "warmupSteps": 100,
    "evalSteps": 50,
    "saveSteps": 100
  }
}`;

  try {
    const response = await runtime.useModel(ModelType.TEXT_SMALL, {
      messages: [{ role: 'user', content: configPrompt }],
      temperature: 0.1,
    });

    const configText =
      typeof response === 'string' ? response : (response as any).content || String(response);

    // Extract JSON from response
    const jsonMatch = configText.match(/{[\s\S]*}/);
    if (!jsonMatch) {
      throw new Error('Could not parse configuration from response');
    }

    const parsedConfig = JSON.parse(jsonMatch[0]);

    // Apply defaults and validation
    const config: TrainingConfig = {
      extractionConfig: {
        includeSystemMessages: false,
        includeActions: true,
        includeProviders: true,
        includeEvaluators: true,
        ...parsedConfig.extractionConfig,
      },
      datasetConfig: {
        outputFormat: 'jsonl',
        splitRatio: { train: 0.8, validation: 0.1, test: 0.1 },
        maxTokens: 512,
        deduplicate: true,
        minQuality: 0.5,
        ...parsedConfig.datasetConfig,
      },
      rlaifConfig: {
        judgeModel: 'gpt-4',
        preferenceDescription: 'helpful, harmless, and honest responses',
        maxResponseVariants: 3,
        scoringStrategy: 'pairwise',
        rewardThreshold: 0.7,
        ...parsedConfig.rlaifConfig,
      },
      atroposConfig: {
        apiUrl: 'http://localhost:8000',
        environment: 'rlaif',
        batchSize: 4,
        maxSteps: 1000,
        learningRate: 1e-5,
        warmupSteps: 100,
        evalSteps: 50,
        saveSteps: 100,
        ...parsedConfig.atroposConfig,
      },
    };

    // Parse dates if provided as strings
    if (parsedConfig.extractionConfig?.startDate) {
      config.extractionConfig.startDate = new Date(parsedConfig.extractionConfig.startDate);
    }
    if (parsedConfig.extractionConfig?.endDate) {
      config.extractionConfig.endDate = new Date(parsedConfig.extractionConfig.endDate);
    }

    // Apply defaults based on context
    if (!config.extractionConfig.startDate && text.includes('last 30 days')) {
      config.extractionConfig.startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    }
    if (!config.extractionConfig.startDate && text.includes('last week')) {
      config.extractionConfig.startDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    }

    elizaLogger.info('Parsed training data extraction configuration', { config });
    return config;
  } catch (error) {
    elizaLogger.error('Error parsing extraction configuration:', error);

    // Return default configuration
    return {
      extractionConfig: {
        includeSystemMessages: false,
        includeActions: true,
        includeProviders: true,
        includeEvaluators: true,
      },
      datasetConfig: {
        outputFormat: 'jsonl',
        splitRatio: { train: 0.8, validation: 0.1, test: 0.1 },
        maxTokens: 512,
        deduplicate: true,
        minQuality: 0.5,
      },
      rlaifConfig: {
        judgeModel: 'gpt-4',
        preferenceDescription: 'helpful, harmless, and honest responses',
        maxResponseVariants: 3,
        scoringStrategy: 'pairwise',
        rewardThreshold: 0.7,
      },
      atroposConfig: {
        apiUrl: 'http://localhost:8000',
        environment: 'rlaif',
        batchSize: 4,
        maxSteps: 1000,
        learningRate: 1e-5,
        warmupSteps: 100,
        evalSteps: 50,
        saveSteps: 100,
      },
    };
  }
}
