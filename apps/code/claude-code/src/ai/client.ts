/**
 * AI Client
 * 
 * Handles interaction with Anthropic's Claude API, including
 * text completion, chat, and code assistance features.
 */

import { logger } from '../utils/logger.js';
import { createUserError } from '../errors/formatter.js';
import { ErrorCategory } from '../errors/types.js';
import { withTimeout, withRetry } from '../utils/async.js';
import { truncate } from '../utils/formatting.js';

// Types for API requests and responses
export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface CompletionOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  topK?: number;
  stopSequences?: string[];
  stream?: boolean;
  system?: string;
}

export interface CompletionRequest {
  model: string;
  messages: Message[];
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  stream?: boolean;
  system?: string;
}

export interface CompletionResponse {
  id: string;
  model: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
  content: {
    type: string;
    text: string;
  }[];
  stop_reason?: string;
  stop_sequence?: string;
}

export interface StreamEvent {
  type: 'message_start' | 'content_block_start' | 'content_block_delta' | 'content_block_stop' | 'message_delta' | 'message_stop';
  message?: {
    id: string;
    model: string;
    content: {
      type: string;
      text: string;
    }[];
    stop_reason?: string;
    stop_sequence?: string;
  };
  index?: number;
  delta?: {
    type: string;
    text: string;
  };
  usage_metadata?: {
    input_tokens: number;
    output_tokens: number;
  };
}

// Default API configuration
const DEFAULT_CONFIG = {
  apiBaseUrl: 'https://api.anthropic.com',
  apiVersion: '2023-06-01',
  timeout: 60000, // 60 seconds
  retryOptions: {
    maxRetries: 3,
    initialDelayMs: 1000,
    maxDelayMs: 10000
  },
  defaultModel: 'claude-3-opus-20240229',
  defaultMaxTokens: 4096,
  defaultTemperature: 0.7
};

/**
 * Claude AI client for interacting with Anthropic's Claude API
 */
export class AIClient {
  private config: typeof DEFAULT_CONFIG;
  private authToken: string;
  
  /**
   * Create a new AI client
   */
  constructor(config: Partial<typeof DEFAULT_CONFIG> = {}, authToken: string) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.authToken = authToken;
    
