import type {
  JsonValue,
  AudioProcessingParams as ProtoAudioProcessingParams,
  DetokenizeTextParams as ProtoDetokenizeTextParams,
  GenerateTextOptions as ProtoGenerateTextOptions,
  GenerateTextParams as ProtoGenerateTextParams,
  GenerateTextResult as ProtoGenerateTextResult,
  ImageDescriptionParams as ProtoImageDescriptionParams,
  ImageDescriptionResult as ProtoImageDescriptionResult,
  ImageGenerationParams as ProtoImageGenerationParams,
  ImageGenerationResult as ProtoImageGenerationResult,
  JSONSchema as ProtoJSONSchema,
  ObjectGenerationParams as ProtoObjectGenerationParams,
  TextEmbeddingParams as ProtoTextEmbeddingParams,
  TextStreamChunk as ProtoTextStreamChunk,
  TextToSpeechParams as ProtoTextToSpeechParams,
  TokenizeTextParams as ProtoTokenizeTextParams,
  TokenUsage as ProtoTokenUsage,
  TranscriptionParams as ProtoTranscriptionParams,
  VideoProcessingParams as ProtoVideoProcessingParams,
} from "./proto.js";
import type { IAgentRuntime } from "./runtime";

export type ModelTypeName = (typeof ModelType)[keyof typeof ModelType] | string;

/**
 * LLM Mode for overriding model selection.
 *
 * - `DEFAULT`: Use the model type specified in the useModel call (no override)
 * - `SMALL`: Override all text generation model calls to use TEXT_SMALL
 * - `LARGE`: Override all text generation model calls to use TEXT_LARGE
 *
 * This is useful for cost optimization (force SMALL) or quality (force LARGE).
 * While not recommended for production, it can be a fast way to make the agent run cheaper.
 *
 * @example
 * ```typescript
 * const runtime = new AgentRuntime({
 *   character: myCharacter,
 *   llmMode: LLMMode.SMALL, // All LLM calls will use TEXT_SMALL
 * });
 * ```
 */
export const LLMMode = {
  /** Use the model type as specified in the call (no override) */
  DEFAULT: "DEFAULT",
  /** Override all text generation model calls to use TEXT_SMALL */
  SMALL: "SMALL",
  /** Override all text generation model calls to use TEXT_LARGE */
  LARGE: "LARGE",
} as const;

