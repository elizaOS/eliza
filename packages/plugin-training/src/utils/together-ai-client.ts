import { type IAgentRuntime, elizaLogger } from '@elizaos/core';
import {
  type TrainingConfig,
  type TogetherAIConfig,
  type TogetherAIJob,
  type TogetherAIModel,
  type JSONLDataset,
  type ModelDeploymentDecision,
} from '../types.js';
import { getTrainingConfig } from '../config/training-config.js';
import {
  ConfigurationError,
  MissingConfigurationError,
  NetworkError,
  APIError,
  RateLimitError,
  AuthenticationError,
  ExternalServiceError,
  ErrorHandler,
  withRetry,
  safely,
} from '../errors/training-errors.js';

/**
 * Together.ai API client for fine-tuning and model hosting
 */
export class TogetherAIClient {
  private apiKey: string;
  private config: ReturnType<typeof getTrainingConfig>;

  constructor(private runtime: IAgentRuntime) {
    this.config = getTrainingConfig(runtime);
    this.apiKey = this.runtime.getSetting('TOGETHER_AI_API_KEY') as string;
    if (!this.apiKey) {
      throw new MissingConfigurationError('TOGETHER_AI_API_KEY');
    }

    // Validate API configuration
    const apiConfig = this.config.getAPIConfig().togetherAi;
    ErrorHandler.validateURL(apiConfig.baseUrl, 'TOGETHER_AI_BASE_URL');
    ErrorHandler.validateNumericRange(apiConfig.timeout, 1000, 300000, 'TOGETHER_AI_TIMEOUT');
    ErrorHandler.validateNumericRange(apiConfig.maxRetries, 0, 10, 'TOGETHER_AI_MAX_RETRIES');
  }

  async initialize(): Promise<void> {
    await withRetry(
      async () => {
        elizaLogger.info('Initializing Together.ai client');

        // Test API connection with error handling
        await this.getModels();
        elizaLogger.info('Together.ai client initialized successfully');
      },
      'initialize_together_ai_client',
      { service: 'TogetherAI' },
      3
    );
  }

  /**
   * Get available models for fine-tuning
   */
  async getModels(): Promise<TogetherAIModel[]> {
    return await withRetry(
      async () => {
        const response = await this.makeRequest('GET', '/models');

        if (!response.data || !Array.isArray(response.data)) {
          throw new APIError(
            'TogetherAI',
            'Invalid response format - expected array of models',
            200,
            { responseType: typeof response.data }
          );
        }

        const fineTuningModels = response.data.filter((model: any) => model.fine_tuning_available);

        if (fineTuningModels.length === 0) {
          elizaLogger.warn('No fine-tuning capable models found');
        }

        return fineTuningModels;
      },
      'get_together_ai_models',
      { service: 'TogetherAI' },
      3
    );
  }

