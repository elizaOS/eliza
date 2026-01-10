import type { IAgentRuntime } from '@elizaos/core';

export interface AIGatewayConfig {
  apiKey: string;
  baseUrl: string;
  openaiCompatibleUrl?: string;
  accountId?: string;
  workspace?: string;
  smallModel: string;
  largeModel: string;
  embeddingModel: string;
  imageModel: string;
}

export interface GatewayTextParams {
  prompt: string;
  messages?: Array<{
    role: 'user' | 'assistant' | 'system';
    content: string;
  }>;
  temperature?: number;
  maxTokens?: number;
  stopSequences?: string[];
  frequencyPenalty?: number;
  presencePenalty?: number;
}

export interface GatewayObjectParams {
  prompt: string;
  schema?: any;
  temperature?: number;
  maxTokens?: number;
}

export interface GatewayEmbeddingParams {
  text: string;
  model?: string;
}

export interface GatewayImageParams {
  prompt: string;
  n?: number;
  size?: string;
  model?: string;
}

export interface GatewayImageDescriptionParams {
  imageUrl: string;
  prompt?: string;
  model?: string;
}

export interface GatewayTranscriptionParams {
  audioBuffer: Buffer;
  model?: string;
}

export interface GatewayResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
}

export type ModelHandler<TParams, TResult> = (
  runtime: IAgentRuntime,
  params: TParams
) => Promise<TResult>;