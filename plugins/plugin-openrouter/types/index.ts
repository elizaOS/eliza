export interface OpenRouterConfig {
  apiKey: string;
  baseUrl: string;
  smallModel: string;
  largeModel: string;
  imageModel: string;
  imageGenerationModel: string;
  embeddingModel: string;
  embeddingDimensions: number;
  timeoutMs: number;
}

export interface TextGenerationParams {
  prompt: string;
  system?: string;
  temperature?: number;
  maxTokens?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  stopSequences?: string[];
  stream?: boolean;
}

export interface TextGenerationResponse {
  text: string;
  model: string;
  usage?: TokenUsage;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ObjectGenerationParams {
  prompt: string;
  system?: string;
  temperature?: number;
  schema?: Record<string, unknown>;
  maxTokens?: number;
}

export interface ObjectGenerationResponse {
  object: Record<string, unknown>;
  model: string;
  usage?: TokenUsage;
}

export interface ImageDescriptionParams {
  imageUrl: string;
  prompt?: string;
}

export interface ImageDescriptionResponse {
  description: string;
  model: string;
}

export interface ImageGenerationParams {
  prompt: string;
  width?: number;
  height?: number;
}

export interface ImageGenerationResponse {
  imageData: string;
  model: string;
}

export interface EmbeddingParams {
  text: string;
}

export interface EmbeddingResponse {
  embedding: number[];
  model: string;
}

export interface OpenRouterModelInfo {
  id: string;
  name: string;
  contextLength: number;
  pricing: {
    prompt: number;
    completion: number;
  };
}
