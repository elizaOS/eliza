import type { IAgentRuntime } from './runtime';

export type ModelTypeName = (typeof ModelType)[keyof typeof ModelType] | string;

/**
 * Defines the recognized types of models that the agent runtime can use.
 * These include models for text generation (small, large, reasoning, completion),
 * text embedding, tokenization (encode/decode), image generation and description,
 * audio transcription, text-to-speech, and generic object generation.
 * This constant is used throughout the system, particularly in `AgentRuntime.useModel`,
 * `AgentRuntime.registerModel`, and in `ModelParamsMap` / `ModelResultMap` to ensure
 * type safety and clarity when working with different AI models.
 * String values are used for extensibility with custom model types.
 */
export const ModelType = {
  SMALL: 'TEXT_SMALL', // kept for backwards compatibility
  MEDIUM: 'TEXT_LARGE', // kept for backwards compatibility
  LARGE: 'TEXT_LARGE', // kept for backwards compatibility
  TEXT_SMALL: 'TEXT_SMALL',
  TEXT_LARGE: 'TEXT_LARGE',
  TEXT_EMBEDDING: 'TEXT_EMBEDDING',
  TEXT_TOKENIZER_ENCODE: 'TEXT_TOKENIZER_ENCODE',
  TEXT_TOKENIZER_DECODE: 'TEXT_TOKENIZER_DECODE',
  TEXT_REASONING_SMALL: 'REASONING_SMALL',
  TEXT_REASONING_LARGE: 'REASONING_LARGE',
  TEXT_COMPLETION: 'TEXT_COMPLETION',
  IMAGE: 'IMAGE',
  IMAGE_DESCRIPTION: 'IMAGE_DESCRIPTION',
  TRANSCRIPTION: 'TRANSCRIPTION',
  TEXT_TO_SPEECH: 'TEXT_TO_SPEECH',
  AUDIO: 'AUDIO',
  VIDEO: 'VIDEO',
  OBJECT_SMALL: 'OBJECT_SMALL',
  OBJECT_LARGE: 'OBJECT_LARGE',
} as const;

/**
 * Union type of all text generation model types.
 * These models accept GenerateTextParams
 */
export type TextGenerationModelType =
  | typeof ModelType.TEXT_SMALL
  | typeof ModelType.TEXT_LARGE
  | typeof ModelType.TEXT_REASONING_SMALL
  | typeof ModelType.TEXT_REASONING_LARGE
  | typeof ModelType.TEXT_COMPLETION;

/**
 * Model configuration setting keys used in character settings.
 * These constants define the keys for accessing model parameters
 * from character configuration with support for per-model-type settings.
 *
 * Setting Precedence (highest to lowest):
 * 1. Parameters passed directly to useModel()
 * 2. Model-specific settings (e.g., TEXT_SMALL_TEMPERATURE)
 * 3. Default settings (e.g., DEFAULT_TEMPERATURE)
 *
 * Example character settings:
 * ```
 * settings: {
 *   DEFAULT_TEMPERATURE: 0.7,              // Applies to all models
 *   TEXT_SMALL_TEMPERATURE: 0.5,           // Overrides default for TEXT_SMALL
 *   TEXT_LARGE_MAX_TOKENS: 4096,           // Specific to TEXT_LARGE
 *   OBJECT_SMALL_TEMPERATURE: 0.3,         // Specific to OBJECT_SMALL
 * }
 * ```
 */
