export interface OllamaConfig {
  baseUrl: string;
  smallModel: string;
  largeModel: string;
  embeddingModel: string;
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
}

export interface TextGenerationResponse {
  text: string;
  model: string;
}

export interface ObjectGenerationParams {
  prompt: string;
  system?: string;
  temperature?: number;
  schema?: Record<string, string | number | boolean | null>;
  maxTokens?: number;
}

export interface ObjectGenerationResponse {
  object: Record<string, string | number | boolean | null>;
  model: string;
}

export interface EmbeddingParams {
  text: string;
}

export interface EmbeddingResponse {
  embedding: number[];
  model: string;
}

export interface OllamaModelInfo {
  name: string;
  size: number;
  modified_at: string;
}

export interface OllamaTagsResponse {
  models: OllamaModelInfo[];
}
