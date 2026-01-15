/**
 * Supported audio formats for transcription
 */
export type AudioFormat = "mp3" | "wav" | "webm" | "ogg" | "flac" | "mp4";

/**
 * Supported response formats for transcription
 */
export type TranscriptionResponseFormat = "json" | "text" | "srt" | "verbose_json" | "vtt";

/**
 * Timestamp granularity options for transcription
 */
export type TimestampGranularity = "word" | "segment";

/**
 * Supported TTS output formats
 */
export type TTSOutputFormat = "mp3" | "wav" | "flac" | "opus" | "aac" | "pcm";

/**
 * Supported TTS voices
 */
export type TTSVoice = "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer";

/**
 * Image sizes for DALL-E
 */
export type ImageSize = "256x256" | "512x512" | "1024x1024" | "1792x1024" | "1024x1792";

/**
 * Image quality options
 */
export type ImageQuality = "standard" | "hd";

/**
 * Image style options
 */
export type ImageStyle = "vivid" | "natural";

/**
 * Parameters for audio transcription
 */
export interface TranscriptionParams {
  /** The audio data to transcribe */
  audio: Blob | File | Buffer;

  /** The model to use for transcription */
  model?: string;

  /** The language of the audio (ISO-639-1 code) */
  language?: string;

  /** The format of the response */
  responseFormat?: TranscriptionResponseFormat;

  /** An optional prompt to guide the model's style */
  prompt?: string;

  /** Sampling temperature between 0 and 1 */
  temperature?: number;

  /** Timestamp granularity for verbose output */
  timestampGranularities?: TimestampGranularity[];

  /** MIME type hint for buffer audio data */
  mimeType?: string;
}

/**
 * Parameters for text-to-speech generation
 */
export interface TextToSpeechParams {
  /** The text to convert to speech (max 4096 characters) */
  text: string;

  /** The model to use */
  model?: string;

  /** The voice to use */
  voice?: TTSVoice;

  /** The output format */
  format?: TTSOutputFormat;

  /** Additional instructions for the TTS model */
  instructions?: string;
}

/**
 * Parameters for embedding generation
 */
export interface EmbeddingParams {
  /** The text to embed */
  text: string;

  /** The model to use */
  model?: string;

  /** The number of dimensions for the embedding */
  dimensions?: number;
}

/**
 * Parameters for image generation
 */
export interface ImageGenerationParams {
  /** The prompt describing the image to generate */
  prompt: string;

  /** Number of images to generate (1-10) */
  count?: number;

  /** The size of the generated images */
  size?: ImageSize;

  /** The quality of the generated images */
  quality?: ImageQuality;

  /** The style of the generated images */
  style?: ImageStyle;
}

/**
 * Parameters for image description/analysis
 */
export interface ImageDescriptionParams {
  /** URL of the image to analyze */
  imageUrl: string;

  /** Custom prompt for analysis */
  prompt?: string;

  /** Maximum tokens for the response */
  maxTokens?: number;
}

/**
 * Parameters for text generation
 */
export interface TextGenerationParams {
  /** The prompt for generation */
  prompt: string;

  /** System message for the model */
  system?: string;

  /** Temperature for sampling (0-2) */
  temperature?: number;

  /** Maximum output tokens */
  maxTokens?: number;

  /** Frequency penalty (-2 to 2) */
  frequencyPenalty?: number;

  /** Presence penalty (-2 to 2) */
  presencePenalty?: number;

  /** Stop sequences */
  stopSequences?: string[];

  /** Whether to stream the response */
  stream?: boolean;

  /** Callback for streaming chunks */
  onStreamChunk?: (chunk: string) => void;
}

/**
 * Parameters for tokenization
 */
export interface TokenizeParams {
  /** The text to tokenize */
  prompt: string;

  /** The model whose tokenizer to use */
  modelType?: string;
}

/**
 * Parameters for detokenization
 */
export interface DetokenizeParams {
  /** The tokens to decode */
  tokens: number[];

  /** The model whose tokenizer to use */
  modelType?: string;
}

/**
 * Result of image description/analysis
 */
export interface ImageDescriptionResult {
  /** A title for the image */
  title: string;

  /** A detailed description of the image */
  description: string;
}

/**
 * Result of image generation
 */
export interface ImageGenerationResult {
  /** URL of the generated image */
  url: string;

  /** Revised prompt (if applicable) */
  revisedPrompt?: string;
}

/**
 * Token usage statistics
 */
export interface TokenUsage {
  /** Number of prompt tokens */
  promptTokens: number;

  /** Number of completion tokens */
  completionTokens: number;

  /** Total tokens used */
  totalTokens: number;
}

/**
 * Streaming text result
 */
export interface TextStreamResult {
  /** Async iterable stream of text chunks */
  textStream: AsyncIterable<string>;

