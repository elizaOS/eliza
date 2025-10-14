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
  DEFAULT_FREQUENCY_PENALTY: 'DEFAULT_FREQUENCY_PENALTY',
  DEFAULT_PRESENCE_PENALTY: 'DEFAULT_PRESENCE_PENALTY',

  // TEXT_SMALL specific settings
  TEXT_SMALL_MAX_TOKENS: 'TEXT_SMALL_MAX_TOKENS',
  TEXT_SMALL_TEMPERATURE: 'TEXT_SMALL_TEMPERATURE',
  TEXT_SMALL_FREQUENCY_PENALTY: 'TEXT_SMALL_FREQUENCY_PENALTY',
  TEXT_SMALL_PRESENCE_PENALTY: 'TEXT_SMALL_PRESENCE_PENALTY',

  // TEXT_LARGE specific settings
  TEXT_LARGE_MAX_TOKENS: 'TEXT_LARGE_MAX_TOKENS',
  TEXT_LARGE_TEMPERATURE: 'TEXT_LARGE_TEMPERATURE',
  TEXT_LARGE_FREQUENCY_PENALTY: 'TEXT_LARGE_FREQUENCY_PENALTY',
  TEXT_LARGE_PRESENCE_PENALTY: 'TEXT_LARGE_PRESENCE_PENALTY',

  // OBJECT_SMALL specific settings
  OBJECT_SMALL_MAX_TOKENS: 'OBJECT_SMALL_MAX_TOKENS',
  OBJECT_SMALL_TEMPERATURE: 'OBJECT_SMALL_TEMPERATURE',
  OBJECT_SMALL_FREQUENCY_PENALTY: 'OBJECT_SMALL_FREQUENCY_PENALTY',
  OBJECT_SMALL_PRESENCE_PENALTY: 'OBJECT_SMALL_PRESENCE_PENALTY',

  // OBJECT_LARGE specific settings
  OBJECT_LARGE_MAX_TOKENS: 'OBJECT_LARGE_MAX_TOKENS',
  OBJECT_LARGE_TEMPERATURE: 'OBJECT_LARGE_TEMPERATURE',
  OBJECT_LARGE_FREQUENCY_PENALTY: 'OBJECT_LARGE_FREQUENCY_PENALTY',
  OBJECT_LARGE_PRESENCE_PENALTY: 'OBJECT_LARGE_PRESENCE_PENALTY',

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
 */
export type GenerateTextParams = {
  /** The input string or prompt that the language model will use to generate text. */
  prompt: string;
  /** Optional. The maximum number of tokens to generate in the response. */
  maxTokens?: number;
  /** Optional. Controls randomness (0.0-1.0). Lower values are more deterministic, higher are more creative. */
  temperature?: number;
  /** Optional. Penalizes new tokens based on their existing frequency in the text so far. */
  frequencyPenalty?: number;
  /** Optional. Penalizes new tokens based on whether they appear in the text so far. */
  presencePenalty?: number;
  /** Optional. A list of sequences at which the model will stop generating further tokens. */
  stopSequences?: string[];
};

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
  properties?: Record<string, any>;
  required?: string[];
  items?: JSONSchema;
  [key: string]: any;
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
  // Allow string index for custom model types
  [key: string]: any;
}

/**
 * Map of model types to their return value types
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
  [ModelType.TEXT_TO_SPEECH]: any | Buffer;
  [ModelType.AUDIO]: any; // Specific return type depends on processing type
  [ModelType.VIDEO]: any; // Specific return type depends on processing type
  [ModelType.OBJECT_SMALL]: any;
  [ModelType.OBJECT_LARGE]: any;
  // Allow string index for custom model types
  [key: string]: any;
}

/**
 * Defines the structure for a model handler registration within the `AgentRuntime`.
 * Each model (e.g., for text generation, embedding) is associated with a handler function,
 * the name of the provider (plugin or system) that registered it, and an optional priority.
 * The `priority` (higher is more preferred) helps in selecting which handler to use if multiple
 * handlers are registered for the same model type. The `registrationOrder` (not in type, but used in runtime)
 * serves as a tie-breaker. See `AgentRuntime.registerModel` and `AgentRuntime.getModel`.
 */
export interface ModelHandler {
  /** The function that executes the model, taking runtime and parameters, and returning a Promise. */
  handler: (runtime: IAgentRuntime, params: Record<string, unknown>) => Promise<unknown>;
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