    logger.debug('AI client created with config', { 
      apiBaseUrl: this.config.apiBaseUrl,
      apiVersion: this.config.apiVersion,
      defaultModel: this.config.defaultModel
    });
  }
  
  /**
   * Format API request headers
   */
  private getHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'X-Api-Key': this.authToken,
      'anthropic-version': this.config.apiVersion,
      'User-Agent': 'claude-code-cli'
    };
  }
  
  /**
   * Send a completion request to Claude
   */
  async complete(
    prompt: string | Message[],
    options: CompletionOptions = {}
  ): Promise<CompletionResponse> {
    logger.debug('Sending completion request', { model: options.model || this.config.defaultModel });
    
    // Format the request
    const messages: Message[] = Array.isArray(prompt) 
      ? prompt 
      : [{ role: 'user', content: prompt }];
    
    const request: CompletionRequest = {
      model: options.model || this.config.defaultModel,
      messages,
      max_tokens: options.maxTokens || this.config.defaultMaxTokens,
      temperature: options.temperature ?? this.config.defaultTemperature,
      stream: false
    };
    
    // Add optional parameters
    if (options.topP !== undefined) request.top_p = options.topP;
    if (options.topK !== undefined) request.top_k = options.topK;
    if (options.stopSequences) request.stop_sequences = options.stopSequences;
    if (options.system) request.system = options.system;
    
    // Make the API request with timeout and retry
    try {
      // Wrap the sendRequest method to handle timeouts correctly
      const sendRequestWithPath = async (path: string, requestOptions: RequestInit) => {
        return this.sendRequest(path, requestOptions);
      };
      
      const timeoutFn = withTimeout(sendRequestWithPath, this.config.timeout);
      
      const retryFn = withRetry(timeoutFn, {
        maxRetries: this.config.retryOptions.maxRetries,
        initialDelayMs: this.config.retryOptions.initialDelayMs,
        maxDelayMs: this.config.retryOptions.maxDelayMs
      });
      
      const response = await retryFn('/v1/messages', {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(request)
      });
      
      return response;
    } catch (error) {
      logger.error('Completion request failed', error);
      
      throw createUserError('Failed to get response from Claude', {
        cause: error,
        category: ErrorCategory.AI_SERVICE,
        resolution: 'Check your internet connection and try again. If the problem persists, verify your API key.'
      });
    }
  }
  
  /**
   * Send a streaming completion request to Claude
   */
  async completeStream(
    prompt: string | Message[],
    options: CompletionOptions = {},
    onEvent: (event: StreamEvent) => void
  ): Promise<void> {
    logger.debug('Sending streaming completion request', { model: options.model || this.config.defaultModel });
    
    // Format the request
    const messages: Message[] = Array.isArray(prompt) 
      ? prompt 
      : [{ role: 'user', content: prompt }];
    
    const request: CompletionRequest = {
      model: options.model || this.config.defaultModel,
      messages,
      max_tokens: options.maxTokens || this.config.defaultMaxTokens,
      temperature: options.temperature ?? this.config.defaultTemperature,
      stream: true
    };
    
    // Add optional parameters
    if (options.topP !== undefined) request.top_p = options.topP;
    if (options.topK !== undefined) request.top_k = options.topK;
    if (options.stopSequences) request.stop_sequences = options.stopSequences;
    if (options.system) request.system = options.system;
    
    // Make the API request
    try {
      await this.sendStreamRequest('/v1/messages', {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(request)
      }, onEvent);
    } catch (error) {
      logger.error('Streaming completion request failed', error);
      
      throw createUserError('Failed to get streaming response from Claude', {
        cause: error,
        category: ErrorCategory.AI_SERVICE,
        resolution: 'Check your internet connection and try again. If the problem persists, verify your API key.'
      });
    }
  }
  
  /**
   * Test the connection to the Claude API
   */
  async testConnection(): Promise<boolean> {
    logger.debug('Testing connection to Claude API');
    
    try {
      // Send a minimal request to test connectivity
      const result = await this.complete('Hello', {
        maxTokens: 10,
        temperature: 0
      });
      
      logger.debug('Connection test successful', { modelUsed: result.model });
      return true;
    } catch (error) {
      logger.error('Connection test failed', error);
      return false;
    }
  }
  
  /**
   * Send a request to the Claude API
   */
  private async sendRequest(path: string, options: RequestInit): Promise<any> {
    const url = `${this.config.apiBaseUrl}${path}`;
    
    logger.debug(`Sending request to ${url}`);
    
    try {
      const response = await fetch(url, options);
      
      if (!response.ok) {
        await this.handleErrorResponse(response);
      }
      
      const data = await response.json();
      return data;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw createUserError('Request timed out', {
          category: ErrorCategory.TIMEOUT,
          resolution: 'Try again or increase the timeout setting.'
        });
      }
      
      throw error;
    }
  }
  
  /**
   * Send a streaming request to the Claude API
   */
  private async sendStreamRequest(
    path: string, 
    options: RequestInit,
    onEvent: (event: StreamEvent) => void
  ): Promise<void> {
    const url = `${this.config.apiBaseUrl}${path}`;
    
    logger.debug(`Sending streaming request to ${url}`);
    
    try {
      const response = await fetch(url, options);
      
      if (!response.ok) {
        await this.handleErrorResponse(response);
      }
      
      if (!response.body) {
        throw new Error('Response body is null');
      }
      
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      
      while (true) {
        const { done, value } = await reader.read();
        
        if (done) {
          break;
        }
        
        // Decode the chunk and add to buffer
        buffer += decoder.decode(value, { stream: true });
        
        // Process any complete events in the buffer
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep the last incomplete line in the buffer
        
        for (const line of lines) {
          const trimmedLine = line.trim();
          if (!trimmedLine || trimmedLine === 'data: [DONE]') {
            continue;
          }
          
          // Parse the event data
          if (trimmedLine.startsWith('data: ')) {
            try {
              const eventData = JSON.parse(trimmedLine.slice(6));
              onEvent(eventData);
            } catch (error) {
              logger.error('Failed to parse stream event', { line: trimmedLine, error });
            }
          }
        }
      }
      
      // Process any remaining data
      if (buffer.trim()) {
        if (buffer.trim().startsWith('data: ') && buffer.trim() !== 'data: [DONE]') {
          try {
            const eventData = JSON.parse(buffer.trim().slice(6));
            onEvent(eventData);
          } catch (error) {
            logger.error('Failed to parse final stream event', { buffer, error });
          }
        }
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw createUserError('Streaming request timed out', {
          category: ErrorCategory.TIMEOUT,
          resolution: 'Try again or increase the timeout setting.'
        });
      }
      
      throw error;
    }
  }
  
  /**
   * Handle error responses from the API
   */
  private async handleErrorResponse(response: Response): Promise<never> {
    let errorData: any = {};
    let errorMessage = `API request failed with status ${response.status}`;
    
    try {
      // Try to parse the error response
      errorData = await response.json();
      
      if (errorData.error && errorData.error.message) {
        errorMessage = errorData.error.message;
      }
    } catch {
      // If we can't parse the response, use the status text
      errorMessage = `API request failed: ${response.statusText || response.status}`;
    }
    
    logger.error('API error response', { status: response.status, errorData });
    
    // Handle specific error codes
    switch (response.status) {
      case 401:
        throw createUserError('Authentication failed. Please check your API key.', {
          category: ErrorCategory.AUTHENTICATION,
          resolution: 'Verify your API key and try again. You may need to log in again with the --login flag.'
        });
        
      case 403:
        throw createUserError('You do not have permission to access this resource.', {
          category: ErrorCategory.AUTHENTICATION,
          resolution: 'Verify that your API key has the necessary permissions.'
        });
        
      case 404:
        throw createUserError('The requested resource was not found.', {
          category: ErrorCategory.API,
          resolution: 'Check that you are using the correct API endpoint.'
        });
        
      case 429:
        throw createUserError('Rate limit exceeded.', {
          category: ErrorCategory.RATE_LIMIT,
          resolution: 'Please wait before sending more requests.'
        });
        
      case 500:
      case 502:
      case 503:
      case 504:
        throw createUserError('The API server encountered an error.', {
          category: ErrorCategory.SERVER,
          resolution: 'This is likely a temporary issue. Please try again later.'
        });
        
      default:
        throw createUserError(errorMessage, {
          category: ErrorCategory.API,
          resolution: 'Check the error details and try again.'
        });
    }
  }
} 