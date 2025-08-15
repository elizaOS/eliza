/**
 * Central Configuration System for Plugin Training
 *
 * This replaces hard-coded values throughout the codebase with configurable settings
 * that can be set via environment variables, runtime settings, or configuration files.
 */

import type { IAgentRuntime } from '@elizaos/core';
import { elizaLogger } from '@elizaos/core';

export interface APIConfiguration {
  // Together.ai Configuration
  togetherAi: {
    baseUrl: string;
    timeout: number;
    maxRetries: number;
    defaultMaxTokens: number;
    rateLimit: {
      requestsPerMinute: number;
      delayBetweenRequests: number;
    };
  };

  // Anthropic Configuration
  anthropic: {
    baseUrl: string;
    proxyPort: number;
    requestSizeLimit: string;
    contextWindowSize: number;
    tokenEstimationRatio: number;
  };

  // GitHub Configuration
  github: {
    apiUrl: string;
    defaultRepository: string;
    timeout: number;
    rateLimitDelay: {
      withToken: number;
      withoutToken: number;
    };
    retryConfig: {
      maxRetries: number;
      baseDelay: number;
    };
  };

  // HuggingFace Configuration
  huggingFace: {
    baseUrl: string;
    timeout: number;
  };
}

export interface ModelConfiguration {
  // Model Pricing (per 1M tokens)
  pricing: {
    [modelName: string]: {
      inputPrice: number;
      outputPrice: number;
    };
  };

  // Model Size Estimates (in GB)
  sizeEstimates: {
    [sizeIndicator: string]: number;
  };

  // Default Training Parameters
  training: {
    epochs: number;
    learningRate: number;
    batchSize: number;
    maxSequenceLength: number;
  };

  // Size Thresholds for Model Recommendations
  sizeThresholds: {
    localInference: number; // GB
    mediumModel: number; // GB
    largeModel: number; // GB
  };

  // Default Model Names
  defaults: {
    shouldRespond: string;
    planning: string;
    coding: string;
    reasoning: string;
  };
}

export interface DataConfiguration {
  // File Paths and Directories
  paths: {
    trainingRecording: string;
    datasets: string;
    models: string;
    logs: string;
    temp: string;
  };

  // Data Processing
  processing: {
    splitRatio: {
      train: number;
      validation: number;
      test: number;
    };
    qualityThresholds: {
      high: number;
      medium: number;
      low: number;
    };
    maxDataPoints: number;
    minDataPoints: number;
    minQualityScore: number;
  };

  // File Extensions and Formats
  formats: {
    dataset: string;
    model: string;
    log: string;
  };
}

export interface AutomationConfiguration {
  // Data Collection
  dataCollection: {
    saveInterval: number; // milliseconds
    maxDataPoints: number;
    minQualityScore: number;
    collectDuration: number; // milliseconds
  };

  // Training Automation
  training: {
    statusCheckInterval: number; // milliseconds
    deploymentCheckInterval: number; // milliseconds
    localInfrastructureCost: number; // USD per month
    autoDeployment: {
      enabled: boolean;
      budgetLimit: number; // USD
      expectedUsage: number; // requests per month
    };
  };

  // Cost Management
  cost: {
    budgetAlert: number; // USD
    autoShutdownThreshold: number; // USD
    costEstimationMultiplier: number;
  };
}

export interface TrainingPluginConfiguration {
  api: APIConfiguration;
  models: ModelConfiguration;
  data: DataConfiguration;
  automation: AutomationConfiguration;
}

/**
 * Configuration Manager for the Training Plugin
 */
export class TrainingConfigurationManager {
  private config: TrainingPluginConfiguration;
  private runtime?: IAgentRuntime;

  constructor(runtime?: IAgentRuntime) {
    this.runtime = runtime;
    this.config = this.loadConfiguration();
  }

  /**
   * Load configuration from environment variables and runtime settings
   */
  private loadConfiguration(): TrainingPluginConfiguration {
    return {
      api: this.loadAPIConfiguration(),
      models: this.loadModelConfiguration(),
      data: this.loadDataConfiguration(),
      automation: this.loadAutomationConfiguration(),
    };
  }

