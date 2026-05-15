/**
 * Supported audio formats for transcription
 */
export type AudioFormat = "mp3" | "wav" | "webm" | "ogg" | "flac" | "mp4";

/**
 * Supported response formats for transcription
 */
type TranscriptionResponseFormat = "json" | "text" | "srt" | "verbose_json" | "vtt";

/**
 * Timestamp granularity options for transcription
 */
type TimestampGranularity = "word" | "segment";

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

  /**
   * Prompt tokens read from cache.
   *
   * Historical name kept for back-compat with OpenAI plugin consumers. New
   * code should also read `cacheReadInputTokens` (the canonical v5 trajectory
   * recorder field). The text adapter populates both when the AI SDK reports
   * cached input.
   */
  cachedPromptTokens?: number;

  /**
   * Canonical v5 cache-read field. Mirrors `cachedPromptTokens` for the
   * trajectory recorder + cost table, so consumers that expect either name
   * resolve correctly.
   */
  cacheReadInputTokens?: number;

  /**
   * Canonical v5 cache-creation field. OpenAI does not differentiate cache
   * write currently, so this is reserved for parity with Anthropic adapters.
   */
  cacheCreationInputTokens?: number;
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
    prompt_tokens_details?: {
      cached_tokens?: number;
    };
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
