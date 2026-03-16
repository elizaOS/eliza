export interface GatewayConfig {
  apiKey: string;
  baseUrl: string;
  smallModel: string;
  largeModel: string;
  embeddingModel: string;
  embeddingDimensions: number;
  imageModel: string;
  timeoutMs: number;
}

export const DEFAULT_CONFIG: Omit<GatewayConfig, "apiKey"> = {
  baseUrl: "https://ai-gateway.vercel.sh/v1",
  smallModel: "gpt-5-mini",
  largeModel: "gpt-5",
  embeddingModel: "text-embedding-3-small",
  embeddingDimensions: 1536,
  imageModel: "dall-e-3",
  timeoutMs: 60000,
};

export interface TextGenerationParams {
  prompt: string;
  system?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  stopSequences?: string[];
  stream?: boolean;
  onStreamChunk?: (chunk: string) => void;
}

export interface EmbeddingParams {
  text: string;
  model?: string;
  dimensions?: number;
}

export interface ObjectGenerationParams {
  prompt: string;
  schema?: Record<string, unknown>;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export type ImageSize = "256x256" | "512x512" | "1024x1024" | "1792x1024" | "1024x1792";

export type ImageQuality = "standard" | "hd";

export type ImageStyle = "vivid" | "natural";

export interface ImageGenerationParams {
  prompt: string;
  model?: string;
  n?: number;
  size?: ImageSize;
  quality?: ImageQuality;
  style?: ImageStyle;
}

export interface ImageDescriptionParams {
  imageUrl: string;
  prompt?: string;
  model?: string;
  maxTokens?: number;
}

export interface ImageGenerationResult {
  url: string;
  revisedPrompt?: string;
}

export interface ImageDescriptionResult {
  title: string;
  description: string;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export type MessageRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: MessageRole;
  content: string | null;
}

export interface ChatCompletionChoice {
  index: number;
  message: ChatMessage;
  finishReason: string | null;
}

export interface ChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage?: TokenUsage;
}

export interface EmbeddingData {
  embedding: number[];
  index: number;
}

export interface EmbeddingResponse {
  object: "list";
  data: EmbeddingData[];
  model: string;
  usage: TokenUsage;
}

export interface ImageResponseData {
  url: string;
  revised_prompt?: string;
}

export interface ImageGenerationResponse {
  created: number;
  data: ImageResponseData[];
}

export class GatewayError extends Error {
  statusCode?: number;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = "GatewayError";
    this.statusCode = statusCode;
  }
}