export const MODEL_SETTINGS = {
  // Default settings - apply to all model types unless overridden
  DEFAULT_MAX_TOKENS: 'DEFAULT_MAX_TOKENS',
  DEFAULT_TEMPERATURE: 'DEFAULT_TEMPERATURE',
  DEFAULT_TOP_P: 'DEFAULT_TOP_P',
  DEFAULT_TOP_K: 'DEFAULT_TOP_K',
  DEFAULT_MIN_P: 'DEFAULT_MIN_P',
  DEFAULT_SEED: 'DEFAULT_SEED',
  DEFAULT_REPETITION_PENALTY: 'DEFAULT_REPETITION_PENALTY',
  DEFAULT_FREQUENCY_PENALTY: 'DEFAULT_FREQUENCY_PENALTY',
  DEFAULT_PRESENCE_PENALTY: 'DEFAULT_PRESENCE_PENALTY',

  // TEXT_SMALL specific settings
  TEXT_SMALL_MAX_TOKENS: 'TEXT_SMALL_MAX_TOKENS',
  TEXT_SMALL_TEMPERATURE: 'TEXT_SMALL_TEMPERATURE',
  TEXT_SMALL_TOP_P: 'TEXT_SMALL_TOP_P',
  TEXT_SMALL_TOP_K: 'TEXT_SMALL_TOP_K',
  TEXT_SMALL_MIN_P: 'TEXT_SMALL_MIN_P',
  TEXT_SMALL_SEED: 'TEXT_SMALL_SEED',
  TEXT_SMALL_REPETITION_PENALTY: 'TEXT_SMALL_REPETITION_PENALTY',
  TEXT_SMALL_FREQUENCY_PENALTY: 'TEXT_SMALL_FREQUENCY_PENALTY',
  TEXT_SMALL_PRESENCE_PENALTY: 'TEXT_SMALL_PRESENCE_PENALTY',

  // TEXT_LARGE specific settings
  TEXT_LARGE_MAX_TOKENS: 'TEXT_LARGE_MAX_TOKENS',
  TEXT_LARGE_TEMPERATURE: 'TEXT_LARGE_TEMPERATURE',
  TEXT_LARGE_TOP_P: 'TEXT_LARGE_TOP_P',
  TEXT_LARGE_TOP_K: 'TEXT_LARGE_TOP_K',
  TEXT_LARGE_MIN_P: 'TEXT_LARGE_MIN_P',
  TEXT_LARGE_SEED: 'TEXT_LARGE_SEED',
  TEXT_LARGE_REPETITION_PENALTY: 'TEXT_LARGE_REPETITION_PENALTY',
  TEXT_LARGE_FREQUENCY_PENALTY: 'TEXT_LARGE_FREQUENCY_PENALTY',
  TEXT_LARGE_PRESENCE_PENALTY: 'TEXT_LARGE_PRESENCE_PENALTY',

  // OBJECT_SMALL specific settings
  OBJECT_SMALL_MAX_TOKENS: 'OBJECT_SMALL_MAX_TOKENS',
  OBJECT_SMALL_TEMPERATURE: 'OBJECT_SMALL_TEMPERATURE',
  OBJECT_SMALL_TOP_P: 'OBJECT_SMALL_TOP_P',
  OBJECT_SMALL_TOP_K: 'OBJECT_SMALL_TOP_K',
  OBJECT_SMALL_MIN_P: 'OBJECT_SMALL_MIN_P',
  OBJECT_SMALL_SEED: 'OBJECT_SMALL_SEED',
  OBJECT_SMALL_REPETITION_PENALTY: 'OBJECT_SMALL_REPETITION_PENALTY',
  OBJECT_SMALL_FREQUENCY_PENALTY: 'OBJECT_SMALL_FREQUENCY_PENALTY',
  OBJECT_SMALL_PRESENCE_PENALTY: 'OBJECT_SMALL_PRESENCE_PENALTY',

  // OBJECT_LARGE specific settings
  OBJECT_LARGE_MAX_TOKENS: 'OBJECT_LARGE_MAX_TOKENS',
  OBJECT_LARGE_TEMPERATURE: 'OBJECT_LARGE_TEMPERATURE',
  OBJECT_LARGE_TOP_P: 'OBJECT_LARGE_TOP_P',
  OBJECT_LARGE_TOP_K: 'OBJECT_LARGE_TOP_K',
  OBJECT_LARGE_MIN_P: 'OBJECT_LARGE_MIN_P',
  OBJECT_LARGE_SEED: 'OBJECT_LARGE_SEED',
  OBJECT_LARGE_REPETITION_PENALTY: 'OBJECT_LARGE_REPETITION_PENALTY',
  OBJECT_LARGE_FREQUENCY_PENALTY: 'OBJECT_LARGE_FREQUENCY_PENALTY',
  OBJECT_LARGE_PRESENCE_PENALTY: 'OBJECT_LARGE_PRESENCE_PENALTY',

  // TEXT_REASONING_SMALL specific settings
  TEXT_REASONING_SMALL_MAX_TOKENS: 'TEXT_REASONING_SMALL_MAX_TOKENS',
  TEXT_REASONING_SMALL_TEMPERATURE: 'TEXT_REASONING_SMALL_TEMPERATURE',
  TEXT_REASONING_SMALL_TOP_P: 'TEXT_REASONING_SMALL_TOP_P',
  TEXT_REASONING_SMALL_TOP_K: 'TEXT_REASONING_SMALL_TOP_K',
  TEXT_REASONING_SMALL_MIN_P: 'TEXT_REASONING_SMALL_MIN_P',
  TEXT_REASONING_SMALL_SEED: 'TEXT_REASONING_SMALL_SEED',
  TEXT_REASONING_SMALL_REPETITION_PENALTY: 'TEXT_REASONING_SMALL_REPETITION_PENALTY',
  TEXT_REASONING_SMALL_FREQUENCY_PENALTY: 'TEXT_REASONING_SMALL_FREQUENCY_PENALTY',
  TEXT_REASONING_SMALL_PRESENCE_PENALTY: 'TEXT_REASONING_SMALL_PRESENCE_PENALTY',

  // TEXT_REASONING_LARGE specific settings
  TEXT_REASONING_LARGE_MAX_TOKENS: 'TEXT_REASONING_LARGE_MAX_TOKENS',
  TEXT_REASONING_LARGE_TEMPERATURE: 'TEXT_REASONING_LARGE_TEMPERATURE',
  TEXT_REASONING_LARGE_TOP_P: 'TEXT_REASONING_LARGE_TOP_P',
  TEXT_REASONING_LARGE_TOP_K: 'TEXT_REASONING_LARGE_TOP_K',
  TEXT_REASONING_LARGE_MIN_P: 'TEXT_REASONING_LARGE_MIN_P',
  TEXT_REASONING_LARGE_SEED: 'TEXT_REASONING_LARGE_SEED',
  TEXT_REASONING_LARGE_REPETITION_PENALTY: 'TEXT_REASONING_LARGE_REPETITION_PENALTY',
  TEXT_REASONING_LARGE_FREQUENCY_PENALTY: 'TEXT_REASONING_LARGE_FREQUENCY_PENALTY',
  TEXT_REASONING_LARGE_PRESENCE_PENALTY: 'TEXT_REASONING_LARGE_PRESENCE_PENALTY',

  // TEXT_COMPLETION specific settings
  TEXT_COMPLETION_MAX_TOKENS: 'TEXT_COMPLETION_MAX_TOKENS',
  TEXT_COMPLETION_TEMPERATURE: 'TEXT_COMPLETION_TEMPERATURE',
  TEXT_COMPLETION_TOP_P: 'TEXT_COMPLETION_TOP_P',
  TEXT_COMPLETION_TOP_K: 'TEXT_COMPLETION_TOP_K',
  TEXT_COMPLETION_MIN_P: 'TEXT_COMPLETION_MIN_P',
  TEXT_COMPLETION_SEED: 'TEXT_COMPLETION_SEED',
  TEXT_COMPLETION_REPETITION_PENALTY: 'TEXT_COMPLETION_REPETITION_PENALTY',
  TEXT_COMPLETION_FREQUENCY_PENALTY: 'TEXT_COMPLETION_FREQUENCY_PENALTY',
  TEXT_COMPLETION_PRESENCE_PENALTY: 'TEXT_COMPLETION_PRESENCE_PENALTY',
  // Legacy keys for backwards compatibility (will be treated as defaults)
  MODEL_MAX_TOKEN: 'MODEL_MAX_TOKEN',
  MODEL_TEMPERATURE: 'MODEL_TEMPERATURE',
  MODEL_FREQ_PENALTY: 'MODEL_FREQ_PENALTY',
  MODEL_PRESENCE_PENALTY: 'MODEL_PRESENCE_PENALTY',
} as const;

