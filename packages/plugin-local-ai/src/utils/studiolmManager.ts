import { type GenerateTextParams, ModelType, logger } from '@elizaos/core';

/**
 * Represents a StudioLMModel object with the following properties:
 * - id: string
 * - object: string
 * - created: number
 * - owned_by: string
 */
interface StudioLMModel {
  id: string;
  object: string;
  created: number;
  owned_by: string;
}

/**
 * Interface representing a chat message.
 * @property {string} role - The role of the sender, can be "system", "user", or "assistant".
 * @property {string} content - The content of the message.
 */
interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Interface representing a chat completion request.
 * @property {string} model - The model to be used for generating chat completions.
 * @property {ChatMessage[]} messages - An array of chat messages to provide context for the completion.
 * @property {number} [temperature] - The temperature parameter to control the randomness of the generated completions.
 * @property {number} [max_tokens] - The maximum number of tokens to generate in the completion.
 * @property {boolean} [stream] - Whether to generate completions in a streaming fashion.
 */

interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
}

/**
 * Represents a response object for completing a chat session.
 * @typedef {Object} ChatCompletionResponse
 * @property {string} id - The unique identifier for the completion response.
 * @property {string} object - The type of object being returned.
 * @property {number} created - The timestamp of when the completion response was created.
 * @property {string} model - The type of model associated with the completion response.
 * @property {Object[]} choices - An array of choices made during the chat session.
 * @property {number} choices.index - The index of the choice within the array.
 * @property {ChatMessage} choices.message - The message associated with the choice.
 * @property {string} choices.finish_reason - The reason for finishing the chat session.
 */
interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: {
    index: number;
    message: ChatMessage;
    finish_reason: string;
  }[];
}

/**
 * Class representing a Studio Language Model Manager.
 */

export class StudioLMManager {
  private static instance: StudioLMManager | null = null;
  private serverUrl: string;
  private initialized = false;
  private availableModels: StudioLMModel[] = [];
  private configuredModels = {
    small: process.env.STUDIOLM_SMALL_MODEL || 'lmstudio-community/deepseek-r1-distill-qwen-1.5b',
    medium: process.env.STUDIOLM_MEDIUM_MODEL || 'deepseek-r1-distill-qwen-7b',
  };