  private loadAPIConfiguration(): APIConfiguration {
    return {
      togetherAi: {
        baseUrl: this.getSetting('TOGETHER_AI_BASE_URL', 'https://api.together.xyz/v1'),
        timeout: parseInt(this.getSetting('TOGETHER_AI_TIMEOUT', '30000'), 10),
        maxRetries: parseInt(this.getSetting('TOGETHER_AI_MAX_RETRIES', '3'), 10),
        defaultMaxTokens: parseInt(this.getSetting('TOGETHER_AI_DEFAULT_MAX_TOKENS', '100'), 10),
        rateLimit: {
          requestsPerMinute: parseInt(this.getSetting('TOGETHER_AI_RATE_LIMIT', '60'), 10),
          delayBetweenRequests: parseInt(this.getSetting('TOGETHER_AI_DELAY', '1000'), 10),
        },
      },
      anthropic: {
        baseUrl: this.getSetting('ANTHROPIC_BASE_URL', 'https://api.anthropic.com'),
        proxyPort: parseInt(this.getSetting('ANTHROPIC_PROXY_PORT', '8001'), 10),
        requestSizeLimit: this.getSetting('ANTHROPIC_REQUEST_SIZE_LIMIT', '10mb'),
        contextWindowSize: parseInt(this.getSetting('ANTHROPIC_CONTEXT_WINDOW', '3'), 10),
        tokenEstimationRatio: parseFloat(this.getSetting('ANTHROPIC_TOKEN_RATIO', '4')),
      },
      github: {
        apiUrl: this.getSetting('GITHUB_API_URL', 'https://api.github.com'),
        defaultRepository: this.getSetting(
          'GITHUB_DEFAULT_REPO',
          'https://github.com/elizaOS/eliza.git'
        ),
        timeout: parseInt(this.getSetting('GITHUB_TIMEOUT', '120000'), 10),
        rateLimitDelay: {
          withToken: parseInt(this.getSetting('GITHUB_DELAY_WITH_TOKEN', '50'), 10),
          withoutToken: parseInt(this.getSetting('GITHUB_DELAY_WITHOUT_TOKEN', '1000'), 10),
        },
        retryConfig: {
          maxRetries: parseInt(this.getSetting('GITHUB_MAX_RETRIES', '3'), 10),
          baseDelay: parseInt(this.getSetting('GITHUB_RETRY_DELAY', '2000'), 10),
        },
      },
      huggingFace: {
        baseUrl: this.getSetting('HUGGINGFACE_BASE_URL', 'https://huggingface.co'),
        timeout: parseInt(this.getSetting('HUGGINGFACE_TIMEOUT', '30000'), 10),
      },
    };
  }