/**
 * Parameters for generating text using a language model.
 * This structure is typically passed to `AgentRuntime.useModel` when the `modelType` is one of
 * `ModelType.TEXT_SMALL`, `ModelType.TEXT_LARGE`, `ModelType.TEXT_REASONING_SMALL`,
 * `ModelType.TEXT_REASONING_LARGE`, or `ModelType.TEXT_COMPLETION`.
 * It includes essential information like the prompt and various generation controls.
 *
 * **Note for Plugin Implementers**: Different LLM providers have varying support for these parameters.
 * Some providers may not support both `temperature` and `topP` simultaneously, or may have other restrictions.
 * Plugin implementations should filter out unsupported parameters before calling their provider's API.
 * Check your provider's documentation to determine which parameters are supported.
 */
export type GenerateTextParams = {
  /** The input string or prompt that the language model will use to generate text. */
  prompt: string;
  /** Optional. The maximum number of tokens to generate in the response. */
  maxTokens?: number;
  /** Optional. The minimum number of tokens to generate in the response. */
  minTokens?: number;
  /** Optional. Controls randomness (0.0-1.0). Lower values are more deterministic, higher are more creative. */
  temperature?: number;
  /** Optional. Nucleus sampling parameter (0.0-1.0). Controls diversity via nucleus sampling.
   * Note: Some providers may not support both `temperature` and `topP` simultaneously.
   * Plugin implementations should filter based on provider capabilities. */
  topP?: number;
  /** Optional. Limits the number of highest-probability tokens considered at each step.
   * Common in Ollama, vLLM, and other local model providers. Alternative/complement to topP. */
  topK?: number;
  /** Optional. Minimum probability threshold (0.0-1.0). Discards tokens with probability below this threshold.
   * Common in node-llama-cpp. Can improve output quality when using higher temperatures by filtering low-probability tokens. */
  minP?: number;
  /** Optional. Random seed for reproducible outputs. Useful for testing and debugging. */
  seed?: number;
  /** Optional. Repetition penalty (1.0 = no penalty, >1.0 reduces repetition).
   * Common in Ollama, vLLM, and some Hugging Face models. */
  repetitionPenalty?: number;
  /** Optional. Penalizes new tokens based on their existing frequency in the text so far. */
  frequencyPenalty?: number;
  /** Optional. Penalizes new tokens based on whether they appear in the text so far. */
  presencePenalty?: number;
  /** Optional. A list of sequences at which the model will stop generating further tokens. */
  stopSequences?: string[];
  /** Optional. User identifier for tracking and analytics purposes.
   *
   * This parameter is used by LLM providers (e.g., OpenAI) to track and monitor API usage per user.
   * It helps providers identify abuse patterns, implement rate limiting, and provide usage analytics.
   *
   * Behavior:
   * - If not provided (undefined), will automatically default to the agent's character name
   * - If explicitly set to empty string (""), it will be preserved (not overridden)
   * - If explicitly set to null, it will be preserved (not overridden)
   *
   * Examples:
   * - `user: "alice"` - Tracks requests from user "alice"
   * - `user: ""` - Explicitly sends empty user identifier
   * - `user: undefined` - Auto-populates with character name (e.g., "MyAgent")
   *
   * Note: Plugin implementations should pass this parameter to their provider's API when supported.
   */
  user?: string | null;
  /** Optional. Response format specification. Forces the model to return a specific format (e.g., JSON).
   * Common formats: 'json_object' (OpenAI), 'text'. Plugin implementations should map this to provider-specific formats. */
  responseFormat?: { type: 'json_object' | 'text' } | string;
  /**
   * Enable or disable streaming mode.
   * - `true`: Force streaming (requires onStreamChunk or context)
   * - `false`: Force non-streaming even if callback exists
   * - `undefined`: Auto (streams if onStreamChunk or context exists)
   */
  stream?: boolean;
  /**
   * Optional. Callback function for receiving streaming chunks.
   * When provided, streaming is automatically enabled and chunks are sent to this callback.
   *
   * @example
   * ```typescript
   * const text = await runtime.useModel(ModelType.TEXT_LARGE, {
   *   prompt: "Hello",
   *   onStreamChunk: (chunk) => process.stdout.write(chunk)
   * });
   * ```
   */
  onStreamChunk?: (chunk: string, messageId?: string) => void | Promise<void>;
};

