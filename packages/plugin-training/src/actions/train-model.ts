/**
 * Train Model Action - Together.ai Integration for Model Training
 *
 * Uploads training data to Together.ai and initiates fine-tuning of DeepSeek-70B
 * for ElizaOS code generation and reasoning capabilities.
 */

import type {
  Action,
  ActionResult,
  IAgentRuntime,
  Memory,
  State,
  HandlerCallback,
  UUID,
} from '@elizaos/core';
import { elizaLogger } from '@elizaos/core';
import * as fs from 'fs/promises';
import * as path from 'path';
import FormData from 'form-data';
import fetch from 'node-fetch';
import { getTrainingConfig } from '../config/training-config.js';

export const trainModelAction: Action = {
  name: 'TRAIN_MODEL',
  similes: ['FINE_TUNE_MODEL', 'UPLOAD_TRAINING_DATA', 'START_TRAINING'],
  description:
    'Upload training data to Together.ai and start fine-tuning DeepSeek-70B model for ElizaOS code generation. Can be chained with GENERATE_TRAINING_DATA to create datasets or MONITOR_TRAINING to track progress.',

  validate: async (runtime: IAgentRuntime, message: Memory) => {
    const text = message.content.text?.toLowerCase() || '';

    // Exclude negative contexts
    if (
      text.includes('disable') ||
      text.includes('stop') ||
      text.includes('cancel') ||
      text.includes("don't") ||
      text.includes('no')
    ) {
      return false;
    }

    // Check for training-related terms
    const hasTrainingAction =
      text.includes('train') || text.includes('fine-tune') || text.includes('upload');
    const hasModelReference =
      text.includes('model') ||
      text.includes('together') ||
      text.includes('deepseek') ||
      text.includes('llama');

    // Check for data context
    const hasDataContext =
      text.includes('training') || text.includes('dataset') || text.includes('data');

    // Special cases:
    // 1. "upload training data" implies model training even without explicit model mention
    // 2. "train the model" implies data context even without explicit data mention
    const isUploadTrainingData = text.includes('upload') && hasDataContext;
    const isTrainModel = hasTrainingAction && hasModelReference;

    return (
      (hasTrainingAction && hasModelReference && hasDataContext) ||
      isUploadTrainingData ||
      isTrainModel
    );
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    try {
      elizaLogger.info('🚂 Starting model training process...');

      // Check for Together.ai API key
      const apiKey = runtime.getSetting('TOGETHER_API_KEY');
      if (!apiKey) {
        await callback?.({
          text: '❌ Together.ai API key not found. Please set TOGETHER_API_KEY in your environment.\n\nTo get an API key:\n1. Visit https://api.together.xyz/\n2. Sign up or log in\n3. Generate an API key\n4. Set TOGETHER_API_KEY in your .env file',
          thought: 'Missing Together.ai API key required for model training',
          actions: ['TRAIN_MODEL'],
        });
        return {
          text: 'Missing Together.ai API key',
          data: {
            actionName: 'TRAIN_MODEL',
            error: 'missing_api_key',
          },
          values: {
            success: false,
            error: 'missing_api_key',
          },
        };
      }

      // Extract configuration from message
      const config = extractTrainingConfig(message);

      // Validate training file exists first before starting
      const trainingFilePath = path.resolve(config.trainingFile);
      try {
        await fs.access(trainingFilePath);
      } catch (error) {
        await callback?.({
          text: `❌ Training file not found: ${trainingFilePath}\n\nPlease run the training data generation first using the GENERATE_TRAINING_DATA action.`,
          thought: 'Training file not found, user needs to generate training data first',
          actions: ['TRAIN_MODEL'],
        });
        return {
          text: 'Training file not found',
          data: {
            actionName: 'TRAIN_MODEL',
            error: 'file_not_found',
            trainingFile: trainingFilePath,
          },
          values: {
            success: false,
            error: 'file_not_found',
          },
        };
      }

      // Validate JSONL format before proceeding
      const validationResult = await validateTrainingData(trainingFilePath);
      if (!validationResult.valid) {
        await callback?.({
          text: `❌ Training data validation failed:\n${validationResult.errors.join('\n')}\n\nPlease regenerate the training data with proper formatting.`,
          thought: 'Training data validation failed, cannot proceed with upload',
          actions: ['TRAIN_MODEL'],
        });
        return {
          text: 'Training data validation failed',
          data: {
            actionName: 'TRAIN_MODEL',
            error: 'validation_failed',
            validationErrors: validationResult.errors,
          },
          values: {
            success: false,
            error: 'validation_failed',
          },
        };
      }

      // File exists and is valid, now we can proceed with training
      await callback?.({
        text: `🚂 Starting Together.ai model training...\n\nConfiguration:\n- Model: ${config.baseModel}\n- Training file: ${config.trainingFile}\n- Model suffix: ${config.suffix}\n- Learning rate: ${config.learningRate}\n- Epochs: ${config.epochs}\n\nSteps:\n1. Validate training data format\n2. Upload dataset to Together.ai\n3. Start fine-tuning job\n4. Monitor training progress\n\nThis may take several hours to complete...`,
        thought: 'Initiating Together.ai model training pipeline',
        actions: ['TRAIN_MODEL'],
      });

      // Show validation progress for successful files
      await callback?.({
        text: '🔍 Validating training data format...',
        thought: 'Validating JSONL format and data quality',
      });

      await callback?.({
        text: `✅ Training data validation passed!\n- ${validationResult.exampleCount} training examples\n- Average tokens: ${validationResult.averageTokens}\n- Total size: ${validationResult.totalSize}`,
        thought: 'Training data validation successful, proceeding with upload',
      });

      // Upload file to Together.ai
      await callback?.({
        text: '📤 Uploading training data to Together.ai...',
        thought: 'Uploading JSONL file to Together.ai servers',
      });

      const fileUploadResult = await uploadTrainingFile(apiKey, trainingFilePath);

      await callback?.({
        text: `✅ Training data uploaded successfully!\n- File ID: ${(fileUploadResult as any).id}\n- Purpose: ${(fileUploadResult as any).purpose}\n- Size: ${Math.round((fileUploadResult as any).bytes / 1024)}KB`,
        thought: 'Training file uploaded, ready to start fine-tuning job',
      });

      // Start fine-tuning job
      await callback?.({
        text: '🚀 Starting fine-tuning job...',
        thought: 'Creating fine-tuning job with uploaded dataset',
      });

      const fineTuningJob = await createFineTuningJob(apiKey, {
        training_file: (fileUploadResult as any).id,
        model: config.baseModel,
        suffix: config.suffix,
        hyperparameters: {
          learning_rate: config.learningRate,
          n_epochs: config.epochs,
          batch_size: config.batchSize,
        },
      });

      await callback?.({
        text: `🎯 Fine-tuning job created successfully!\n\n**Job Details:**\n- Job ID: ${(fineTuningJob as any).id}\n- Model: ${(fineTuningJob as any).model}\n- Status: ${(fineTuningJob as any).status}\n- Created: ${new Date((fineTuningJob as any).created_at * 1000).toLocaleString()}\n\n**Training Configuration:**\n- Learning Rate: ${config.learningRate}\n- Epochs: ${config.epochs}\n- Batch Size: ${config.batchSize}\n\n**Next Steps:**\n1. Monitor training progress\n2. Wait for completion (typically 2-6 hours)\n3. Test the fine-tuned model\n4. Configure auto-coder to use the new model\n\n💡 You can check progress with: "Check training status for job ${(fineTuningJob as any).id}"`,
        thought: 'Fine-tuning job started successfully, providing job details and next steps',
        actions: ['TRAIN_MODEL'],
      });

      // Store job info for monitoring
      await storeTrainingJobInfo(runtime, fineTuningJob, config);

      return {
        text: `Fine-tuning job ${(fineTuningJob as any).id} started successfully`,
        data: {
          actionName: 'TRAIN_MODEL',
          jobId: (fineTuningJob as any).id,
          fileId: (fileUploadResult as any).id,
          status: (fineTuningJob as any).status,
          config,
          fineTuningJob,
          fileUploadResult,
        },
        values: {
          success: true,
          jobId: (fineTuningJob as any).id,
          fileId: (fileUploadResult as any).id,
          status: (fineTuningJob as any).status,
          modelName: config.baseModel,
          suffix: config.suffix,
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      elizaLogger.error('❌ Model training failed:', error);

      await callback?.({
        text: `❌ Model training failed: ${errorMessage}\n\nCommon issues:\n- Invalid API key\n- Incorrect file format\n- Network connectivity\n- Together.ai service issues\n\nPlease check your configuration and try again.`,
        thought: `Model training failed: ${errorMessage}`,
        actions: ['TRAIN_MODEL'],
      });

      return {
        text: `Model training failed: ${errorMessage}`,
        data: {
          actionName: 'TRAIN_MODEL',
          error: errorMessage,
          stack: error instanceof Error ? error.stack : undefined,
        },
        values: {
          success: false,
          error: errorMessage,
        },
      };
    }
  },

  examples: [
    // Multi-action: Generate data then train
    [
      {
        name: 'User',
        content: {
          text: 'Generate training data from ElizaOS and train a model on Together.ai',
        },
      },
      {
        name: 'Assistant',
        content: {
          text: "I'll generate training data from ElizaOS and then train a model on Together.ai.",
          thought: 'User wants data generation followed by training',
          actions: ['GENERATE_TRAINING_DATA', 'TRAIN_MODEL'],
        },
      },
    ],
    // Multi-action: Train then monitor
    [
      {
        name: 'User',
        content: {
          text: 'Train the model and monitor its progress',
        },
      },
      {
        name: 'Assistant',
        content: {
          text: "I'll start training the model and monitor its progress.",
          thought: 'User wants training followed by monitoring',
          actions: ['TRAIN_MODEL', 'MONITOR_TRAINING'],
        },
      },
    ],
    // Multi-action: Extract data, train, and configure
    [
      {
        name: 'User',
        content: {
          text: 'Extract training data, train the model, and configure auto-coder when done',
        },
      },
      {
        name: 'Assistant',
        content: {
          text: "I'll extract training data, train the model, and configure auto-coder when complete.",
          thought: 'User wants complete training pipeline',
          actions: ['EXTRACT_TRAINING_DATA', 'TRAIN_MODEL', 'CONFIGURE_AUTOCODER'],
        },
      },
    ],
    [
      {
        name: 'User',
        content: {
          text: 'Train a model using the generated training data on Together.ai',
        },
      },
      {
        name: 'Assistant',
        content: {
          text: '🚂 Starting Together.ai model training...',
          thought: 'User wants to start model training with generated data',
          actions: ['TRAIN_MODEL'],
        },
      },
    ],
    [
      {
        name: 'User',
        content: {
          text: 'Fine-tune DeepSeek-70B on my ElizaOS training dataset with learning rate 0.0001',
        },
      },
      {
        name: 'Assistant',
        content: {
          text: '🚂 Starting Together.ai model training with custom learning rate...',
          thought: 'User specifies custom learning rate for fine-tuning',
          actions: ['TRAIN_MODEL'],
        },
      },
    ],
  ],
};

/**
 * Extract training configuration from message
 */
function extractTrainingConfig(message: Memory) {
  const text = message.content.text || '';

  // Get configuration-based defaults
  const config = getTrainingConfig();
  const trainingDefaults = config.getModelTrainingConfig();

  return {
    baseModel: extractValue(text, /model[:\s]+([^\s]+)/i, trainingDefaults.defaultBaseModel),
    trainingFile: extractValue(
      text,
      /(?:file|dataset)[:\s]+([^\s]+)/i,
      trainingDefaults.defaultTrainingFile
    ),
    suffix: extractValue(text, /suffix[:\s]+([^\s]+)/i, trainingDefaults.defaultModelSuffix),
    learningRate: parseFloat(
      extractValue(
        text,
        /learning[_\s]?rate[:\s]+([\d.e-]+)/i,
        trainingDefaults.defaultLearningRate.toString()
      )
    ),
    epochs: parseInt(
      extractValue(text, /epochs?[:\s]+(\d+)/i, trainingDefaults.defaultEpochs.toString()),
      10
    ),
    batchSize: parseInt(
      extractValue(
        text,
        /batch[_\s]?size[:\s]+(\d+)/i,
        trainingDefaults.defaultBatchSize.toString()
      ),
      10
    ),
  };
}

/**
 * Extract value from text using regex with fallback
 */
function extractValue(text: string, regex: RegExp, defaultValue: string): string {
  const match = text.match(regex);
  return match ? match[1] : defaultValue;
}

/**
 * Validate training data JSONL format
 */
async function validateTrainingData(filePath: string) {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.trim().split('\n');

    let totalTokens = 0;
    const errors: string[] = [];

    for (let i = 0; i < Math.min(lines.length, 10); i++) {
      // Check first 10 lines
      try {
        const data = JSON.parse(lines[i]);

        if (!data.messages || !Array.isArray(data.messages)) {
          errors.push(`Line ${i + 1}: Missing or invalid 'messages' array`);
        } else {
          const messages = data.messages;
          if (
            !messages.some((m: any) => m.role === 'user') ||
            !messages.some((m: any) => m.role === 'assistant')
          ) {
            errors.push(`Line ${i + 1}: Missing user or assistant message`);
          }

          // Estimate tokens
          const textContent = messages.map((m: any) => m.content).join(' ');
          totalTokens += Math.ceil(textContent.length / 4);
        }
      } catch (_parseError) {
        errors.push(`Line ${i + 1}: Invalid JSON format`);
      }
    }

    const stats = await fs.stat(filePath);

    return {
      valid: errors.length === 0,
      errors,
      exampleCount: lines.length,
      averageTokens: Math.round(totalTokens / Math.min(lines.length, 10)),
      totalSize: `${Math.round(stats.size / 1024)}KB`,
    };
  } catch (error) {
    return {
      valid: false,
      errors: [`Failed to read file: ${error instanceof Error ? error.message : String(error)}`],
      exampleCount: 0,
      averageTokens: 0,
      totalSize: '0KB',
    };
  }
}

/**
 * Upload training file to Together.ai
 */
async function uploadTrainingFile(apiKey: string, filePath: string) {
  const fileContent = await fs.readFile(filePath);
  const fileName = path.basename(filePath);

  // Create form data using Node.js compatible FormData
  const formData = new FormData();
  formData.append('file', fileContent, {
    filename: fileName,
    contentType: 'application/jsonl',
  });
  formData.append('purpose', 'fine-tune');

  const response = await fetch('https://api.together.xyz/v1/files', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...formData.getHeaders(),
    },
    body: formData,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`File upload failed: ${response.status} ${error}`);
  }

  return await response.json();
}

/**
 * Create fine-tuning job
 */
async function createFineTuningJob(apiKey: string, config: any) {
  const response = await fetch('https://api.together.xyz/v1/fine-tuning/jobs', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(config),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Fine-tuning job creation failed: ${response.status} ${error}`);
  }

  return await response.json();
}

/**
 * Store training job info for monitoring
 */
async function storeTrainingJobInfo(runtime: IAgentRuntime, job: any, config: any) {
  try {
    // Store in memory for later retrieval
    await runtime.createMemory(
      {
        content: {
          text: `Training job ${job.id} started with model ${job.model}`,
          metadata: {
            type: 'training_job',
            jobId: job.id,
            model: job.model,
            status: job.status,
            config,
            createdAt: job.created_at,
          },
        },
        entityId: runtime.agentId,
        roomId: `training-jobs-${Date.now()}` as UUID,
      },
      'facts'
    );
  } catch (error) {
    elizaLogger.warn('Failed to store training job info:', error);
  }
}

elizaLogger.info('✅ Train model action loaded');
