import type { Memory } from "./memory";
import type { Content } from "./primitives";
import type {
  JsonValue,
  ActionExample as ProtoActionExample,
  ActionParameter as ProtoActionParameter,
  ActionParameterSchema as ProtoActionParameterSchema,
  ActionParameters as ProtoActionParametersType,
  EvaluationExample as ProtoEvaluationExample,
} from "./proto.js";
import type { IAgentRuntime } from "./runtime";
import type { ActionPlan, State } from "./state";

/**
 * JSON Schema type for action parameter validation.
 * Supports basic JSON Schema properties for parameter definition.
 */
export interface ActionParameterSchema
  extends Omit<
    ProtoActionParameterSchema,
    | "$typeName"
    | "$unknown"
    | "defaultValue"
    | "properties"
    | "items"
    | "enumValues"
  > {
  /** Default value if parameter is not provided */
  default?: JsonValue | null;
  /** For object types, define nested properties */
  properties?: Record<string, ActionParameterSchema>;
  /** For array types, define the item schema */
  items?: ActionParameterSchema;
  /** Enumerated allowed values (schema-compatible) */
  enumValues?: string[];
  /** Enumerated allowed values */
  enum?: string[];
}

/**
 * Defines a single parameter for an action.
 * Parameters are extracted from the conversation by the LLM and passed to the action handler.
 */
export interface ActionParameter
  extends Omit<ProtoActionParameter, "$typeName" | "$unknown" | "schema"> {
  /** Parameter name (used as the key in the parameters object) */
  name: string;
  /** Human-readable description for LLM guidance */
  description: string;
  /** Whether this parameter is required (default: false) */
  required?: boolean;
  /** JSON Schema for parameter validation */
  schema: ActionParameterSchema;
  /**
   * Optional example values for this parameter.
   * These are shown to the model in action descriptions to improve extraction accuracy.
   */
  examples?: ActionParameterExampleValue[];
}

/**
 * Primitive value types that can be used in action parameters.
 */
export type ActionParameterValue = string | number | boolean | null;

/**
 * Example value types allowed for action parameter examples.
 * Supports primitives as well as nested objects/arrays for documentation purposes.
 */
export type ActionParameterExampleValue =
  | ActionParameterValue
  | ActionParameters
  | ActionParameterValue[]
  | ActionParameters[];

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
    | ActionParameters[]
    | JsonValue;
}

export type ProtoActionParameters = ProtoActionParametersType;

/**
 * Example content with associated user for demonstration purposes
 */
export interface ActionExample
  extends Omit<ProtoActionExample, "$typeName" | "$unknown" | "content"> {
  content: Content;
}

export interface EvaluationExample
  extends Omit<ProtoEvaluationExample, "$typeName" | "$unknown" | "messages"> {
  messages: ActionExample[];
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
  options?: HandlerOptions | Record<string, JsonValue | undefined>,
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
  | JsonValue
  | Uint8Array
  | bigint
  | object
  | ProviderValue[]
  | { [key: string]: ProviderValue | undefined }
  | undefined;

/**
 * Data record type that accepts any JSON-serializable values.
 * This is broader than ProviderValue to accommodate domain types
 * like Memory[], Character, Content without requiring casts.
 * The index signature allows dynamic property access.
 */
export type ProviderDataRecord = {
  [key: string]: ProviderValue;
};

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
   * Accepts JSON-serializable values and domain objects.
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

  /**
   * Parameter validation errors, if the action defined parameters but extraction/validation was incomplete.
   *
   * Actions SHOULD handle these errors gracefully (e.g. ask the user for missing required values,
   * or infer from context when safe).
   */
  parameterErrors?: string[];

  /** Allow extensions from plugins */
  [key: string]: JsonValue | object | undefined;
}