  private loadModelConfiguration(): ModelConfiguration {
    // Load model pricing from environment or use defaults
    const pricingOverrides = this.getSetting('MODEL_PRICING_OVERRIDES', '');
    let pricing: { [key: string]: { inputPrice: number; outputPrice: number } } = {
      'deepseek-ai/DeepSeek-R1': {
        inputPrice: parseFloat(this.getSetting('DEEPSEEK_R1_INPUT_PRICE', '3.0')),
        outputPrice: parseFloat(this.getSetting('DEEPSEEK_R1_OUTPUT_PRICE', '7.0')),
      },
      'deepseek-ai/DeepSeek-R1-Distill-Llama-70B': {
        inputPrice: parseFloat(this.getSetting('DEEPSEEK_LLAMA_70B_INPUT_PRICE', '2.0')),
        outputPrice: parseFloat(this.getSetting('DEEPSEEK_LLAMA_70B_OUTPUT_PRICE', '2.0')),
      },
      'deepseek-ai/DeepSeek-R1-Distill-Qwen-14B': {
        inputPrice: parseFloat(this.getSetting('DEEPSEEK_QWEN_14B_INPUT_PRICE', '1.0')),
        outputPrice: parseFloat(this.getSetting('DEEPSEEK_QWEN_14B_OUTPUT_PRICE', '1.0')),
      },
      'deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B': {
        inputPrice: parseFloat(this.getSetting('DEEPSEEK_QWEN_1_5B_INPUT_PRICE', '0.2')),
        outputPrice: parseFloat(this.getSetting('DEEPSEEK_QWEN_1_5B_OUTPUT_PRICE', '0.2')),
      },
    };

    // Allow overriding pricing via JSON string
    if (pricingOverrides && pricingOverrides.trim()) {
      try {
        const overrides = JSON.parse(pricingOverrides);
        pricing = { ...pricing, ...overrides };
      } catch (error) {
        elizaLogger.warn('Invalid MODEL_PRICING_OVERRIDES JSON, using defaults');
      }
    }

    return {
      pricing,
      sizeEstimates: {
        '1.5b': parseFloat(this.getSetting('MODEL_SIZE_1_5B', '3')),
        '1.5B': parseFloat(this.getSetting('MODEL_SIZE_1_5B', '3')),
        '7b': parseFloat(this.getSetting('MODEL_SIZE_7B', '14')),
        '7B': parseFloat(this.getSetting('MODEL_SIZE_7B', '14')),
        '14b': parseFloat(this.getSetting('MODEL_SIZE_14B', '28')),
        '14B': parseFloat(this.getSetting('MODEL_SIZE_14B', '28')),
        '70b': parseFloat(this.getSetting('MODEL_SIZE_70B', '140')),
        '70B': parseFloat(this.getSetting('MODEL_SIZE_70B', '140')),
      },
      training: {
        epochs: parseInt(this.getSetting('MODEL_TRAINING_EPOCHS', '3'), 10),
        learningRate: parseFloat(this.getSetting('MODEL_TRAINING_LEARNING_RATE', '1e-5')),
        batchSize: parseInt(this.getSetting('MODEL_TRAINING_BATCH_SIZE', '1'), 10),
        maxSequenceLength: parseInt(
          this.getSetting('MODEL_TRAINING_MAX_SEQUENCE_LENGTH', '2048'),
          10
        ),
      },
      sizeThresholds: {
        localInference: parseFloat(this.getSetting('MODEL_SIZE_THRESHOLD_LOCAL', '3')),
        mediumModel: parseFloat(this.getSetting('MODEL_SIZE_THRESHOLD_MEDIUM', '10')),
        largeModel: parseFloat(this.getSetting('MODEL_SIZE_THRESHOLD_LARGE', '50')),
      },
      defaults: {
        shouldRespond: this.getSetting(
          'DEFAULT_SHOULD_RESPOND_MODEL',
          'deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B'
        ),
        planning: this.getSetting(
          'DEFAULT_PLANNING_MODEL',
          'deepseek-ai/DeepSeek-R1-Distill-Qwen-14B'
        ),
        coding: this.getSetting(
          'DEFAULT_CODING_MODEL',
          'deepseek-ai/DeepSeek-R1-Distill-Llama-70B'
        ),
        reasoning: this.getSetting('DEFAULT_REASONING_MODEL', 'deepseek-ai/DeepSeek-R1'),
      },
    };
  }

  private loadDataConfiguration(): DataConfiguration {
    return {
      paths: {
        trainingRecording: this.getSetting('TRAINING_RECORDING_PATH', './training_recording'),
        datasets: this.getSetting('DATASETS_PATH', './datasets'),
        models: this.getSetting('MODELS_PATH', './models'),
        logs: this.getSetting('LOGS_PATH', './logs'),
        temp: this.getSetting('TEMP_PATH', './temp'),
      },
      processing: {
        splitRatio: {
          train: parseFloat(this.getSetting('DATA_SPLIT_TRAIN', '0.8')),
          validation: parseFloat(this.getSetting('DATA_SPLIT_VALIDATION', '0.1')),
          test: parseFloat(this.getSetting('DATA_SPLIT_TEST', '0.1')),
        },
        qualityThresholds: {
          high: parseFloat(this.getSetting('QUALITY_THRESHOLD_HIGH', '0.8')),
          medium: parseFloat(this.getSetting('QUALITY_THRESHOLD_MEDIUM', '0.5')),
          low: parseFloat(this.getSetting('QUALITY_THRESHOLD_LOW', '0.0')),
        },
        maxDataPoints: parseInt(this.getSetting('MAX_DATA_POINTS', '10000'), 10),
        minDataPoints: parseInt(this.getSetting('MIN_DATA_POINTS', '100'), 10),
        minQualityScore: parseFloat(this.getSetting('MIN_QUALITY_SCORE', '0.7')),
      },
      formats: {
        dataset: this.getSetting('DATASET_FORMAT', 'jsonl'),
        model: this.getSetting('MODEL_FORMAT', 'safetensors'),
        log: this.getSetting('LOG_FORMAT', 'json'),
      },
    };
  }

