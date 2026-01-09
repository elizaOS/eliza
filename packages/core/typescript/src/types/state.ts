import type { ActionResult, ProviderResult } from "./components";
import type { Entity, Room, World } from "./environment";

/**
 * Allowed value types for state values (JSON-serializable)
 */
export type StateValue = string | number | boolean | null | StateValue[] | { [key: string]: StateValue };

/** Single step in an action plan */
export interface ActionPlanStep {
  action: string;
  status: "pending" | "completed" | "failed";
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
 * Provider result cache entry
 */
export interface ProviderCacheEntry {
  text?: string;
  values?: Record<string, StateValue>;
  data?: Record<string, StateValue>;
}

/**
 * Working memory entry for multi-step action execution
 */
export interface WorkingMemoryEntry {
  /** Name of the action that created this entry */
  actionName: string;
  /** Result from the action execution */
  result: ActionResult;
  /** Timestamp when the entry was created */
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
export interface StateData {
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
  [key: string]: unknown;
}

/**
 * State values populated by providers
 */
export interface StateValues {
  /** Agent name */
  agentName?: string;
  /** Action names available to the agent */
  actionNames?: string;
  /** Provider names used */
  providers?: string;
  /** Other dynamic values */
  [key: string]: unknown;
}

/**
 * Represents the current state or context of a conversation or agent interaction.
 * This interface is a container for various pieces of information that define the agent's
 * understanding at a point in time.
 */
export interface State {
  /** Key-value store for state variables populated by providers */
  values: StateValues;
  /** Structured data cache with typed properties */
  data: StateData;
  /** String representation of the current context */
  text: string;
  /** Dynamic properties for template expansion */
  [key: string]: unknown;
}