/**
 * Token usage information from a model response.
 * Provides metrics about token consumption for billing and monitoring.
 */
export interface TokenUsage {
  /** Number of tokens in the input prompt */
  promptTokens: number;
  /** Number of tokens in the generated response */
  completionTokens: number;
  /** Total tokens used (promptTokens + completionTokens) */
  totalTokens: number;
}

/**
 * Represents a single chunk in a text stream.
 * Each chunk contains a piece of the generated text.
 */
export interface TextStreamChunk {
  /** The text content of this chunk */
  text: string;
  /** Whether this is the final chunk in the stream */
  done: boolean;
}

/**
 * Result of a streaming text generation request.
 * Provides an async iterable for consuming text chunks as they arrive.
 *
 * @example
 * ```typescript
 * const result = await runtime.useModel(ModelType.TEXT_LARGE, {
 *   prompt: "Hello",
 *   stream: true
 * }) as TextStreamResult;
 *
 * let fullText = '';
 * for await (const chunk of result.textStream) {
 *   fullText += chunk;
 *   console.log('Received:', chunk);
 * }
 *
 * // After stream completes
 * const usage = await result.usage;
 * console.log('Total tokens:', usage.totalTokens);
 * ```
 */
export interface TextStreamResult {
  /**
   * Async iterable that yields text chunks as they are generated.
   * Each iteration provides a string chunk of the response.
   */
  textStream: AsyncIterable<string>;