  private loadAutomationConfiguration(): AutomationConfiguration {
    return {
      dataCollection: {
        saveInterval: parseInt(this.getSetting('DATA_COLLECTION_SAVE_INTERVAL', '300000'), 10), // 5 minutes
        maxDataPoints: parseInt(this.getSetting('DATA_COLLECTION_MAX_POINTS', '10000'), 10),
        minQualityScore: parseFloat(this.getSetting('DATA_COLLECTION_MIN_QUALITY', '0.7')),
        collectDuration: parseInt(this.getSetting('DATA_COLLECTION_DURATION', '3600000'), 10), // 1 hour
      },
      training: {
        statusCheckInterval: parseInt(
          this.getSetting('TRAINING_STATUS_CHECK_INTERVAL', '60000'),
          10
        ), // 1 minute
        deploymentCheckInterval: parseInt(
          this.getSetting('TRAINING_DEPLOYMENT_CHECK_INTERVAL', '30000'),
          10
        ), // 30 seconds
        localInfrastructureCost: parseFloat(this.getSetting('LOCAL_INFRASTRUCTURE_COST', '200')),
        autoDeployment: {
          enabled: this.getSetting('AUTO_DEPLOYMENT_ENABLED', 'false') === 'true',
          budgetLimit: parseFloat(this.getSetting('AUTO_DEPLOYMENT_BUDGET_LIMIT', '100')),
          expectedUsage: parseInt(this.getSetting('AUTO_DEPLOYMENT_EXPECTED_USAGE', '1000'), 10),
        },
      },
      cost: {
        budgetAlert: parseFloat(this.getSetting('COST_BUDGET_ALERT', '50')),
        autoShutdownThreshold: parseFloat(this.getSetting('COST_AUTO_SHUTDOWN_THRESHOLD', '100')),
        costEstimationMultiplier: parseFloat(this.getSetting('COST_ESTIMATION_MULTIPLIER', '2')),
      },
    };
  }

  /**
   * Get setting from runtime or environment variable
   */
  private getSetting(key: string, defaultValue?: string): string {
    // Try runtime settings first
    if (this.runtime) {
      const runtimeValue = this.runtime.getSetting?.(key);
      if (runtimeValue) {
        return String(runtimeValue);
      }
    }

    // Fall back to environment variable
    const envValue = process.env[key];
    if (envValue !== undefined) {
      return envValue;
    }

    // Use default value
    if (defaultValue !== undefined) {
      return defaultValue;
    }

    // No default provided
    throw new Error(`Configuration value not found: ${key}`);
  }

  /**
   * Get the complete configuration
   */
  public getConfiguration(): TrainingPluginConfiguration {
    return this.config;
  }

  /**
   * Get API configuration
   */
  public getAPIConfig(): APIConfiguration {
    return this.config.api;
  }

  /**
   * Get model configuration
   */
  public getModelConfig(): ModelConfiguration {
    return this.config.models;
  }

  /**
   * Get data configuration
   */
  public getDataConfig(): DataConfiguration {
    return this.config.data;
  }

  /**
   * Get automation configuration
   */
  public getAutomationConfig(): AutomationConfiguration {
    return this.config.automation;
  }