export type LLMModeType = (typeof LLMMode)[keyof typeof LLMMode];

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
  SMALL: "TEXT_SMALL", // kept for backwards compatibility
  MEDIUM: "TEXT_LARGE", // kept for backwards compatibility
  LARGE: "TEXT_LARGE", // kept for backwards compatibility
  TEXT_SMALL: "TEXT_SMALL",
  TEXT_LARGE: "TEXT_LARGE",
  TEXT_EMBEDDING: "TEXT_EMBEDDING",
  TEXT_TOKENIZER_ENCODE: "TEXT_TOKENIZER_ENCODE",
  TEXT_TOKENIZER_DECODE: "TEXT_TOKENIZER_DECODE",
  TEXT_REASONING_SMALL: "REASONING_SMALL",
  TEXT_REASONING_LARGE: "REASONING_LARGE",
  TEXT_COMPLETION: "TEXT_COMPLETION",
  IMAGE: "IMAGE",
  IMAGE_DESCRIPTION: "IMAGE_DESCRIPTION",
  TRANSCRIPTION: "TRANSCRIPTION",
  TEXT_TO_SPEECH: "TEXT_TO_SPEECH",
  AUDIO: "AUDIO",
  VIDEO: "VIDEO",
  OBJECT_SMALL: "OBJECT_SMALL",
  OBJECT_LARGE: "OBJECT_LARGE",
  RESEARCH: "RESEARCH",
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
  DEFAULT_MAX_TOKENS: "DEFAULT_MAX_TOKENS",
  DEFAULT_TEMPERATURE: "DEFAULT_TEMPERATURE",
  DEFAULT_TOP_P: "DEFAULT_TOP_P",
  DEFAULT_TOP_K: "DEFAULT_TOP_K",
  DEFAULT_MIN_P: "DEFAULT_MIN_P",
  DEFAULT_SEED: "DEFAULT_SEED",
  DEFAULT_REPETITION_PENALTY: "DEFAULT_REPETITION_PENALTY",
  DEFAULT_FREQUENCY_PENALTY: "DEFAULT_FREQUENCY_PENALTY",
  DEFAULT_PRESENCE_PENALTY: "DEFAULT_PRESENCE_PENALTY",

  // TEXT_SMALL specific settings
  TEXT_SMALL_MAX_TOKENS: "TEXT_SMALL_MAX_TOKENS",
  TEXT_SMALL_TEMPERATURE: "TEXT_SMALL_TEMPERATURE",
  TEXT_SMALL_TOP_P: "TEXT_SMALL_TOP_P",
  TEXT_SMALL_TOP_K: "TEXT_SMALL_TOP_K",
  TEXT_SMALL_MIN_P: "TEXT_SMALL_MIN_P",
  TEXT_SMALL_SEED: "TEXT_SMALL_SEED",
  TEXT_SMALL_REPETITION_PENALTY: "TEXT_SMALL_REPETITION_PENALTY",
  TEXT_SMALL_FREQUENCY_PENALTY: "TEXT_SMALL_FREQUENCY_PENALTY",
  TEXT_SMALL_PRESENCE_PENALTY: "TEXT_SMALL_PRESENCE_PENALTY",

  // TEXT_LARGE specific settings
  TEXT_LARGE_MAX_TOKENS: "TEXT_LARGE_MAX_TOKENS",
  TEXT_LARGE_TEMPERATURE: "TEXT_LARGE_TEMPERATURE",
  TEXT_LARGE_TOP_P: "TEXT_LARGE_TOP_P",
  TEXT_LARGE_TOP_K: "TEXT_LARGE_TOP_K",
  TEXT_LARGE_MIN_P: "TEXT_LARGE_MIN_P",
  TEXT_LARGE_SEED: "TEXT_LARGE_SEED",
  TEXT_LARGE_REPETITION_PENALTY: "TEXT_LARGE_REPETITION_PENALTY",
  TEXT_LARGE_FREQUENCY_PENALTY: "TEXT_LARGE_FREQUENCY_PENALTY",
  TEXT_LARGE_PRESENCE_PENALTY: "TEXT_LARGE_PRESENCE_PENALTY",

  // OBJECT_SMALL specific settings
  OBJECT_SMALL_MAX_TOKENS: "OBJECT_SMALL_MAX_TOKENS",
  OBJECT_SMALL_TEMPERATURE: "OBJECT_SMALL_TEMPERATURE",
  OBJECT_SMALL_TOP_P: "OBJECT_SMALL_TOP_P",
  OBJECT_SMALL_TOP_K: "OBJECT_SMALL_TOP_K",
  OBJECT_SMALL_MIN_P: "OBJECT_SMALL_MIN_P",
  OBJECT_SMALL_SEED: "OBJECT_SMALL_SEED",
  OBJECT_SMALL_REPETITION_PENALTY: "OBJECT_SMALL_REPETITION_PENALTY",
  OBJECT_SMALL_FREQUENCY_PENALTY: "OBJECT_SMALL_FREQUENCY_PENALTY",
  OBJECT_SMALL_PRESENCE_PENALTY: "OBJECT_SMALL_PRESENCE_PENALTY",

  // OBJECT_LARGE specific settings
  OBJECT_LARGE_MAX_TOKENS: "OBJECT_LARGE_MAX_TOKENS",
  OBJECT_LARGE_TEMPERATURE: "OBJECT_LARGE_TEMPERATURE",
  OBJECT_LARGE_TOP_P: "OBJECT_LARGE_TOP_P",
  OBJECT_LARGE_TOP_K: "OBJECT_LARGE_TOP_K",
  OBJECT_LARGE_MIN_P: "OBJECT_LARGE_MIN_P",
  OBJECT_LARGE_SEED: "OBJECT_LARGE_SEED",
  OBJECT_LARGE_REPETITION_PENALTY: "OBJECT_LARGE_REPETITION_PENALTY",
  OBJECT_LARGE_FREQUENCY_PENALTY: "OBJECT_LARGE_FREQUENCY_PENALTY",
  OBJECT_LARGE_PRESENCE_PENALTY: "OBJECT_LARGE_PRESENCE_PENALTY",

  // TEXT_REASONING_SMALL specific settings
  TEXT_REASONING_SMALL_MAX_TOKENS: "TEXT_REASONING_SMALL_MAX_TOKENS",
  TEXT_REASONING_SMALL_TEMPERATURE: "TEXT_REASONING_SMALL_TEMPERATURE",
  TEXT_REASONING_SMALL_TOP_P: "TEXT_REASONING_SMALL_TOP_P",
  TEXT_REASONING_SMALL_TOP_K: "TEXT_REASONING_SMALL_TOP_K",
  TEXT_REASONING_SMALL_MIN_P: "TEXT_REASONING_SMALL_MIN_P",
  TEXT_REASONING_SMALL_SEED: "TEXT_REASONING_SMALL_SEED",
  TEXT_REASONING_SMALL_REPETITION_PENALTY:
    "TEXT_REASONING_SMALL_REPETITION_PENALTY",
  TEXT_REASONING_SMALL_FREQUENCY_PENALTY:
    "TEXT_REASONING_SMALL_FREQUENCY_PENALTY",
  TEXT_REASONING_SMALL_PRESENCE_PENALTY:
    "TEXT_REASONING_SMALL_PRESENCE_PENALTY",

  // TEXT_REASONING_LARGE specific settings
  TEXT_REASONING_LARGE_MAX_TOKENS: "TEXT_REASONING_LARGE_MAX_TOKENS",
  TEXT_REASONING_LARGE_TEMPERATURE: "TEXT_REASONING_LARGE_TEMPERATURE",
  TEXT_REASONING_LARGE_TOP_P: "TEXT_REASONING_LARGE_TOP_P",
  TEXT_REASONING_LARGE_TOP_K: "TEXT_REASONING_LARGE_TOP_K",
  TEXT_REASONING_LARGE_MIN_P: "TEXT_REASONING_LARGE_MIN_P",
  TEXT_REASONING_LARGE_SEED: "TEXT_REASONING_LARGE_SEED",
  TEXT_REASONING_LARGE_REPETITION_PENALTY:
    "TEXT_REASONING_LARGE_REPETITION_PENALTY",
  TEXT_REASONING_LARGE_FREQUENCY_PENALTY:
    "TEXT_REASONING_LARGE_FREQUENCY_PENALTY",
  TEXT_REASONING_LARGE_PRESENCE_PENALTY:
    "TEXT_REASONING_LARGE_PRESENCE_PENALTY",

  // TEXT_COMPLETION specific settings
  TEXT_COMPLETION_MAX_TOKENS: "TEXT_COMPLETION_MAX_TOKENS",
  TEXT_COMPLETION_TEMPERATURE: "TEXT_COMPLETION_TEMPERATURE",
  TEXT_COMPLETION_TOP_P: "TEXT_COMPLETION_TOP_P",
  TEXT_COMPLETION_TOP_K: "TEXT_COMPLETION_TOP_K",
  TEXT_COMPLETION_MIN_P: "TEXT_COMPLETION_MIN_P",
  TEXT_COMPLETION_SEED: "TEXT_COMPLETION_SEED",
  TEXT_COMPLETION_REPETITION_PENALTY: "TEXT_COMPLETION_REPETITION_PENALTY",
  TEXT_COMPLETION_FREQUENCY_PENALTY: "TEXT_COMPLETION_FREQUENCY_PENALTY",
  TEXT_COMPLETION_PRESENCE_PENALTY: "TEXT_COMPLETION_PRESENCE_PENALTY",
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
export interface GenerateTextParams
  extends Omit<
    ProtoGenerateTextParams,
    "$typeName" | "$unknown" | "responseFormat" | "stopSequences"
  > {
  responseFormat?: { type: "json_object" | "text" } | string;
  stopSequences?: string[];
  onStreamChunk?: (chunk: string, messageId?: string) => void | Promise<void>;
  user?: string;
}