  /**
   * Promise that resolves to the complete text after streaming finishes.
   * Useful when you need the full response after streaming.
   */
  text: Promise<string>;

  /**
   * Promise that resolves to token usage information after streaming completes.
   * May be undefined if the provider doesn't report usage for streaming.
   */
  usage: Promise<TokenUsage | undefined>;

  /**
   * Promise that resolves to the finish reason after streaming completes.
   * Common values: 'stop', 'length', 'content-filter'
   */
  finishReason: Promise<string | undefined>;
}

/**
 * Options for the simplified generateText API.
 * Extends GenerateTextParams with additional configuration for character context.
 */
export interface GenerateTextOptions extends Omit<GenerateTextParams, 'prompt'> {
  /**
   * Whether to include character personality in the prompt.
   */
  includeCharacter?: boolean;
  /**
   * The model type to use for text generation.
   */
  modelType?: TextGenerationModelType;
}

/**
 * Structured response from text generation.
 */
export interface GenerateTextResult {
  /** The generated text response from the model */
  text: string;
}

/**
 * Parameters for text tokenization models
 */
export interface TokenizeTextParams {
  /** The text to tokenize */
  prompt: string;
  /** The model type to use for tokenization */
  modelType: ModelTypeName;
}

/**
 * Parameters for detokenizing text, i.e., converting a sequence of numerical tokens back into a string.
 * This is the reverse operation of tokenization.
 * This structure is used with `AgentRuntime.useModel` when the `modelType` is `ModelType.TEXT_TOKENIZER_DECODE`.
 */
export interface DetokenizeTextParams {
  /** An array of numerical tokens to be converted back into text. */
  tokens: number[];
  /** The model type used for detokenization, ensuring consistency with the original tokenization. */
  modelType: ModelTypeName;
}

