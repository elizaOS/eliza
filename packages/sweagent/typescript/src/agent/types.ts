/**
 * Common types for agent modules
 */

/**
 * Model response output
 */
export interface ModelOutput {
  message: string;
  content?: string;
  toolCalls?: ToolCall[];
  thinkingBlocks?: ThinkingBlock[];
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

/**
 * Tool call structure
 */
export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/**
 * Thinking block structure
 */
export interface ThinkingBlock {
  type: string;
  content: string;
  [key: string]: unknown;
}

/**
 * Command definition
 */
export interface Command {
  name: string;
  endName?: string;
  installScript?: string;
  [key: string]: unknown;
}

/**
 * Format dictionary for template rendering
 */
export interface FormatDict {
  [key: string]: string | number | boolean | undefined | null;
}

/**
 * Extra fields for problem statements and other configs
 */
export interface ExtraFields {
  [key: string]: string | number | boolean | object | null;
}

/**
 * Stats data structure
 */
export interface StatsData {
  instanceCost: number;
  tokensSent: number;
  tokensReceived: number;
  apiCalls: number;
}

/**
 * API response structure
 */
export interface APIResponse {
  choices?: Array<{
    message?: {
      content: string;
      role: string;
    };
    index: number;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

/**
 * History message content type
 */
export type MessageContent =
  | string
  | Array<{
      type: 'text' | 'image_url';
      text?: string;
      image_url?: { url: string };
      cacheControl?: { type: string };
    }>;