/**
 * Token usage information from a model response.
 * Provides metrics about token consumption for billing and monitoring.
 */
export interface TokenUsage
  extends Omit<ProtoTokenUsage, "$typeName" | "$unknown"> {}

/**
 * Represents a single chunk in a text stream.
 * Each chunk contains a piece of the generated text.
 */
export interface TextStreamChunk
  extends Omit<ProtoTextStreamChunk, "$typeName" | "$unknown"> {}

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
export interface GenerateTextOptions
  extends Omit<
    ProtoGenerateTextOptions,
    "$typeName" | "$unknown" | "modelType"
  > {
  includeCharacter?: boolean;
  modelType?: TextGenerationModelType;
  minTokens?: number;
  topP?: number;
  topK?: number;
  minP?: number;
  seed?: number;
  repetitionPenalty?: number;
  user?: string;
  responseFormat?: { type: "json_object" | "text" } | string;
}

/**
 * Structured response from text generation.
 */
export interface GenerateTextResult
  extends Omit<ProtoGenerateTextResult, "$typeName" | "$unknown"> {}

/**
 * Parameters for text tokenization models
 */
export interface TokenizeTextParams
  extends Omit<
    ProtoTokenizeTextParams,
    "$typeName" | "$unknown" | "modelType"
  > {
  modelType: ModelTypeName;
}

