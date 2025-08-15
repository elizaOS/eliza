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
 * Action to start RLAIF training with Atropos
 */
export const startTrainingAction: Action = {
  name: 'START_TRAINING',
  similes: ['BEGIN_TRAINING', 'LAUNCH_TRAINING', 'INITIATE_TRAINING', 'START_RLAIF'],
  description:
    'Start RLAIF training with Atropos using extracted dataset. Can be chained with EXTRACT_TRAINING_DATA to prepare datasets or MONITOR_TRAINING to track progress.',

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
    // Check if training service is available
    const trainingService = runtime.getService<TrainingServiceInterface>('training');
    if (!trainingService) {
      elizaLogger.warn('Training service not available');
      return false;
    }

    // Check if user has permission to start training
    const trustService = runtime.getService('trust');
    if (trustService && typeof (trustService as any).getTrustScore === 'function') {
      const trustScore = await (trustService as any).getTrustScore(message.entityId);
      if (trustScore < 0.9) {
        // Higher threshold for training
        elizaLogger.warn('Insufficient trust score for starting training');
        return false;
      }
    }

    // Check if message contains training request
    const text = message.content.text?.toLowerCase();
    if (!text) {
      return false;
    }

    const trainingKeywords = [
      'start training',
      'begin training',
      'launch training',
      'initiate training',
      'start rlaif',
      'begin fine-tuning',
      'start atropos training',
      'run training',
    ];

    return trainingKeywords.some((keyword) => text.includes(keyword));
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    elizaLogger.info('Executing START_TRAINING action');

    try {
      const trainingService = runtime.getService<TrainingService>('training');
      if (!trainingService) {
        throw new Error('Training service not available');
      }

      // Parse training configuration from message
      const config = await parseTrainingConfig(runtime, message, state);

      await callback?.({
        text: 'Initializing RLAIF training with Atropos...',
        thought: 'Setting up training environment and configuration',
        actions: ['START_TRAINING'],
      });

      // Check if we need to extract data first
      let datasetPath = state?.values?.datasetPath;
      if (!datasetPath) {
        elizaLogger.info('No existing dataset found, extracting training data first');

        await callback?.({
          text: 'No dataset found. Extracting training data first...',
          thought: 'Need to extract training data before starting training',
          actions: ['START_TRAINING'],
        });

        const conversations = await trainingService.extractTrainingData(config);
        const newDatasetPath = await trainingService.prepareDataset(conversations, config);

        elizaLogger.info(`Dataset prepared at: ${newDatasetPath}`);
        
        // Update datasetPath with the newly prepared dataset path
        datasetPath = newDatasetPath;
      }

      // Upload to Hugging Face if configured
      if (config.huggingFaceConfig) {
        await callback?.({
          text: 'Uploading dataset to Hugging Face...',
          thought: 'Uploading prepared dataset to Hugging Face Hub',
          actions: ['START_TRAINING'],
        });

        const huggingFaceUrl = await trainingService.uploadToHuggingFace(
          datasetPath || config.huggingFaceConfig.datasetName,
          config
        );

        elizaLogger.info(`Dataset uploaded to Hugging Face: ${huggingFaceUrl}`);
      }

      // Deploy to cloud if configured
      let cloudInstance = null;
      if (config.deploymentConfig) {
        await callback?.({
          text: `Deploying training to ${config.deploymentConfig.provider.toUpperCase()}...`,
          thought: 'Setting up cloud infrastructure for training',
          actions: ['START_TRAINING'],
        });

        cloudInstance = await trainingService.deployToCloud(config);
        elizaLogger.info(`Training deployed to cloud: ${cloudInstance.id}`);
      }

      // Start training
      await callback?.({
        text: 'Starting Atropos RLAIF training...',
        thought: 'Launching training job with Atropos',
        actions: ['START_TRAINING'],
      });

      const trainingJob = await trainingService.startTraining(config);

      const responseText = `🚀 RLAIF Training Started Successfully!

**Training Job ID:** \`${trainingJob.id}\`
**Status:** ${trainingJob.status}
**Start Time:** ${trainingJob.startTime?.toISOString()}

**Configuration:**
- **Model Environment:** ${config.atroposConfig.environment}
- **Batch Size:** ${config.atroposConfig.batchSize}
- **Max Steps:** ${config.atroposConfig.maxSteps}
- **Learning Rate:** ${config.atroposConfig.learningRate}
- **Judge Model:** ${config.rlaifConfig.judgeModel}
- **Scoring Strategy:** ${config.rlaifConfig.scoringStrategy}

${config.huggingFaceConfig ? `**Dataset:** https://huggingface.co/datasets/${config.huggingFaceConfig.organization}/${config.huggingFaceConfig.datasetName}` : ''}

${cloudInstance ? `**Cloud Instance:** ${cloudInstance.id} (${cloudInstance.provider}:${cloudInstance.region})` : ''}

**Monitoring:**
- Use \`monitor training ${trainingJob.id}\` to check progress
- Training logs will be available in the Atropos interface
- TensorBoard will be accessible if deployed to cloud

The training will proceed through the RLAIF pipeline:
1. Generate response variants
2. Judge preferences with ${config.rlaifConfig.judgeModel}
3. Apply reinforcement learning updates
4. Evaluate and save checkpoints every ${config.atroposConfig.saveSteps} steps

Happy training! 🎯`;

      await callback?.({
        text: responseText,
        thought: 'Successfully started RLAIF training with Atropos',
        actions: ['START_TRAINING'],
      });

      return {
        text: `Training started: ${trainingJob.id}`,
        data: {
          actionName: 'START_TRAINING',
          trainingJob,
          config,
          cloudInstance,
        },
        values: {
          success: true,
          trainingJobId: trainingJob.id,
          trainingStatus: trainingJob.status,
          cloudInstanceId: cloudInstance?.id,
        },
      };
    } catch (error) {
      elizaLogger.error('Error in START_TRAINING action:', error);

      await callback?.({
        text: `❌ Error starting training: ${error instanceof Error ? error.message : String(error)}

Please check:
- Atropos bridge is running
- Required API keys are configured
- Cloud credentials are set up (if using cloud deployment)
- Training data is available`,
        thought: 'Training initialization failed',
        actions: ['START_TRAINING'],
      });

      return {
        text: `Failed to start training: ${error instanceof Error ? error.message : String(error)}`,
        data: {
          actionName: 'START_TRAINING',
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
          text: 'Extract the training data from my conversation history and start RLAIF training',
        },
      },
      {
        name: 'Assistant',
        content: {
          text: "I'll extract training data from your conversation history and then start RLAIF training.",
          thought: 'User wants full training pipeline',
          actions: ['EXTRACT_TRAINING_DATA', 'START_TRAINING'],
        },
      },
    ],
    // Multi-action: Start training then monitor
    [
      {
        name: 'User',
        content: {
          text: 'Start training on Google Cloud and monitor the progress',
        },
      },
      {
        name: 'Assistant',
        content: {
          text: "I'll start RLAIF training on Google Cloud and set up monitoring for the progress.",
          thought: 'User wants cloud training with monitoring',
          actions: ['START_TRAINING', 'MONITOR_TRAINING'],
        },
      },
    ],
    // Multi-action: Check status, prepare data, then train
    [
      {
        name: 'User',
        content: {
          text: 'Check if I have existing datasets, generate new training data if needed, then start training',
        },
      },
      {
        name: 'Assistant',
        content: {
          text: "I'll check for existing datasets, generate new training data if needed, and then start the training process.",
          thought: 'User wants conditional training workflow',
          actions: ['CHECK_TRAINING_STATUS', 'GENERATE_TRAINING_DATA', 'START_TRAINING'],
        },
      },
    ],
    [
      {
        name: 'User',
        content: {
          text: 'Start RLAIF training with the extracted dataset',
        },
      },
      {
        name: 'Assistant',
        content: {
          text: "I'll start RLAIF training using the extracted dataset. Let me configure Atropos and begin the training process.",
          thought: 'User wants to start training with existing dataset',
          actions: ['START_TRAINING'],
        },
      },
    ],
  ],
};

