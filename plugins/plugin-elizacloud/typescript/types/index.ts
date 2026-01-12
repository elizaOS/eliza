export interface OpenAITranscriptionParams {
  audio: Blob | File | Buffer;
  model?: string;
  language?: string;
  response_format?: string;
  prompt?: string;
  temperature?: number;
  timestampGranularities?: string[];
  mimeType?: string;
}

export interface OpenAITextToSpeechParams {
  text: string;
  model?: string;
  voice?: string;
  format?: "mp3" | "wav" | "flac" | string;
  instructions?: string;
}

export interface ImageDescriptionResult {
  title: string;
  description: string;
}

export interface OpenAIConfig {
  apiKey?: string;
  baseURL?: string;
  embeddingApiKey?: string;
  embeddingURL?: string;
  smallModel?: string;
  largeModel?: string;
  imageDescriptionModel?: string;
  embeddingModel?: string;
  embeddingDimensions?: number;
}
