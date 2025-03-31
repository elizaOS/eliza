import { type GenerateTextParams, ModelType, logger } from '@elizaos/core';

/**
 * Interface representing the structure of an Ollama model.
 * @typedef {Object} OllamaModel
 * @property {string} name - The name of the Ollama model.
 * @property {string} id - The unique identifier of the Ollama model.
 * @property {string} size - The size of the Ollama model.
 * @property {string} modified - The date when the Ollama model was last modified.
 */
interface OllamaModel {
  name: string;
  id: string;
  size: string;
  modified: string;
}

/**
 * Interface representing a response from the Ollama API.
 * @property {string} model - The model used for generating the response.
 * @property {string} response - The actual response generated by the model.
 * @property {boolean} done - Indicates whether the response generation is complete.
 * @property {number[]} [prompt] - Optional array of prompt values used in generating the response.
 * @property {number} [total_duration] - Optional total duration of the response generation process.
 * @property {number} [load_duration] - Optional load duration of the model used.
 * @property {number} [prompt_eval_duration] - Optional evaluation duration for the prompt values.
 * @property {number} [eval_duration] - Optional evaluation duration for the response generation.
 */
interface OllamaResponse {
  model: string;
  response: string;
  done: boolean;
  prompt?: number[];
  total_duration?: number;
  load_duration?: number;
  prompt_eval_duration?: number;
  eval_duration?: number;
}

/**
 * Manages interactions with the Ollama API, including server status checks, fetching available models,
 * testing models, initializing the manager, generating text, and more.
 */
export class OllamaManager {
  private static instance: OllamaManager | null = null;
  private serverUrl: string;
  private initialized = false;
  private availableModels: OllamaModel[] = [];
  private configuredModels = {
    small: process.env.OLLAMA_SMALL_MODEL || 'deepseek-r1:1.5b',
    medium: process.env.OLLAMA_MEDIUM_MODEL || 'deepseek-r1:7b',
  };