  /**
   * Get model training configuration with defaults
   */
  public getModelTrainingConfig() {
    return {
      defaultBaseModel: this.getSetting(
        'MODEL_TRAINING_DEFAULT_BASE_MODEL',
        'deepseek-ai/DeepSeek-R1-Distill-Llama-70B'
      ),
      defaultTrainingFile: this.getSetting(
        'MODEL_TRAINING_DEFAULT_FILE',
        './training-output/together-ai-training.jsonl'
      ),
      defaultModelSuffix: this.getSetting('MODEL_TRAINING_DEFAULT_SUFFIX', 'eliza-trained'),
      defaultLearningRate: parseFloat(
        this.getSetting('MODEL_TRAINING_DEFAULT_LEARNING_RATE', '1e-5')
      ),
      defaultEpochs: parseInt(this.getSetting('MODEL_TRAINING_DEFAULT_EPOCHS', '3'), 10),
      defaultBatchSize: parseInt(this.getSetting('MODEL_TRAINING_DEFAULT_BATCH_SIZE', '1'), 10),
      defaultMaxTokens: parseInt(this.getSetting('MODEL_TRAINING_DEFAULT_MAX_TOKENS', '2048'), 10),
      defaultWarmupSteps: parseInt(
        this.getSetting('MODEL_TRAINING_DEFAULT_WARMUP_STEPS', '100'),
        10
      ),
      defaultEvalSteps: parseInt(this.getSetting('MODEL_TRAINING_DEFAULT_EVAL_STEPS', '50'), 10),
      defaultSaveSteps: parseInt(this.getSetting('MODEL_TRAINING_DEFAULT_SAVE_STEPS', '100'), 10),
    };
  }

  /**
   * Update configuration at runtime
   */
  public updateConfiguration(updates: Partial<TrainingPluginConfiguration>): void {
    this.config = {
      ...this.config,
      ...updates,
    };
    elizaLogger.info('Training plugin configuration updated');
  }

  /**
   * Validate configuration values
   */
  public validateConfiguration(): boolean {
    try {
      // Validate API URLs
      new URL(this.config.api.togetherAi.baseUrl);
      new URL(this.config.api.anthropic.baseUrl);
      new URL(this.config.api.github.apiUrl);

      // Validate split ratios sum to 1.0
      const { train, validation, test } = this.config.data.processing.splitRatio;
      if (Math.abs(train + validation + test - 1.0) > 0.001) {
        throw new Error('Data split ratios must sum to 1.0');
      }

      // Validate quality thresholds
      const { high, medium, low } = this.config.data.processing.qualityThresholds;
      if (high <= medium || medium <= low || low < 0 || high > 1) {
        throw new Error('Quality thresholds must be in ascending order between 0 and 1');
      }

      // Validate positive numbers
      if (this.config.automation.dataCollection.saveInterval <= 0) {
        throw new Error('Save interval must be positive');
      }

      elizaLogger.info('Training plugin configuration validation successful');
      return true;
    } catch (error) {
      elizaLogger.error('Training plugin configuration validation failed:', error);
      return false;
    }
  }

  /**
   * Log current configuration (without sensitive values)
   */
  public logConfiguration(): void {
    const safeConfig = {
      api: {
        togetherAi: { baseUrl: this.config.api.togetherAi.baseUrl },
        anthropic: { baseUrl: this.config.api.anthropic.baseUrl },
        github: { apiUrl: this.config.api.github.apiUrl },
      },
      models: {
        defaults: this.config.models.defaults,
        training: this.config.models.training,
      },
      data: {
        paths: this.config.data.paths,
        processing: this.config.data.processing,
      },
      automation: {
        dataCollection: this.config.automation.dataCollection,
        training: this.config.automation.training,
      },
    };

    elizaLogger.info('Training plugin configuration:', safeConfig);
  }
}

/**
 * Global configuration instance
 */
let globalConfigManager: TrainingConfigurationManager | null = null;

/**
 * Get or create the global configuration manager
 */
export function getTrainingConfig(runtime?: IAgentRuntime): TrainingConfigurationManager {
  if (!globalConfigManager) {
    globalConfigManager = new TrainingConfigurationManager(runtime);

    // Validate configuration on first load
    if (!globalConfigManager.validateConfiguration()) {
      elizaLogger.warn('Training plugin configuration validation failed, using defaults');
    }
  }
  return globalConfigManager;
}

/**
 * Reset the global configuration (useful for testing)
 */
export function resetTrainingConfig(): void {
  globalConfigManager = null;
}