  /**
   * Private constructor for StudioLMManager.
   * Initializes with default serverUrl if not provided in environment variables.
   * Logs initialization information including serverUrl, configuredModels, and timestamp.
   */
  private constructor() {
    this.serverUrl = process.env.STUDIOLM_SERVER_URL || 'http://localhost:1234';
    logger.info('StudioLMManager initialized with configuration:', {
      serverUrl: this.serverUrl,
      configuredModels: this.configuredModels,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Returns an instance of StudioLMManager. If an instance already exists, it returns the existing instance.
   * @returns {StudioLMManager} The instance of StudioLMManager
   */
  public static getInstance(): StudioLMManager {
    if (!StudioLMManager.instance) {
      StudioLMManager.instance = new StudioLMManager();
    }
    return StudioLMManager.instance;
  }

  /**
   * Check the status of the server by sending a request to the /v1/models endpoint.
   * @returns {Promise<boolean>} A Promise that resolves to true if the server responds with success status, false otherwise.
   */
  private async checkServerStatus(): Promise<boolean> {
    try {
      const response = await fetch(`${this.serverUrl}/v1/models`);
      if (!response.ok) {
        throw new Error(`Server responded with status: ${response.status}`);
      }
      return true;
    } catch (error) {
      logger.error('LM Studio server check failed:', {
        error: error instanceof Error ? error.message : String(error),
        serverUrl: this.serverUrl,
        timestamp: new Date().toISOString(),
      });
      return false;
    }
  }

  /**
   * Fetches the available models from the server and stores them in the 'availableModels' property.
   *
   * @returns {Promise<void>} A Promise that resolves when the models are fetched successfully or rejects with an error.
   */
  private async fetchAvailableModels(): Promise<void> {
    try {
      const response = await fetch(`${this.serverUrl}/v1/models`);
      if (!response.ok) {
        throw new Error(`Failed to fetch models: ${response.status}`);
      }

      const data = (await response.json()) as { data: StudioLMModel[] };
      this.availableModels = data.data;

      logger.info('LM Studio available models:', {
        count: this.availableModels.length,
        models: this.availableModels.map((m) => m.id),
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('Failed to fetch LM Studio models:', {
        error: error instanceof Error ? error.message : String(error),
        serverUrl: this.serverUrl,
        timestamp: new Date().toISOString(),
      });
      throw error;
    }
  }

  /**
   * Asynchronously tests the specified model with a chat completion request.
   * @param {string} modelId - The ID of the model to test.
   * @returns {Promise<boolean>} - A promise that resolves to true if the model test was successful, false otherwise.
   */
  private async testModel(modelId: string): Promise<boolean> {
    try {
      const testRequest: ChatCompletionRequest = {
        model: modelId,
        messages: [
          {
            role: 'system',
            content: 'Always answer in rhymes. Today is Thursday',
          },
          { role: 'user', content: 'What day is it today?' },
        ],
        temperature: 0.7,
        max_tokens: -1,
        stream: false,
      };

      logger.info(`Testing model ${modelId}...`);

      const response = await fetch(`${this.serverUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(testRequest),
      });

      if (!response.ok) {
        throw new Error(`Model test failed with status: ${response.status}`);
      }

      const result = (await response.json()) as ChatCompletionResponse;

      if (!result.choices?.[0]?.message?.content) {
        throw new Error('No valid response content received');
      }

      logger.info(`Model ${modelId} test response:`, {
        content: result.choices[0].message.content,
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
   * Tests the configured text models to ensure they are working properly.
   * Logs the results of the test and any failed models.
   * @returns {Promise<void>} A promise that resolves when the test is complete.
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
   * Initializes StudioLM by checking server status, fetching available models,
   * and testing text models.
   *
   * @returns {Promise<void>} A Promise that resolves when initialization is complete
   */
  public async initialize(): Promise<void> {
    try {
      if (this.initialized) {
        logger.info('StudioLM already initialized, skipping initialization');
        return;
      }

      logger.info('Starting StudioLM initialization...');
      const serverAvailable = await this.checkServerStatus();

      if (!serverAvailable) {
        throw new Error('LM Studio server is not available');
      }

      await this.fetchAvailableModels();
      await this.testTextModels();

      this.initialized = true;
      logger.success('StudioLM initialization complete');
    } catch (error) {
      logger.error('StudioLM initialization failed:', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }
  }

  /**
   * Retrieves the available models in the studio.
   *
   * @returns {StudioLMModel[]} An array of StudioLMModel objects representing the available models.
   */
  public getAvailableModels(): StudioLMModel[] {
    return this.availableModels;
  }

  /**
   * Check if the object is initialized.
   *
   * @returns {boolean} Returns true if the object is initialized, otherwise false.
   */
  public isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Asynchronously generates text using StudioLM based on provided parameters.
   *
   * @param {GenerateTextParams} params - The parameters for generating text.
   * @param {boolean} [isInitialized=false] - Flag to indicate if the model is already initialized.
   * @returns {Promise<string>} The generated text as a Promise.
   */
  public async generateText(params: GenerateTextParams, isInitialized = false): Promise<string> {
    try {
      // Log entry point with all parameters
      logger.info('StudioLM generateText entry:', {
        isInitialized,
        currentInitState: this.initialized,
        managerInitState: this.isInitialized(),
        modelType: params.modelType,
        contextLength: params.prompt?.length,
        timestamp: new Date().toISOString(),
      });

      // Only initialize if not already initialized and not marked as initialized
      if (!this.initialized && !isInitialized) {
        throw new Error('StudioLM not initialized. Please initialize before generating text.');
      }

      const messages: ChatMessage[] = [
        {
          role: 'system',
          content: 'You are a helpful AI assistant. Respond to the current request only.',
        },
        { role: 'user', content: params.prompt },
      ];

      logger.info('StudioLM preparing request:', {
        model:
          params.modelType === ModelType.TEXT_LARGE
            ? this.configuredModels.medium
            : this.configuredModels.small,
        messageCount: messages.length,
        timestamp: new Date().toISOString(),
      });

      logger.info('Incoming context structure:', {
        contextLength: params.prompt.length,
        hasAction: params.prompt.includes('action'),
        runtime: !!params.runtime,
        stopSequences: params.stopSequences,
      });

      const request: ChatCompletionRequest = {
        model:
          params.modelType === ModelType.TEXT_LARGE
            ? this.configuredModels.medium
            : this.configuredModels.small,
        messages,
        temperature: 0.7,
        max_tokens: 8192,
        stream: false,
      };

      const response = await fetch(`${this.serverUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(request),
      });

      if (!response.ok) {
        throw new Error(`StudioLM request failed: ${response.status}`);
      }

      const result = (await response.json()) as ChatCompletionResponse;

      if (!result.choices?.[0]?.message?.content) {
        throw new Error('No valid response content received from StudioLM');
      }

      let responseText = result.choices[0].message.content;

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

      logger.info('StudioLM request completed successfully:', {
        responseLength: responseText.length,
        hasThinkTags: responseText.includes('<think>'),
        timestamp: new Date().toISOString(),
      });

      return responseText;
    } catch (error) {
      logger.error('StudioLM text generation error:', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        phase: 'text generation',
        timestamp: new Date().toISOString(),
      });
      throw error;
    }
  }
}