  /**
   * Private constructor for initializing OllamaManager.
   */
  private constructor() {
    this.serverUrl = process.env.OLLAMA_API_ENDPOINT || 'http://localhost:11434';
    logger.info('OllamaManager initialized with configuration:', {
      serverUrl: this.serverUrl,
      configuredModels: this.configuredModels,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Returns an instance of the OllamaManager class.
   * If an instance does not already exist, a new instance is created and returned.
   * @returns {OllamaManager} The instance of the OllamaManager class.
   */
  public static getInstance(): OllamaManager {
    if (!OllamaManager.instance) {
      OllamaManager.instance = new OllamaManager();
    }
    return OllamaManager.instance;
  }

  /**
   * Asynchronously checks the status of the server by attempting to fetch the "/api/tags" endpoint.
   * @returns A Promise that resolves to a boolean indicating if the server is reachable and responding with a successful status.
   */
  private async checkServerStatus(): Promise<boolean> {
    try {
      const response = await fetch(`${this.serverUrl}/api/tags`);
      if (!response.ok) {
        throw new Error(`Server responded with status: ${response.status}`);
      }
      return true;
    } catch (error) {
      logger.error('Ollama server check failed:', {
        error: error instanceof Error ? error.message : String(error),
        serverUrl: this.serverUrl,
        timestamp: new Date().toISOString(),
      });
      return false;
    }
  }

  /**
   * Fetches the available Ollama models from the specified server URL.
   *
   * @returns {Promise<void>} A Promise that resolves when the available models are successfully fetched.
   */
  private async fetchAvailableModels(): Promise<void> {
    try {
      const response = await fetch(`${this.serverUrl}/api/tags`);
      if (!response.ok) {
        throw new Error(`Failed to fetch models: ${response.status}`);
      }

      const data = (await response.json()) as { models: OllamaModel[] };
      this.availableModels = data.models;

      logger.info('Ollama available models:', {
        count: this.availableModels.length,
        models: this.availableModels.map((m) => m.name),
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Failed to fetch Ollama models:', {
        error: error instanceof Error ? error.message : String(error),
        serverUrl: this.serverUrl,
        timestamp: new Date().toISOString(),
      });
      throw error;
    }
  }

  /**
   * Asynchronously tests a model specified by the given modelId.
   *
   * @param {string} modelId - The ID of the model to be tested.
   * @returns {Promise<boolean>} - A promise that resolves to true if the model test is successful, false otherwise.
   */
  private async testModel(modelId: string): Promise<boolean> {
    try {
      const testRequest = {
        model: modelId,
        prompt:
          "Debug Mode: Test initialization. Respond with 'Initialization successful' if you can read this.",
        stream: false,
        options: {
          temperature: 0.7,
          num_predict: 100,
        },
      };

      logger.info(`Testing model ${modelId}...`);

      const response = await fetch(`${this.serverUrl}/api/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(testRequest),
      });

      if (!response.ok) {
        throw new Error(`Model test failed with status: ${response.status}`);
      }

      const result = (await response.json()) as OllamaResponse;

      if (!result.response) {
        throw new Error('No valid response content received');
      }

      logger.info(`Model ${modelId} test response:`, {
        content: result.response,
        model: result.model,
        timestamp: new Date().toISOString(),
      });

      return true;
    } catch (error) {
      logger.error(`Model ${modelId} test failed:`, {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        timestamp: new Date().toISOString(),
      });
      return false;
    }
  }

  /**
   * Asynchronously tests the configured text models to ensure they are working properly.
   * Logs the test results for each model and outputs a warning if any models fail the test.
   * @returns {Promise<void>} A Promise that resolves when all configured models have been tested.
   */
  private async testTextModels(): Promise<void> {
    logger.info('Testing configured text models...');

    const results = await Promise.all([
      this.testModel(this.configuredModels.small),
      this.testModel(this.configuredModels.medium),
    ]);

    const [smallWorking, mediumWorking] = results;

    if (!smallWorking || !mediumWorking) {
      const failedModels = [];
      if (!smallWorking) failedModels.push('small');
      if (!mediumWorking) failedModels.push('medium');

      logger.warn('Some models failed the test:', {
        failedModels,
        small: this.configuredModels.small,
        medium: this.configuredModels.medium,
      });
    } else {
      logger.success('All configured models passed the test');
    }
  }

  /**
   * Asynchronously initializes the Ollama service by checking server status,
   * fetching available models, and testing text models.
   *
   * @returns A Promise that resolves when initialization is complete
   */
  public async initialize(): Promise<void> {
    try {
      if (this.initialized) {
        logger.info('Ollama already initialized, skipping initialization');
        return;
      }

      logger.info('Starting Ollama initialization...');
      const serverAvailable = await this.checkServerStatus();

      if (!serverAvailable) {
        throw new Error('Ollama server is not available');
      }

      await this.fetchAvailableModels();
      await this.testTextModels();

      this.initialized = true;
      logger.success('Ollama initialization complete');
    } catch (error) {
      logger.error('Ollama initialization failed:', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }
  }

  /**
   * Retrieves the available Ollama models.
   *
   * @returns {OllamaModel[]} An array of OllamaModel objects representing the available models.
   */
  public getAvailableModels(): OllamaModel[] {
    return this.availableModels;
  }

  /**
   * Check if the object is initialized.
   * @returns {boolean} True if the object is initialized, false otherwise.
   */
  public isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Generates text using the Ollama AI model.
   *
   * @param {GenerateTextParams} params - The parameters for generating text.
   * @param {boolean} [isInitialized=false] - Flag indicating if Ollama is already initialized.
   * @returns {Promise<string>} - A promise that resolves with the generated text.
   */
  public async generateText(params: GenerateTextParams, isInitialized = false): Promise<string> {
    try {
      // Log entry point with all parameters
      logger.info('Ollama generateText entry:', {
        isInitialized,
        currentInitState: this.initialized,
        managerInitState: this.isInitialized(),
        modelType: params.modelType,
        contextLength: params.prompt?.length,
        timestamp: new Date().toISOString(),
      });

      // Only initialize if not already initialized and not marked as initialized
      if (!this.initialized && !isInitialized) {
        throw new Error('Ollama not initialized. Please initialize before generating text.');
      }

      logger.info('Ollama preparing request:', {
        model:
          params.modelType === ModelType.TEXT_LARGE
            ? this.configuredModels.medium
            : this.configuredModels.small,
        contextLength: params.prompt.length,
        timestamp: new Date().toISOString(),
      });

      const request = {
        model:
          params.modelType === ModelType.TEXT_LARGE
            ? this.configuredModels.medium
            : this.configuredModels.small,
        prompt: params.prompt,
        stream: false,
        options: {
          temperature: 0.7,
          top_p: 0.9,
          num_predict: 8192,
          repeat_penalty: 1.2,
          frequency_penalty: 0.7,
          presence_penalty: 0.7,
        },
      };

      const response = await fetch(`${this.serverUrl}/api/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(request),
      });

      if (!response.ok) {
        throw new Error(`Ollama request failed: ${response.status}`);
      }

      const result = (await response.json()) as OllamaResponse;

      if (!result.response) {
        throw new Error('No valid response content received from Ollama');
      }

      let responseText = result.response;

      // Log raw response for debugging
      logger.info('Raw response structure:', {
        responseLength: responseText.length,
        hasAction: responseText.includes('action'),
        hasThinkTag: responseText.includes('<think>'),
      });

      // Clean think tags if present
      if (responseText.includes('<think>')) {
        logger.info('Cleaning think tags from response');
        responseText = responseText.replace(/<think>[\s\S]*?<\/think>\n?/g, '');
        logger.info('Think tags removed from response');
      }

      logger.info('Ollama request completed successfully:', {
        responseLength: responseText.length,
        hasThinkTags: responseText.includes('<think>'),
        timestamp: new Date().toISOString(),
      });

      return responseText;
    } catch (error) {
      logger.error('Ollama text generation error:', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        phase: 'text generation',
        timestamp: new Date().toISOString(),
      });
      throw error;
    }
  }
}
