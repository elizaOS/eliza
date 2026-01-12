import type { Memory } from "./memory";
import type { Content } from "./primitives";
import type { IAgentRuntime } from "./runtime";
import type { ActionPlan, State } from "./state";

/**
 * JSON Schema type for action parameter validation.
 * Supports basic JSON Schema properties for parameter definition.
 */
export type ActionParameterSchema = {
  /** The JSON Schema type (string, number, boolean, object, array) */
  type: "string" | "number" | "boolean" | "object" | "array";
  /** Description of the parameter for LLM guidance */
  description?: string;
  /** Default value if parameter is not provided */
  default?: string | number | boolean | null;
  /** Allowed values for enum-style parameters */
  enum?: string[];
  /** For object types, define nested properties */
  properties?: Record<string, ActionParameterSchema>;
  /** For array types, define the item schema */
  items?: ActionParameterSchema;
  /** Minimum value for numbers */
  minimum?: number;
  /** Maximum value for numbers */
  maximum?: number;
  /** Pattern for string validation (regex) */
  pattern?: string;
};

/**
 * Defines a single parameter for an action.
 * Parameters are extracted from the conversation by the LLM and passed to the action handler.
 */
export interface ActionParameter {
  /** Parameter name (used as the key in the parameters object) */
  name: string;
  /** Human-readable description for LLM guidance */
  description: string;
  /** Whether this parameter is required (default: false) */
  required?: boolean;
  /** JSON Schema for parameter validation */
  schema: ActionParameterSchema;
}

/**
 * Primitive value types that can be used in action parameters.
 */
export type ActionParameterValue = string | number | boolean | null;

/**
 * Validated parameters passed to an action handler.
 * Keys are parameter names, values are the validated parameter values.
 * Supports nested objects and arrays for complex parameter structures.
 */
export interface ActionParameters {
  [key: string]:
    | ActionParameterValue
    | ActionParameters
    | ActionParameterValue[]
    | ActionParameters[];
}

/**
 * Example content with associated user for demonstration purposes
 */
export interface ActionExample {
  /** User associated with the example */
  name: string;

  /** Content of the example */
  content: Content;
}

/**
 * Callback function type for handlers
 */
export type HandlerCallback = (response: Content) => Promise<Memory[]>;

/**
 * Handler function type for processing messages
 */
export type Handler = (
  runtime: IAgentRuntime,
  message: Memory,
  state?: State,
  options?: HandlerOptions,
  callback?: HandlerCallback,
  responses?: Memory[],
) => Promise<ActionResult | undefined>;

/**
 * Validator function type for actions/evaluators
 */
export type Validator = (
  runtime: IAgentRuntime,
  message: Memory,
  state?: State,
) => Promise<boolean>;

/**
 * Represents an action the agent can perform
 */
export interface Action {
  /** Action name */
  name: string;

  /** Detailed description */
  description: string;

  /** Handler function */
  handler: Handler;

  /** Validation function */
  validate: Validator;

  /** Similar action descriptions */
  similes?: string[];

  /** Example usages */
  examples?: ActionExample[][];

  /** Optional priority for action ordering */
  priority?: number;

  /** Optional tags for categorization */
  tags?: string[];

  /**
   * Optional input parameters for the action.
   * When defined, the LLM will be prompted to extract these parameters from the conversation
   * and they will be validated before being passed to the handler via HandlerOptions.parameters.
   *
   * Parameters can be required or optional. Optional parameters may have defaults
   * or can be backfilled inside the action handler if not provided.
   *
   * @example
   * ```typescript
   * parameters: [
   *   {
   *     name: "targetUser",
   *     description: "The username or ID of the user to send the message to",
   *     required: true,
   *     schema: { type: "string" }
   *   },
   *   {
   *     name: "platform",
   *     description: "The platform to send the message on (telegram, discord, etc)",
   *     required: false,
   *     schema: { type: "string", enum: ["telegram", "discord", "x"], default: "telegram" }
   *   }
   * ]
   * ```
   */
  parameters?: ActionParameter[];
}

/**
 * Example for evaluating agent behavior
 */
export interface EvaluationExample {
  /** Evaluation context */
  prompt: string;

  /** Example messages */
  messages: Array<ActionExample>;

  /** Expected outcome */
  outcome: string;
}

/**
 * Evaluator for assessing agent responses
 */
export interface Evaluator {
  /** Whether to always run */
  alwaysRun?: boolean;

  /** Detailed description */
  description: string;

