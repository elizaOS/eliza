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