/**
 * Parameters for text embedding models
 */
export interface TextEmbeddingParams {
  /** The text to create embeddings for */
  text: string;
}

/**
 * Parameters for image generation models
 */
export interface ImageGenerationParams {
  /** The prompt describing the image to generate */
  prompt: string;
  /** The dimensions of the image to generate */
  size?: string;
  /** Number of images to generate */
  count?: number;
}

/**
 * Parameters for image description models
 */
export interface ImageDescriptionParams {
  /** The URL or path of the image to describe */
  imageUrl: string;
  /** Optional prompt to guide the description */
  prompt?: string;
}

/**
 * Parameters for transcription models
 */
export interface TranscriptionParams {
  /** The URL or path of the audio file to transcribe */
  audioUrl: string;
  /** Optional prompt to guide transcription */
  prompt?: string;
}

/**
 * Parameters for text-to-speech models
 */
export interface TextToSpeechParams {
  /** The text to convert to speech */
  text: string;
  /** The voice to use */
  voice?: string;
  /** The speaking speed */
  speed?: number;
}

/**
 * Parameters for audio processing models
 */
export interface AudioProcessingParams {
  /** The URL or path of the audio file to process */
  audioUrl: string;
  /** The type of audio processing to perform */
  processingType: string;
}

/**
 * Parameters for video processing models
 */
export interface VideoProcessingParams {
  /** The URL or path of the video file to process */
  videoUrl: string;
  /** The type of video processing to perform */
  processingType: string;
}

/**
 * Optional JSON schema for validating generated objects
 */
export type JSONSchema = {
  type: string;
  properties?: Record<string, JSONSchema | { type: string }>;
  required?: string[];
  items?: JSONSchema;
  [key: string]: unknown;
};

/**
 * Parameters for object generation models
 * @template T - The expected return type, inferred from schema if provided
 */
export interface ObjectGenerationParams {
  /** The prompt describing the object to generate */
  prompt: string;
  /** Optional JSON schema for validation */
  schema?: JSONSchema;
  /** Type of object to generate */
  output?: 'object' | 'array' | 'enum';
  /** For enum type, the allowed values */
  enumValues?: string[];
  /** Model type to use */
  modelType?: ModelTypeName;
  /** Model temperature (0.0 to 1.0) */
  temperature?: number;
  /** Sequences that should stop generation */
  stopSequences?: string[];
}

/**
 * Map of model types to their parameter types
 */
export interface ModelParamsMap {
  [ModelType.TEXT_SMALL]: GenerateTextParams;
  [ModelType.TEXT_LARGE]: GenerateTextParams;
  [ModelType.TEXT_EMBEDDING]: TextEmbeddingParams | string | null;
  [ModelType.TEXT_TOKENIZER_ENCODE]: TokenizeTextParams;
  [ModelType.TEXT_TOKENIZER_DECODE]: DetokenizeTextParams;
  [ModelType.TEXT_REASONING_SMALL]: GenerateTextParams;
  [ModelType.TEXT_REASONING_LARGE]: GenerateTextParams;
  [ModelType.IMAGE]: ImageGenerationParams;
  [ModelType.IMAGE_DESCRIPTION]: ImageDescriptionParams | string;
  [ModelType.TRANSCRIPTION]: TranscriptionParams | Buffer | string;
  [ModelType.TEXT_TO_SPEECH]: TextToSpeechParams | string;
  [ModelType.AUDIO]: AudioProcessingParams;
  [ModelType.VIDEO]: VideoProcessingParams;
  [ModelType.OBJECT_SMALL]: ObjectGenerationParams;
  [ModelType.OBJECT_LARGE]: ObjectGenerationParams;
  [ModelType.TEXT_COMPLETION]: GenerateTextParams;
  // Custom model types should be registered via runtime.registerModel() in plugin init()
}