/**
 * Parse training configuration from user message and state
 */
async function parseTrainingConfig(
  runtime: IAgentRuntime,
  message: Memory,
  state?: State
): Promise<TrainingConfig> {
  const text = message.content.text || '';

  // Use LLM to extract training configuration parameters
  const configPrompt = `Parse the following request for RLAIF training and return a JSON configuration:

Request: "${text}"

Extract these parameters if mentioned:
- Training steps/epochs
- Batch size
- Learning rate
- Model name/type (DeepSeek, Llama, etc.)
- Judge model (GPT-4, Claude, etc.)
- Cloud provider (GCP, AWS, Azure)
- Instance type
- Hugging Face organization/dataset name
- Any other training hyperparameters

Provide reasonable defaults for missing parameters.

Return only valid JSON with this structure:
{
  "extractionConfig": {
    "includeActions": true,
    "includeProviders": true,
    "includeEvaluators": true
  },
  "datasetConfig": {
    "outputFormat": "jsonl",
    "splitRatio": {"train": 0.8, "validation": 0.1, "test": 0.1},
    "maxTokens": 512,
    "deduplicate": true,
    "minQuality": 0.7
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
    "environment": "deepseek-coder",
    "batchSize": 4,
    "maxSteps": 1000,
    "learningRate": 1e-5,
    "warmupSteps": 100,
    "evalSteps": 50,
    "saveSteps": 100
  },
  "deploymentConfig": {
    "provider": "gcp|aws|azure|null",
    "region": "us-central1-a",
    "instanceType": "n1-standard-8",
    "gpuType": "nvidia-tesla-v100",
    "maxInstances": 1,
    "autoScaling": false
  },
  "huggingFaceConfig": {
    "organization": "elizaos",
    "datasetName": "eliza-training-data",
    "modelName": "eliza-fine-tuned",
    "private": false,
    "license": "apache-2.0"
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
        minQuality: 0.7, // Higher quality for training
        ...parsedConfig.datasetConfig,
      },
      rlaifConfig: {
        judgeModel: 'gpt-4',
        preferenceDescription:
          'helpful, harmless, and honest responses that demonstrate good coding practices and clear explanations',
        maxResponseVariants: 3,
        scoringStrategy: 'pairwise',
        rewardThreshold: 0.7,
        ...parsedConfig.rlaifConfig,
      },
      atroposConfig: {
        apiUrl: 'http://localhost:8000',
        environment: 'deepseek-coder',
        batchSize: 4,
        maxSteps: 1000,
        learningRate: 1e-5,
        warmupSteps: 100,
        evalSteps: 50,
        saveSteps: 100,
        ...parsedConfig.atroposConfig,
      },
    };

    // Add deployment config if cloud provider specified
    if (
      parsedConfig.deploymentConfig?.provider &&
      parsedConfig.deploymentConfig.provider !== 'null'
    ) {
      config.deploymentConfig = {
        provider: parsedConfig.deploymentConfig.provider,
        region: parsedConfig.deploymentConfig.region || 'us-central1-a',
        instanceType: parsedConfig.deploymentConfig.instanceType || 'n1-standard-8',
        gpuType: parsedConfig.deploymentConfig.gpuType || 'nvidia-tesla-v100',
        maxInstances: parsedConfig.deploymentConfig.maxInstances || 1,
        autoScaling: parsedConfig.deploymentConfig.autoScaling || false,
      };
    }

    // Add Hugging Face config if specified
    if (parsedConfig.huggingFaceConfig && runtime.getSetting('HUGGING_FACE_TOKEN')) {
      config.huggingFaceConfig = {
        organization: parsedConfig.huggingFaceConfig.organization || 'elizaos',
        datasetName: parsedConfig.huggingFaceConfig.datasetName || `eliza-training-${Date.now()}`,
        modelName: parsedConfig.huggingFaceConfig.modelName || `eliza-fine-tuned-${Date.now()}`,
        private: parsedConfig.huggingFaceConfig.private || false,
        license: parsedConfig.huggingFaceConfig.license || 'apache-2.0',
      };
    }

    // Override with any values from previous state
    if (state?.data?.config) {
      Object.assign(config, state.data.config);
    }

    elizaLogger.info('Parsed training configuration', { config });
    return config;
  } catch (error) {
    elizaLogger.error('Error parsing training configuration:', error);

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
        minQuality: 0.7,
      },
      rlaifConfig: {
        judgeModel: 'gpt-4',
        preferenceDescription:
          'helpful, harmless, and honest responses that demonstrate good coding practices and clear explanations',
        maxResponseVariants: 3,
        scoringStrategy: 'pairwise',
        rewardThreshold: 0.7,
      },
      atroposConfig: {
        apiUrl: 'http://localhost:8000',
        environment: 'deepseek-coder',
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
