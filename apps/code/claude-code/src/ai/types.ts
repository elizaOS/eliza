/**
 * AI Types
 * 
 * Type definitions for AI services and functionality.
 */

/**
 * Role for a message in a conversation
 */
export type MessageRole = 'user' | 'assistant' | 'system';

/**
 * Message in a conversation
 */
export interface Message {
  /**
   * Role of the message sender
   */
  role: MessageRole;
  
  /**
   * Content of the message
   */
  content: string;
}

/**
 * AI model information
 */
export interface AIModel {
  /**
   * Model ID
   */
  id: string;
  
  /**
   * Model name
   */
  name: string;
  
  /**
   * Model version
   */
  version?: string;
  
  /**
   * Maximum context length in tokens
   */
  maxContextLength?: number;
  
  /**
   * Whether the model supports streaming
   */
  supportsStreaming?: boolean;
  
  /**
   * Default parameters for the model
   */
  defaultParams?: Record<string, any>;
}

/**
 * AI completion usage information
 */
export interface AIUsage {
  /**
   * Input tokens used
   */
  inputTokens: number;
  
  /**
   * Output tokens used
   */
  outputTokens: number;
  
  /**
   * Total tokens used
   */
  totalTokens?: number;
}

/**
 * AI completion request options
 */
export interface CompletionOptions {
  /**
   * Model to use
   */
  model?: string;
  
  /**
   * Temperature for sampling (0-1)
   */
  temperature?: number;
  
  /**
   * Maximum tokens to generate
   */
  maxTokens?: number;
  
  /**
   * Top P sampling parameter
   */
  topP?: number;
  
  /**
   * Top K sampling parameter
   */
  topK?: number;
  
  /**
   * Stop sequences to end generation
   */
  stopSequences?: string[];
  
  /**
   * System message for context
   */
  system?: string;
}

/**
 * AI completion request
 */
export interface CompletionRequest {
  /**
   * Messages for the conversation
   */
  messages: Message[];
  
  /**
   * Completion options
   */
  options?: CompletionOptions;
}

/**
 * AI completion response
 */
export interface CompletionResponse {
  /**
   * Generated text
   */
  text: string;
  
  /**
   * Model used for generation
   */
  model: string;
  
  /**
   * Reason the generation stopped
   */
  stopReason?: string;
  
  /**
   * Token usage information
   */
  usage?: AIUsage;
}

/**
 * Callback for streaming AI completions
 */
export type StreamCallback = (event: any) => void;

/**
 * AI client configuration
 */
export interface AIClientConfig {
  /**
   * Base URL for the API
   */
  baseUrl: string;
  
  /**
   * API version
   */
  apiVersion: string;
  
  /**
   * Request timeout in milliseconds
   */
  timeout?: number;
  
  /**
   * Authentication provider
   */
  auth: any;
}

/**
 * Interface for AI clients
 */
export interface AIClientInterface {
  /**
   * Generate a completion
   */
  generateCompletion(request: CompletionRequest): Promise<CompletionResponse>;
  
  /**
   * Generate a streaming completion
   */
  generateCompletionStream(request: CompletionRequest, callback: StreamCallback): Promise<void>;
  
  /**
   * Test the connection to the AI service
   */
  testConnection(): Promise<boolean>;
  
  /**
   * Disconnect from the AI service
   */
  disconnect(): Promise<void>;
} 