/**
 * Map of model types to their DEFAULT return value types.
 *
 * Note: For text generation models (TEXT_SMALL, TEXT_LARGE, TEXT_REASONING_*),
 * the actual return type depends on the parameters and is handled by overloads:
 * - `{ prompt }`: Returns `string` (this default)
 * - `{ prompt, stream: true }`: Returns `TextStreamResult` (via overload)
 *
 * The overloads in IAgentRuntime.useModel() provide the correct type inference.
 */
export interface ModelResultMap {
  [ModelType.TEXT_SMALL]: string;
  [ModelType.TEXT_LARGE]: string;
  [ModelType.TEXT_EMBEDDING]: number[];
  [ModelType.TEXT_TOKENIZER_ENCODE]: number[];
  [ModelType.TEXT_TOKENIZER_DECODE]: string;
  [ModelType.TEXT_REASONING_SMALL]: string;
  [ModelType.TEXT_REASONING_LARGE]: string;
  [ModelType.IMAGE]: { url: string }[];
  [ModelType.IMAGE_DESCRIPTION]: { title: string; description: string };
  [ModelType.TRANSCRIPTION]: string;
  [ModelType.TEXT_TO_SPEECH]: Buffer | ArrayBuffer | Uint8Array;
  [ModelType.AUDIO]: Buffer | ArrayBuffer | Uint8Array | Record<string, unknown>;
  [ModelType.VIDEO]: Buffer | ArrayBuffer | Uint8Array | Record<string, unknown>;
  [ModelType.OBJECT_SMALL]: Record<string, unknown>;
  [ModelType.OBJECT_LARGE]: Record<string, unknown>;
  [ModelType.TEXT_COMPLETION]: string;
  // Custom model types should be registered via runtime.registerModel() in plugin init()
}

/**
 * Models that support streaming - their handlers can return either string or TextStreamResult
 */
export type StreamableModelType =
  | typeof ModelType.TEXT_SMALL
  | typeof ModelType.TEXT_LARGE
  | typeof ModelType.TEXT_REASONING_SMALL
  | typeof ModelType.TEXT_REASONING_LARGE
  | typeof ModelType.TEXT_COMPLETION;

/**
 * Result type for plugin model handlers - includes TextStreamResult for streamable models
 */
export type PluginModelResult<K extends keyof ModelResultMap> = K extends StreamableModelType
  ? ModelResultMap[K] | TextStreamResult
  : ModelResultMap[K];

/**
 * Type guard to check if a model type supports streaming.
 */
export function isStreamableModelType(modelType: ModelTypeName): boolean {
  return [
    ModelType.TEXT_SMALL,
    ModelType.TEXT_LARGE,
    ModelType.TEXT_REASONING_SMALL,
    ModelType.TEXT_REASONING_LARGE,
    ModelType.TEXT_COMPLETION,
  ].includes(modelType as any);
}

/**
 * Defines the structure for a model handler registration within the `AgentRuntime`.
 * Each model (e.g., for text generation, embedding) is associated with a handler function,
 * the name of the provider (plugin or system) that registered it, and an optional priority.
 * The `priority` (higher is more preferred) helps in selecting which handler to use if multiple
 * handlers are registered for the same model type. The `registrationOrder` (not in type, but used in runtime)
 * serves as a tie-breaker. See `AgentRuntime.registerModel` and `AgentRuntime.getModel`.
 */
export interface ModelHandler<TParams = Record<string, unknown>, TResult = unknown> {
  /** The function that executes the model, taking runtime and parameters, and returning a Promise. */
  handler: (runtime: IAgentRuntime, params: TParams) => Promise<TResult>;
  /** The name of the provider (e.g., plugin name) that registered this model handler. */
  provider: string;
  /**
   * Optional priority for this model handler. Higher numbers indicate higher priority.
   * This is used by `AgentRuntime.getModel` to select the most appropriate handler
   * when multiple are available for a given model type. Defaults to 0 if not specified.
   */
  priority?: number; // Optional priority for selection order

  registrationOrder?: number;
}
