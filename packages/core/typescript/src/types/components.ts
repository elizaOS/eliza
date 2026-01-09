import type { Memory } from "./memory";
import type { Content, UUID } from "./primitives";
import type { IAgentRuntime } from "./runtime";
import type { ActionPlan, State } from "./state";

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
 * Value types allowed in provider results
 */
export type ProviderValue = string | number | boolean | null | ProviderValue[] | { [key: string]: ProviderValue };

/**
 * Result returned by a provider
 */
export interface ProviderResult {
  /** Human-readable text for LLM prompt inclusion */
  text?: string;

  /** Key-value pairs for template variable substitution */
  values?: Record<string, ProviderValue>;

  /** Structured data for programmatic access by other components */
  data?: Record<string, ProviderValue>;
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

  /** Data payload containing action-specific results */
  data?: Record<string, ProviderValue>;

  /** Error information if the action failed */
  error?: string | Error;
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
export type StreamChunkCallback = (chunk: string, messageId?: string) => Promise<void>;

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
}