/**
 * Parameters for detokenizing text, i.e., converting a sequence of numerical tokens back into a string.
 * This is the reverse operation of tokenization.
 * This structure is used with `AgentRuntime.useModel` when the `modelType` is `ModelType.TEXT_TOKENIZER_DECODE`.
 */
export interface DetokenizeTextParams
  extends Omit<
    ProtoDetokenizeTextParams,
    "$typeName" | "$unknown" | "modelType"
  > {
  modelType: ModelTypeName;
}

/**
 * Parameters for text embedding models
 */
export interface TextEmbeddingParams
  extends Omit<ProtoTextEmbeddingParams, "$typeName" | "$unknown"> {}

/**
 * Parameters for image generation models
 */
export interface ImageGenerationParams
  extends Omit<ProtoImageGenerationParams, "$typeName" | "$unknown"> {}

/**
 * Parameters for image description models
 */
export interface ImageDescriptionParams
  extends Omit<ProtoImageDescriptionParams, "$typeName" | "$unknown"> {}
export interface ImageDescriptionResult
  extends Omit<ProtoImageDescriptionResult, "$typeName" | "$unknown"> {}
export interface ImageGenerationResult
  extends Omit<ProtoImageGenerationResult, "$typeName" | "$unknown"> {}

/**
 * Parameters for transcription models
 */
export interface TranscriptionParams
  extends Omit<ProtoTranscriptionParams, "$typeName" | "$unknown"> {}

/**
 * Parameters for text-to-speech models
 */
export interface TextToSpeechParams
  extends Omit<ProtoTextToSpeechParams, "$typeName" | "$unknown"> {}

/**
 * Parameters for audio processing models
 */
export interface AudioProcessingParams
  extends Omit<ProtoAudioProcessingParams, "$typeName" | "$unknown"> {}

/**
 * Parameters for video processing models
 */
export interface VideoProcessingParams
  extends Omit<ProtoVideoProcessingParams, "$typeName" | "$unknown"> {}

// ============================================================================
// Research Model Types (Deep Research)
// ============================================================================

/**
 * Research tool configuration for web search
 */
export interface ResearchWebSearchTool {
  type: "web_search_preview";
}

/**
 * Research tool configuration for file search over vector stores
 */
export interface ResearchFileSearchTool {
  type: "file_search";
  /** Array of vector store IDs to search (max 2) */
  vectorStoreIds: string[];
}

/**
 * Research tool configuration for code interpreter
 */
export interface ResearchCodeInterpreterTool {
  type: "code_interpreter";
  /** Container configuration */
  container?: { type: "auto" };
}

/**
 * Research tool configuration for remote MCP servers.
 * MCP servers must implement a search/fetch interface for deep research compatibility.
 */