  /**
   * Upload dataset file to Together.ai
   */
  async uploadDataset(filePath: string, purpose = 'fine-tune'): Promise<string> {
    return await withRetry(
      async () => {
        elizaLogger.info(`Uploading dataset: ${filePath}`);

        // Read file with error handling
        const fileData = await safely(() => this.readFile(filePath), 'read_dataset_file', {
          filePath,
        });

        if (!fileData) {
          throw new ExternalServiceError(
            'TogetherAI',
            'upload',
            `Failed to read dataset file: ${filePath}`
          );
        }

        const formData = new FormData();
        formData.append('file', new Blob([fileData]), 'dataset.jsonl');
        formData.append('purpose', purpose);

        const response = await fetch(`${this.config.getAPIConfig().togetherAi.baseUrl}/files`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: formData,
        });

        if (response.status === 401) {
          throw new AuthenticationError('TogetherAI', 'Invalid or expired API key');
        }

        if (response.status === 429) {
          const resetTime = response.headers.get('x-ratelimit-reset');
          const resetTimestamp = resetTime ? parseInt(resetTime, 10) * 1000 : Date.now() + 60000;
          throw new RateLimitError('TogetherAI', resetTimestamp);
        }

        if (!response.ok) {
          throw new APIError(
            'TogetherAI',
            `Upload failed: ${response.statusText}`,
            response.status,
            { filePath, purpose }
          );
        }

        const result = (await response.json()) as { id?: string };

        if (!result.id) {
          throw new APIError('TogetherAI', 'Upload response missing file ID', response.status, {
            result,
          });
        }

        elizaLogger.info(`Dataset uploaded successfully: ${result.id}`);
        return result.id;
      },
      'upload_dataset_to_together_ai',
      { filePath, purpose },
      3
    );
  }

  /**
   * Validate dataset format
   */
  async validateDataset(filePath: string): Promise<boolean> {
    return (
      (await safely(
        async () => {
          // Read file with error handling
          const fileData = await this.readFile(filePath);

          const formData = new FormData();
          formData.append('file', new Blob([fileData]), 'dataset.jsonl');

          const response = await fetch(
            `${this.config.getAPIConfig().togetherAi.baseUrl}/files/check`,
            {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${this.apiKey}`,
              },
              body: formData,
            }
          );

          if (response.status === 401) {
            throw new AuthenticationError('TogetherAI', 'Invalid API key for validation');
          }

          if (!response.ok) {
            const errorData = await safely(
              () => response.json(),
              'parse_validation_error_response'
            );

            throw new APIError(
              'TogetherAI',
              `Dataset validation failed: ${response.statusText}`,
              response.status,
              { filePath, errorData }
            );
          }

          elizaLogger.info('Dataset validation passed');
          return true;
        },
        'validate_dataset',
        { filePath }
      )) || false
    ); // Return false if safely returns null (error occurred)
  }

  /**
   * Start fine-tuning job
   */
  async startFineTuning(config: TogetherAIConfig): Promise<TogetherAIJob> {
    elizaLogger.info(`Starting fine-tuning for model: ${config.baseModel}`);

    const jobConfig: any = {
      training_file: config.trainingFileId,
      model: config.baseModel,
      n_epochs: config.epochs || 3,
      learning_rate: config.learningRate || 1e-5,
      batch_size: config.batchSize || 1,
      suffix: config.suffix || `eliza-${Date.now()}`,
    };

    // Add validation file if provided
    if (config.validationFileId) {
      jobConfig.validation_file = config.validationFileId;
    }

    // Use LoRA by default for efficiency
    if (config.useLoRA !== false) {
      jobConfig.lora = true;
    }

    // Add training type specific configs
    if (config.trainingType) {
      jobConfig.training_type = config.trainingType;
    }

    const response = await this.makeRequest('POST', '/fine-tuning/jobs', jobConfig);

    const job: TogetherAIJob = {
      id: response.id,
      status: response.status,
      model: config.baseModel,
      training_file: config.trainingFileId || '',
      trainingFileId: config.trainingFileId,
      validation_file: config.validationFileId,
      created_at: response.created_at,
      hyperparameters: jobConfig,
      fineTunedModel: response.fine_tuned_model,
    };

    elizaLogger.info(`Fine-tuning job started: ${job.id}`);
    return job;
  }

  /**
   * Monitor fine-tuning job
   */
  async getJobStatus(jobId: string): Promise<TogetherAIJob> {
    const response = await this.makeRequest('GET', `/fine-tuning/jobs/${jobId}`);

    return {
      id: response.id,
      status: response.status,
      model: response.model,
      training_file: response.training_file || '',
      trainingFileId: response.training_file,
      validation_file: response.validation_file,
      created_at: response.created_at,
      finished_at: response.finished_at,
      fineTunedModel: response.fine_tuned_model,
      hyperparameters: response.hyperparameters,
      error: response.error,
    };
  }

  /**
   * List all fine-tuning jobs
   */
  async listJobs(): Promise<TogetherAIJob[]> {
    const response = await this.makeRequest('GET', '/fine-tuning/jobs');
    return response.data.map((job: any) => ({
      id: job.id,
      status: job.status,
      model: job.model,
      trainingFileId: job.training_file,
      validationFileId: job.validation_file,
      created_at: job.created_at,
      finishedAt: job.finished_at,
      fineTunedModel: job.fine_tuned_model,
      config: job.hyperparameters,
      error: job.error,
    }));
  }

  /**
   * Cancel fine-tuning job
   */
  async cancelJob(jobId: string): Promise<boolean> {
    try {
      await this.makeRequest('POST', `/fine-tuning/jobs/${jobId}/cancel`);
      elizaLogger.info(`Fine-tuning job cancelled: ${jobId}`);
      return true;
    } catch (error) {
      elizaLogger.error(`Failed to cancel job ${jobId}:`, error);
      return false;
    }
  }

  /**
   * Decide whether to host on Together.ai or use local inference
   */
  makeDeploymentDecision(
    modelSize: string,
    expectedUsage: number,
    budget: number
  ): ModelDeploymentDecision {
    const sizeGB = this.estimateModelSize(modelSize);

    // Small models (< 3GB) can run locally
    if (sizeGB < 3) {
      return {
        shouldDeploy: true,
        reasoning: 'Model size suitable for local inference with Ollama',
        confidence: 0.9,
        estimatedCost: 0,
        estimatedPerformanceGain: 0.8,
        risks: ['Local hardware limitations'],
        recommendations: ['Set up Ollama locally'],
        platform: 'local',
        implementation: 'ollama',
      };
    }

    // Medium models (3-10GB) - decision based on usage
    if (sizeGB < 10) {
      const monthlyTogetherCost = this.estimateTogetherCost(expectedUsage);
      const localInfrastructureCost = 200; // Estimated monthly cost for local GPU

      if (monthlyTogetherCost < localInfrastructureCost || expectedUsage < 100000) {
        return {
          shouldDeploy: true,
          reasoning: 'Cost-effective for current usage level',
          confidence: 0.8,
          estimatedCost: monthlyTogetherCost,
          estimatedPerformanceGain: 0.7,
          risks: ['API dependency', 'Network latency'],
          recommendations: ['Monitor usage costs', 'Set up billing alerts'],
          platform: 'together-ai',
          implementation: 'together-api',
        };
      } else {
        return {
          shouldDeploy: true,
          reasoning: 'High usage makes local infrastructure more cost-effective',
          confidence: 0.9,
          estimatedCost: localInfrastructureCost,
          estimatedPerformanceGain: 0.9,
          risks: ['Hardware maintenance', 'Initial setup costs'],
          recommendations: ['Invest in local GPU infrastructure', 'Set up monitoring'],
          platform: 'local',
          implementation: 'local-gpu',
        };
      }
    }

    // Large models (>10GB) - usually Together.ai hosted
    return {
      shouldDeploy: true,
      reasoning: 'Large model requires cloud infrastructure',
      confidence: 0.95,
      estimatedCost: this.estimateTogetherCost(expectedUsage),
      estimatedPerformanceGain: 0.85,
      risks: ['High compute costs', 'API rate limits'],
      recommendations: ['Use Together.ai hosted inference', 'Optimize prompt sizes'],
      platform: 'together-ai',
      implementation: 'together-api',
    };
  }

  /**
   * Test inference with fine-tuned model
   */
  async testInference(modelName: string, prompt: string, maxTokens = 100): Promise<string> {
    const response = await this.makeRequest('POST', '/completions', {
      model: modelName,
      prompt,
      max_tokens: maxTokens,
      temperature: 0.7,
    });

    return response.choices[0].text;
  }

  /**
   * Get model pricing information
   */
  async getModelPricing(modelName: string): Promise<{
    inputPrice: number;
    outputPrice: number;
    currency: string;
  }> {
    // Together.ai pricing (per 1M tokens)
    const pricingMap: Record<string, { inputPrice: number; outputPrice: number }> = {
      'deepseek-ai/DeepSeek-R1': { inputPrice: 3.0, outputPrice: 7.0 },
      'deepseek-ai/DeepSeek-R1-Distill-Llama-70B': { inputPrice: 2.0, outputPrice: 2.0 },
      'deepseek-ai/DeepSeek-R1-Distill-Qwen-14B': { inputPrice: 1.0, outputPrice: 1.0 },
      'deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B': { inputPrice: 0.2, outputPrice: 0.2 },
    };

    return {
      ...(pricingMap[modelName] || { inputPrice: 1.0, outputPrice: 1.0 }),
      currency: 'USD',
    };
  }

  private async makeRequest(method: string, endpoint: string, data?: any): Promise<any> {
    const url = `${this.config.getAPIConfig().togetherAi.baseUrl}${endpoint}`;

    const options: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
    };

    if (data) {
      options.body = JSON.stringify(data);
    }

    const response = await fetch(url, options);

    if (!response.ok) {
      const error = (await response.json()) as { error?: { message?: string } };
      throw new Error(`Together.ai API error: ${error.error?.message || response.statusText}`);
    }

    return response.json();
  }

  private async readFile(filePath: string): Promise<string> {
    const fs = await import('fs/promises');
    return fs.readFile(filePath, 'utf-8');
  }

  private estimateModelSize(modelName: string): number {
    // Rough size estimates in GB
    const sizeMap: Record<string, number> = {
      '1.5b': 3,
      '1.5B': 3,
      '7b': 14,
      '7B': 14,
      '14b': 28,
      '14B': 28,
      '70b': 140,
      '70B': 140,
    };

    for (const [key, size] of Object.entries(sizeMap)) {
      if (modelName.includes(key)) {
        return size;
      }
    }

    return 10; // Default assumption
  }

  private estimateTogetherCost(tokensPerMonth: number): number {
    // Estimate based on average pricing of $2 per 1M tokens
    return (tokensPerMonth / 1000000) * 2;
  }
}
