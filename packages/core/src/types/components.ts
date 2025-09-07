import type { Memory } from './memory';
import type { Content } from './primitives';
import type { IAgentRuntime } from './runtime';
import type { State } from './state';

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
export type HandlerCallback = (response: Content, files?: any) => Promise<Memory[]>;

/**
 * Handler function type for processing messages
 */
export type Handler = (
  runtime: IAgentRuntime,
  message: Memory,
  state?: State,
  options?: { [key: string]: unknown },
  callback?: HandlerCallback,
  responses?: Memory[]
) => Promise<ActionResult | void | undefined>;

/**
 * Validator function type for actions/evaluators
 */
export type Validator = (
  runtime: IAgentRuntime,
  message: Memory,
  state?: State
) => Promise<boolean>;

/**
 * Represents an action the agent can perform
 */
export interface Action {
  /** Similar action descriptions */
  similes?: string[];

  /** Detailed description */
  description: string;

  /** Example usages */
  examples?: ActionExample[][];

  /** Handler function */
  handler: Handler;

  /** Action name */
  name: string;

  /** Validation function */
  validate: Validator;
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

export interface ProviderResult {
  values?: {
    [key: string]: any;
  };
  data?: {
    [key: string]: any;
  };
  text?: string;
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
  get: (runtime: IAgentRuntime, message: Memory, state: State) => Promise<ProviderResult>;
}

/**
 * Result returned by an action after execution
 * Used for action chaining and state management
 */
export interface ActionResult {
  /** Optional text description of the result */
  text?: string;

  /** Values to merge into the state */
  values?: Record<string, any>;

  /** Data payload containing action-specific results */
  data?: Record<string, any>;

  /** Whether the action succeeded - defaults to true */
  success: boolean;

  /** Error information if the action failed */
  error?: string | Error;
}

/**
 * Context provided to actions during execution
 * Allows actions to access previous results and update state
 */
export interface ActionContext {
  /** Results from previously executed actions in this run */
  previousResults: ActionResult[];

  /** Get a specific previous result by action name */
  getPreviousResult?: (actionName: string) => ActionResult | undefined;
}

/**
 * Helper function to create ActionResult with proper defaults
 */
export function createActionResult(partial: Partial<ActionResult> = {}): ActionResult {
  return {
    success: true, // Default to success
    ...partial,
  };
}