export interface ResearchMcpTool {
  type: "mcp";
  /** Label to identify the MCP server */
  serverLabel: string;
  /** URL of the remote MCP server */
  serverUrl: string;
  /** Approval mode - must be "never" for deep research */
  requireApproval?: "never";
}

/**
 * Union type for all supported research tools
 */
export type ResearchTool =
  | ResearchWebSearchTool
  | ResearchFileSearchTool
  | ResearchCodeInterpreterTool
  | ResearchMcpTool;

/**
 * Parameters for deep research models (o3-deep-research, o4-mini-deep-research).
 *
 * Deep research models can find, analyze, and synthesize hundreds of sources
 * to create comprehensive reports. They support web search, file search over
 * vector stores, and remote MCP servers as data sources.
 *
 * @example
 * ```typescript
 * const result = await runtime.useModel(ModelType.RESEARCH, {
 *   input: "Research the economic impact of AI on global labor markets",
 *   tools: [
 *     { type: "web_search_preview" },
 *     { type: "code_interpreter", container: { type: "auto" } }
 *   ],
 *   background: true,
 * });
 * ```
 */
export interface ResearchParams {
  /**
   * The research input/question.
   * Should be a detailed, specific question for best results.
   */
  input: string;

  /**
   * Optional instructions to guide the research process.
   * Can include formatting requirements, source preferences, etc.
   */
  instructions?: string;

  /**
   * Whether to run the request in background mode.
   * Recommended for long-running research tasks (can take tens of minutes).
   * When true, the request returns immediately and results can be polled.
   * @default false
   */
  background?: boolean;

  /**
   * Array of tools/data sources for the research model.
   * Must include at least one data source: web_search_preview, file_search, or mcp.
   * Can also include code_interpreter for data analysis.
   */
  tools?: ResearchTool[];

  /**
   * Maximum number of tool calls the model can make.
   * Use this to control cost and latency.
   */
  maxToolCalls?: number;

  /**
   * Whether to include reasoning summary in the response.
   * @default "auto"
   */
  reasoningSummary?: "auto" | "none";

  /**
   * Model variant to use.
   * @default "o3-deep-research"
   */
  model?: "o3-deep-research" | "o4-mini-deep-research";
}

/**
 * Annotation in research results, linking text to sources
 */
export interface ResearchAnnotation {
  /** URL of the source */
  url: string;
  /** Title of the source */
  title: string;
  /** Start index in the text where this citation appears */
  startIndex: number;
  /** End index in the text where this citation ends */
  endIndex: number;
}

/**
 * Web search action taken by the research model
 */
export interface ResearchWebSearchCall {
  id: string;
  type: "web_search_call";
  status: "completed" | "failed";
  action: {
    type: "search" | "open_page" | "find_in_page";
    query?: string;
    url?: string;
  };
}

/**
 * File search action taken over vector stores
 */
export interface ResearchFileSearchCall {
  id: string;
  type: "file_search_call";
  status: "completed" | "failed";
  query: string;
  results?: Array<{
    fileId: string;
    fileName: string;
    score: number;
  }>;
}

/**
 * Code interpreter action for data analysis
 */
export interface ResearchCodeInterpreterCall {
  id: string;
  type: "code_interpreter_call";
  status: "completed" | "failed";
  code: string;
  output?: string;
}

/**
 * MCP tool call made to a remote server
 */
export interface ResearchMcpToolCall {
  id: string;
  type: "mcp_tool_call";
  status: "completed" | "failed";
  serverLabel: string;
  toolName: string;
  arguments: Record<string, JsonValue>;
  result?: JsonValue;
}

/**
 * Final message output from research
 */
export interface ResearchMessageOutput {
  type: "message";
  content: Array<{
    type: "output_text";
    text: string;
    annotations: ResearchAnnotation[];
  }>;
}

/**
 * Union type for all research output items
 */
export type ResearchOutputItem =
  | ResearchWebSearchCall
  | ResearchFileSearchCall
  | ResearchCodeInterpreterCall
  | ResearchMcpToolCall
  | ResearchMessageOutput;