  /** Similar evaluator descriptions */
  similes?: string[];

  /** Example evaluations */
  examples: EvaluationExample[];

  /** Handler function */
  handler: Handler;

  /** Evaluator name */
  name: string;

  /** Validation function */
  validate: Validator;
}

/**
 * JSON-serializable primitive values.
 * These are the basic types that can be serialized to JSON.
 */
export type JsonPrimitive = string | number | boolean | null;

/**
 * Value types allowed in provider results.
 *
 * This type accepts:
 * - Primitive JSON values (string, number, boolean, null, undefined)
 * - Arrays of values
 * - Any object (Record<string, unknown>)
 *
 * The broad object type (Record<string, unknown>) ensures that domain types
 * like Memory[], Character, Content, etc. are accepted without requiring
 * unsafe 'as unknown as' casts, while still maintaining JSON-serializable
 * semantics at runtime.
 */
export type ProviderValue =
  | JsonPrimitive
  | undefined
  | readonly unknown[]
  | Record<string, unknown>;

/**
 * Data record type that accepts any JSON-serializable values.
 * This is broader than ProviderValue to accommodate domain types
 * like Memory[], Character, Content without requiring casts.
 */
export type ProviderDataRecord = Record<string, unknown>;

/**
 * Result returned by a provider
 */
export interface ProviderResult {
  /** Human-readable text for LLM prompt inclusion */
  text?: string;

  /** Key-value pairs for template variable substitution */
  values?: Record<string, ProviderValue>;

  /**
   * Structured data for programmatic access by other components.
   * Accepts any JSON-serializable object values including domain types
   * like Memory[], Character, Content, etc.
   */
  data?: ProviderDataRecord;
}

/**
 * Provider for external data/services
 */
export interface Provider {
  /** Provider name */
  name: string;

  /** Description of the provider */
  description?: string;

  /** Whether the provider is dynamic */
  dynamic?: boolean;

  /** Position of the provider in the provider list, positive or negative */
  position?: number;

  /**
   * Whether the provider is private
   *
   * Private providers are not displayed in the regular provider list, they have to be called explicitly
   */
  private?: boolean;

  /** Data retrieval function */
  get: (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
  ) => Promise<ProviderResult>;
}

/**
 * Result returned by an action after execution
 * Used for action chaining and state management
 */
export interface ActionResult {
  /** Whether the action succeeded */
  success: boolean;

  /** Optional text description of the result */
  text?: string;

  /** Values to merge into the state */
  values?: Record<string, ProviderValue>;

  /**
   * Data payload containing action-specific results.
   * Accepts any JSON-serializable object values including domain types.
   */
  data?: ProviderDataRecord;

  /** Error information if the action failed */
  error?: string | Error;

  /** Whether to continue the action chain (for chained actions) */
  continueChain?: boolean;

  /** Optional cleanup function to execute after action completion */
  cleanup?: () => void | Promise<void>;
}

/**
 * Context provided to actions during execution
 * Allows actions to access previous results and execution state
 */
export interface ActionContext {
  /** Results from previously executed actions in this run */
  previousResults: ActionResult[];

  /** Get a specific previous result by action name */
  getPreviousResult?: (actionName: string) => ActionResult | undefined;
}

/**
 * Callback for streaming response chunks during action execution.
 * messageId is a string that can be either a UUID or other identifier.
 */
export type StreamChunkCallback = (
  chunk: string,
  messageId?: string,
) => Promise<void>;

/**
 * Options passed to action handlers during execution
 * Provides context about the current execution and multi-step plans
 */
export interface HandlerOptions {
  /** Context with previous action results and utilities */
  actionContext?: ActionContext;

  /** Multi-step action plan information */
  actionPlan?: ActionPlan;

  /** Optional stream chunk callback for streaming responses */
  onStreamChunk?: StreamChunkCallback;

  /**
   * Validated input parameters extracted from the conversation.
   * Only present when the action defines parameters and they were successfully extracted.
   *
   * Parameters are validated against the action's parameter schema before being passed here.
   * Optional parameters may be undefined if not provided in the conversation.
   *
   * @example
   * ```typescript
   * handler: async (runtime, message, state, options) => {
   *   const params = options?.parameters;
   *   if (params) {
   *     const targetUser = params.targetUser as string;
   *     const platform = params.platform as string ?? "telegram"; // backfill default
   *   }
   * }
   * ```
   */
  parameters?: ActionParameters;
}
