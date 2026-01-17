/**
 * State types for agent runtime and streaming.
 *
 * This module defines:
 * - State: The runtime context passed to providers, actions, evaluators
 * - SchemaRow: Field definitions for structured LLM outputs
 * - StreamEvent: Rich events for validation-aware streaming
 * - RetryBackoffConfig: Configuration for retry timing
 *
 * STREAMING ARCHITECTURE:
 * -----------------------
 * ElizaOS supports validation-aware streaming - you can stream LLM output while
 * also validating it wasn't truncated or corrupted.
 *
 * The key insight: LLMs can fail silently. Context window exhaustion truncates
 * output mid-sentence. Without validation, users see broken responses.
 *
 * Solution: Validation codes - short UUIDs the LLM must echo back. If the code
 * before and after a field match, we know that field wasn't truncated.
 *
 * Validation Levels:
 * - 0 (Trusted): No codes, maximum speed. Trust the model completely.
 * - 1 (Progressive): Per-field codes. Stream as each field validates.
 * - 2 (First Checkpoint): Codes at start only. Catches "ignored prompt".
 * - 3 (Full): Codes at start AND end. Maximum correctness guarantee.
 *
 * Consumer Patterns:
 * - Simple (onStreamChunk only): Gets text + auto-separator on retries
 * - Rich (onStreamChunk + onStreamEvent): Gets typed events for custom UX
 *
 * @module types/state
 */
import type { ActionResult } from './components';
import type { Entity, Room, World } from './environment';

/** Single step in an action plan */
export interface ActionPlanStep {
  action: string;
  status: 'pending' | 'completed' | 'failed';
  error?: string;
  result?: ActionResult;
}

/** Multi-step action plan */
export interface ActionPlan {
  thought: string;
  totalSteps: number;
  currentStep: number;
  steps: ActionPlanStep[];
}

/**
 * Structured data cached in state by providers and actions.
 * Common properties are typed for better DX while allowing dynamic extension.
 */
export interface StateData {
  /** Cached room data from providers */
  room?: Room;
  /** Cached world data from providers */
  world?: World;
  /** Cached entity data from providers */
  entity?: Entity;
  /** Provider results cache keyed by provider name */
  providers?: Record<string, Record<string, unknown>>;
  /** Current action plan for multi-step actions */
  actionPlan?: ActionPlan;
  /** Results from previous action executions */
  actionResults?: ActionResult[];
  /** Allow additional dynamic properties */
  [key: string]: unknown;
}

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
   *   WHY: Level 0 is for fast, trusted models. You only add codes for critical fields.
   *
   * - Level 1 (Progressive): default true. Set to false to opt-out of codes.
   *   WHY: Level 1 validates each field progressively. Opt-out for non-critical fields
   *   to reduce token overhead and get faster streaming.
   *
   * - Levels 2-3: ignored (uses checkpoint codes at start/end of response instead).
   *   WHY: Higher levels use a single validation checkpoint approach, not per-field.
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
   * WHY: Most use cases only want to stream the 'text' field. This default
   * means you don't need to specify streamField for typical schemas.
   *
   * Set to true to stream fields like 'summary', 'answer', etc.
   * Set to false to suppress streaming of specific fields.
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
   * WHY: A short initial delay catches transient hiccups without being too slow.
   * Default: 1000ms (1 second)
   */
  initialMs: number;
  /**
   * Multiplier applied to delay after each retry.
   * WHY: Exponential backoff (multiplier > 1) is more respectful of failing services.
   * Default: 2 (doubles each time: 1s → 2s → 4s → 8s)
   */
  multiplier: number;
  /**
   * Maximum delay cap in milliseconds.
   * WHY: Don't wait forever - cap prevents absurdly long delays.
   * Default: 30000ms (30 seconds)
   */
  maxMs: number;
}

// ============================================================================
// Streaming Event Types
// ============================================================================

/**
 * Stream event types for validation-aware streaming.
 *
 * WHY: Rich consumers (like advanced UIs) want to know more than just "here's text".
 * They want to know: is this validated? did a retry happen? what failed?
 * These event types enable sophisticated UX like showing retry spinners or
 * partial validation indicators.
 */
export type StreamEventType =
  /** Normal content chunk - the actual LLM output */
  | 'chunk'
  /** Field passed validation (level 1) - safe to display permanently */
  | 'field_validated'
  /** Validation failed, starting retry - UI can show "retrying..." */
  | 'retry_start'
  /** Info about validated context being kept for retry prompt */
  | 'retry_context'
  /** Unrecoverable error (max retries, abort, etc.) */
  | 'error'
  /** Stream finished successfully - all validation passed */
  | 'complete';

/**
 * Rich stream event for consumers that want detailed streaming state.
 *
 * WHY: Simple streaming just provides text chunks via onStreamChunk. But sophisticated
 * UIs need more context to provide good UX:
 * - When retrying, show a spinner instead of concatenating duplicate text
 * - When a field validates, mark it as "final" in the UI
 * - When an error occurs, display it appropriately
 *
 * Simple consumers can ignore onStreamEvent and just use onStreamChunk.
 * They'll get an auto-generated "-- that's not right, let me start again:" separator
 * on retries to prevent confusing output.
 *
 * @example Rich consumer handling
 * ```ts
 * onStreamEvent: (event) => {
 *   switch (event.type) {
 *     case 'chunk':
 *       appendToDisplay(event.content);
 *       break;
 *     case 'retry_start':
 *       showRetryIndicator(event.retryCount);
 *       clearPartialContent();
 *       break;
 *     case 'error':
 *       showError(event.error);
 *       break;
 *     case 'complete':
 *       hideLoadingIndicator();
 *       break;
 *   }
 * }
 * ```
 */
export interface StreamEvent {
  /** Event type - determines which other fields are relevant */
  type: StreamEventType;
  /** The chunk content (for 'chunk' type) */
  content?: string;
  /** Which field this relates to (for 'chunk', 'field_validated', 'error') */
  field?: string;
  /** Current retry attempt number, 1-indexed (for 'retry_start') */
  retryCount?: number;
  /** Fields we're keeping from previous attempt (for 'retry_context') */
  validatedFields?: string[];
  /** Error message (for 'error' type) */
  error?: string;
}

/**
 * Represents the current state or context of a conversation or agent interaction.
 * This interface is a flexible container for various pieces of information that define the agent's
 * understanding at a point in time. It includes:
 * - `values`: A key-value store for general state variables, often populated by providers.
 * - `data`: Structured data cache with typed common properties for room, world, entity, etc.
 * - `text`: A string representation of the current context, often a summary or concatenated history.
 * The `[key: string]: unknown;` allows for dynamic properties to be added as needed.
 * This state object is passed to handlers for actions, evaluators, and providers.
 */
export interface State {
  /** Additional dynamic properties */
  [key: string]: unknown;
  values: {
    [key: string]: unknown;
  };
  /** Structured data cache with typed properties */
  data: StateData;
  text: string;
}
