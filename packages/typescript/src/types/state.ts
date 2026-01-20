import type {
  ActionPlan as ProtoActionPlan,
  ActionPlanStep as ProtoActionPlanStep,
  ProviderCacheEntry as ProtoProviderCacheEntry,
  State as ProtoState,
  StateData as ProtoStateData,
  StateValues as ProtoStateValues,
  WorkingMemoryItem as ProtoWorkingMemoryItem,
} from "./proto.js";
import type { ActionResult, ProviderValue } from "./components";
import type { Entity, Room, World } from "./environment";

/**
 * Allowed value types for state values (JSON-serializable)
 */
export type StateValue =
  | string
  | number
  | boolean
  | null
  | ProviderValue
  | object
  | StateValue[]
  | { [key: string]: StateValue };

/** Single step in an action plan */
export interface ActionPlanStep
  extends Omit<ProtoActionPlanStep, "$typeName" | "$unknown" | "result"> {
  status: "pending" | "completed" | "failed";
  result?: ActionResult;
}

/** Multi-step action plan */
export interface ActionPlan
  extends Omit<ProtoActionPlan, "$typeName" | "$unknown" | "steps" | "metadata"> {
  steps: ActionPlanStep[];
  metadata?: Record<string, StateValue>;
}

/**
 * Provider result cache entry
 */
export interface ProviderCacheEntry
  extends Omit<
    ProtoProviderCacheEntry,
    "$typeName" | "$unknown" | "values" | "data"
  > {
  values?: Record<string, StateValue>;
  data?: Record<string, StateValue>;
}

/**
 * Working memory entry for multi-step action execution
 */
export interface WorkingMemoryEntry
  extends Omit<
    ProtoWorkingMemoryItem,
    "$typeName" | "$unknown" | "result" | "timestamp"
  > {
  result: ActionResult;
  timestamp: number;
}

/**
 * Working memory record for temporary state during action execution
 */
export type WorkingMemory = Record<string, WorkingMemoryEntry>;

/**
 * Structured data cached in state by providers and actions.
 * Common properties are typed for better DX while allowing dynamic extension.
 */
export interface StateData
  extends Omit<
    ProtoStateData,
    | "$typeName"
    | "$unknown"
    | "room"
    | "world"
    | "entity"
    | "providers"
    | "actionPlan"
    | "actionResults"
    | "workingMemory"
  > {
  /** Cached room data from providers */
  room?: Room;
  /** Cached world data from providers */
  world?: World;
  /** Cached entity data from providers */
  entity?: Entity;
  /** Provider results cache keyed by provider name */
  providers?: Record<string, ProviderCacheEntry>;
  /** Current action plan for multi-step actions */
  actionPlan?: ActionPlan;
  /** Results from previous action executions */
  actionResults?: ActionResult[];
  /** Working memory for temporary state during multi-step action execution */
  workingMemory?: WorkingMemory;
  /** Allow dynamic properties for plugin extensions */
  [key: string]: StateValue | undefined;
}

/**
 * State values populated by providers
 */
export interface StateValues
  extends Omit<ProtoStateValues, "$typeName" | "$unknown" | "extra"> {
  /** Agent name */
  agentName?: string;
  /** Action names available to the agent */
  actionNames?: string;
  /** Provider names used */
  providers?: string;
  /** Other dynamic values */
  [key: string]: StateValue | undefined;
}

/**
 * Represents the current state or context of a conversation or agent interaction.
 * This interface is a container for various pieces of information that define the agent's
 * understanding at a point in time.
 */
export interface State
  extends Omit<ProtoState, "$typeName" | "$unknown" | "values" | "data"> {
  values: StateValues;
  data: StateData;
  [key: string]: StateValue | StateValues | StateData | undefined;
}

// ============================================================================
// Dynamic Prompt Execution Types
// ============================================================================

/**
 * Schema row for dynamic prompt execution.
 *
 * WHY: dynamicPromptExecFromState generates structured prompts that ask the LLM
 * to output specific fields. Each SchemaRow defines one field the LLM must produce.
 * The schema also controls validation behavior for streaming scenarios.
 *
 * @example
 * ```ts
 * const schema: SchemaRow[] = [
 *   { field: 'thought', description: 'Your internal reasoning' },
 *   { field: 'text', description: 'Response to user', required: true },
 *   { field: 'actions', description: 'Actions to execute' },
 * ];
 * ```
 */
export type SchemaRow = {
  /** Field name - will become an XML tag or JSON property */
  field: string;
  /** Description shown to LLM - explains what to put in this field */
  description: string;
  /** If true, validation fails when field is empty/missing */
  required?: boolean;
  /**
   * Control per-field validation codes for streaming (levels 0-1 only).
   *
   * WHY: Validation codes are UUID snippets that surround each field. If the LLM
   * outputs the same code before and after a field, we know the context window
   * wasn't truncated mid-field. This trades off token usage for reliability.
   *
   * Behavior by level:
   * - Level 0 (Trusted): default false. Set to true to opt-in to per-field codes.
   * - Level 1 (Progressive): default true. Set to false to opt-out of codes.
   * - Levels 2-3: ignored (uses checkpoint codes at start/end of response instead).
   */
  validateField?: boolean;
  /**
   * Control whether this field's content is streamed to the consumer.
   *
   * WHY: Not all fields should be shown to users in real-time:
   * - 'thought': Internal reasoning - might be verbose or confusing to show
   * - 'actions': System field for action routing - not user-visible
   * - 'text': The actual response - should definitely stream
   *
   * Default: true for 'text' field, false for others.
   */
  streamField?: boolean;
};

/**
 * Configuration for retry backoff timing.
 *
 * WHY: When retries happen, immediate retries can:
 * - Overwhelm rate-limited APIs
 * - Hit transient failures repeatedly
 * - Waste resources on brief outages
 *
 * Backoff gives the system time to recover between attempts.
 */
export interface RetryBackoffConfig {
  /**
   * Initial delay in milliseconds before first retry.
   * Default: 1000ms (1 second)
   */
  initialMs: number;
  /**
   * Multiplier for exponential backoff.
   * delay = initialMs * multiplier^(retryCount - 1)
   * Default: 2 (doubles each time)
   */
  multiplier: number;
  /**
   * Maximum delay in milliseconds.
   * Caps exponential growth to prevent absurd wait times.
   * Default: 30000ms (30 seconds)
   */
  maxMs: number;
}

/**
 * Stream event types for validation-aware streaming.
 * Rich consumers receive these typed events for custom UX handling.
 */
export type StreamEventType =
  | "chunk" // Regular content chunk being streamed
  | "field_validated" // A field passed validation (level 1)
  | "retry_start" // Starting a retry attempt
  | "error" // Unrecoverable error occurred
  | "complete"; // Successfully finished all validation

/**
 * Rich stream event for sophisticated consumers.
 *
 * WHY: Simple consumers just want text chunks. Advanced UIs want to know
 * about validation progress, retries, and errors to show appropriate UI
 * (spinners, clear partial content, error messages).
 */
export interface StreamEvent {
  /** Event type (named eventType for cross-language consistency with Rust/Python) */
  eventType: StreamEventType;
  /** Field name (for chunk and field_validated events) */
  field?: string;
  /** Content chunk (for chunk events) */
  chunk?: string;
  /** Retry attempt number (for retry_start events) */
  retryCount?: number;
  /** Error message (for error events) */
  error?: string;
  /** Timestamp of the event */
  timestamp: number;
}