/**
 * Result from a deep research model request
 */
export interface ResearchResult {
  /** Unique identifier for the response */
  id: string;

  /** The final research report text with inline citations */
  text: string;

  /** Annotations linking text to sources - should be displayed as clickable links */
  annotations: ResearchAnnotation[];

  /**
   * Output items showing the research process.
   * Includes web searches, file searches, code execution, and MCP calls.
   */
  outputItems: ResearchOutputItem[];

  /**
   * For background requests, the current status
   */
  status?: "queued" | "in_progress" | "completed" | "failed";
}

/**
 * Optional JSON schema for validating generated objects
 */
export interface JSONSchema
  extends Omit<
    ProtoJSONSchema,
    "$typeName" | "$unknown" | "type" | "properties" | "items" | "required"
  > {
  type?: string | string[];
  properties?: Record<string, JSONSchema>;
  items?: JSONSchema | JSONSchema[];
  required?: string[];
  [key: string]: JsonValue | JSONSchema | JSONSchema[] | undefined;
}

/**
 * Parameters for object generation models
 * @template T - The expected return type, inferred from schema if provided
 */
export interface ObjectGenerationParams
  extends Omit<
    ProtoObjectGenerationParams,
    | "$typeName"
    | "$unknown"
    | "modelType"
    | "schema"
    | "enumValues"
    | "stopSequences"
  > {
  schema?: JSONSchema;
  modelType?: ModelTypeName;
  enumValues?: string[];
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
  [ModelType.RESEARCH]: ResearchParams;
  // Custom model types should be registered via runtime.registerModel() in plugin init()
}

/**
 * Map of model types to their DEFAULT return value types.
 *
 * For text generation models (TEXT_SMALL, TEXT_LARGE, TEXT_REASONING_*),
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
  [ModelType.IMAGE]: ImageGenerationResult[];
  [ModelType.IMAGE_DESCRIPTION]: ImageDescriptionResult;
  [ModelType.TRANSCRIPTION]: string;
  [ModelType.TEXT_TO_SPEECH]: Buffer | ArrayBuffer | Uint8Array;
  [ModelType.AUDIO]:
    | Buffer
    | ArrayBuffer
    | Uint8Array
    | Record<string, JsonValue>;
  [ModelType.VIDEO]:
    | Buffer
    | ArrayBuffer
    | Uint8Array
    | Record<string, JsonValue>;
  [ModelType.OBJECT_SMALL]: Record<string, JsonValue>;
  [ModelType.OBJECT_LARGE]: Record<string, JsonValue>;
  [ModelType.TEXT_COMPLETION]: string;
  [ModelType.RESEARCH]: ResearchResult;
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
export type PluginModelResult<K extends keyof ModelResultMap> =
  K extends StreamableModelType
    ? ModelResultMap[K] | TextStreamResult
    : ModelResultMap[K];

/**
 * Type guard to check if a model type supports streaming.
 */
const STREAMABLE_MODEL_TYPES: ReadonlySet<string> = new Set([
  ModelType.TEXT_SMALL,
  ModelType.TEXT_LARGE,
  ModelType.TEXT_REASONING_SMALL,
  ModelType.TEXT_REASONING_LARGE,
  ModelType.TEXT_COMPLETION,
]);

export function isStreamableModelType(
  modelType: ModelTypeName,
): modelType is StreamableModelType {
  return STREAMABLE_MODEL_TYPES.has(modelType);
}

/**
 * Defines the structure for a model handler registration within the `AgentRuntime`.
 * Each model (e.g., for text generation, embedding) is associated with a handler function,
 * the name of the provider (plugin or system) that registered it, and an optional priority.
 * The `priority` (higher is more preferred) helps in selecting which handler to use if multiple
 * handlers are registered for the same model type. The `registrationOrder` (not in type, but used in runtime)
 * serves as a tie-breaker. See `AgentRuntime.registerModel` and `AgentRuntime.getModel`.
 */
export interface ModelHandler<
  TParams = Record<string, JsonValue | object>,
  TResult = JsonValue | object,
> {
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