  /** Promise resolving to final complete text */
  text: Promise<string>;

  /** Promise resolving to token usage */
  usage: Promise<TokenUsage | undefined>;

  /** Promise resolving to finish reason */
  finishReason: Promise<string | undefined>;
}

/**
 * OpenAI embedding response structure
 */
export interface OpenAIEmbeddingResponse {
  object: "list";
  data: Array<{
    object: "embedding";
    embedding: number[];
    index: number;
  }>;
  model: string;
  usage: {
    prompt_tokens: number;
    total_tokens: number;
  };
}

/**
 * OpenAI chat completion response structure
 */
export interface OpenAIChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: "assistant";
      content: string | null;
    };
    finish_reason: "stop" | "length" | "content_filter" | "tool_calls";
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * OpenAI image generation response structure
 */
export interface OpenAIImageGenerationResponse {
  created: number;
  data: Array<{
    url: string;
    revised_prompt?: string;
  }>;
}

/**
 * OpenAI transcription response structure
 */
export interface OpenAITranscriptionResponse {
  text: string;
  language?: string;
  duration?: number;
  words?: Array<{
    word: string;
    start: number;
    end: number;
  }>;
  segments?: Array<{
    id: number;
    start: number;
    end: number;
    text: string;
  }>;
}

/**
 * OpenAI models list response
 */
export interface OpenAIModelsResponse {
  object: "list";
  data: Array<{
    id: string;
    object: "model";
    created: number;
    owned_by: string;
  }>;
}

/**
 * OpenAI plugin configuration settings
 */
export interface OpenAIPluginConfig {
  /** OpenAI API key */
  OPENAI_API_KEY?: string;

  /** Base URL for API requests */
  OPENAI_BASE_URL?: string;

  /** Small model identifier */
  OPENAI_SMALL_MODEL?: string;

  /** Large model identifier */
  OPENAI_LARGE_MODEL?: string;

  /** Embedding model identifier */
  OPENAI_EMBEDDING_MODEL?: string;

  /** Separate API key for embeddings */
  OPENAI_EMBEDDING_API_KEY?: string;

  /** Separate base URL for embeddings */
  OPENAI_EMBEDDING_URL?: string;

  /** Embedding dimensions */
  OPENAI_EMBEDDING_DIMENSIONS?: string;

  /** Image description model */
  OPENAI_IMAGE_DESCRIPTION_MODEL?: string;

  /** Max tokens for image description */
  OPENAI_IMAGE_DESCRIPTION_MAX_TOKENS?: string;

  /** TTS model */
  OPENAI_TTS_MODEL?: string;

  /** TTS voice */
  OPENAI_TTS_VOICE?: string;

  /** TTS instructions */
  OPENAI_TTS_INSTRUCTIONS?: string;

  /** Enable experimental telemetry */
  OPENAI_EXPERIMENTAL_TELEMETRY?: string;

  /** Browser-only proxy base URL */
  OPENAI_BROWSER_BASE_URL?: string;

  /** Browser-only embedding proxy URL */
  OPENAI_BROWSER_EMBEDDING_URL?: string;

  /** Transcription model */
  OPENAI_TRANSCRIPTION_MODEL?: string;

  /** Image generation model */
  OPENAI_IMAGE_MODEL?: string;

  /** Deep research model (o3-deep-research or o4-mini-deep-research) */
  OPENAI_RESEARCH_MODEL?: string;

  /** Timeout for deep research requests in milliseconds (default: 3600000 = 1 hour) */
  OPENAI_RESEARCH_TIMEOUT?: string;
}

/**
 * Validates that a string is non-empty
 */
export function requireNonEmptyString(value: string, fieldName: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  return trimmed;
}

/**
 * Validates that a number is within a range
 */
export function requireNumberInRange(
  value: number,
  min: number,
  max: number,
  fieldName: string
): number {
  if (!Number.isFinite(value)) {
    throw new Error(`${fieldName} must be a finite number`);
  }
  if (value < min || value > max) {
    throw new Error(`${fieldName} must be between ${min} and ${max}`);
  }
  return value;
}

/**
 * Validates that an array is non-empty
 */
export function requireNonEmptyArray<T>(arr: T[], fieldName: string): T[] {
  if (arr.length === 0) {
    throw new Error(`${fieldName} must be a non-empty array`);
  }
  return arr;
}

/**
 * Validates embedding dimensions
 */
export function validateEmbeddingDimension(
  dimension: number,
  validDimensions: readonly number[]
): number {
  if (!validDimensions.includes(dimension)) {
    throw new Error(
      `Invalid embedding dimension: ${dimension}. Must be one of: ${validDimensions.join(", ")}`
    );
  }
  return dimension;
}
