export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface TextGenerationParams {
  prompt: string;
  system?: string;
  maxTokens?: number;
  temperature?: number;
  topK?: number;
  topP?: number;
  stopSequences?: string[];
}

export interface TextGenerationResponse {
  text: string;
  usage: TokenUsage;
  model: string;
}

export interface EmbeddingParams {
  text: string;
}

export interface EmbeddingResponse {
  embedding: number[];
  model: string;
}

export interface ImageDescriptionParams {
  imageUrl: string;
  prompt?: string;
}

export interface ImageDescriptionResponse {
  title: string;
  description: string;
}

export interface ObjectGenerationParams {
  prompt: string;
  system?: string;
  schema?: Record<string, string | number | boolean | null>;
  temperature?: number;
  maxTokens?: number;
}

export interface ObjectGenerationResponse {
  object: Record<string, string | number | boolean | null>;
  usage: TokenUsage;
  model: string;
}
