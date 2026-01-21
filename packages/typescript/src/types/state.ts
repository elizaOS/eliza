import type { ActionResult, ProviderValue } from "./components";
import type { Entity, Room, World } from "./environment";
import type {
  ActionPlan as ProtoActionPlan,
  ActionPlanStep as ProtoActionPlanStep,
  ProviderCacheEntry as ProtoProviderCacheEntry,
  State as ProtoState,
  StateData as ProtoStateData,
  StateValues as ProtoStateValues,
  WorkingMemoryItem as ProtoWorkingMemoryItem,
} from "./proto.js";

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
  extends Omit<
    ProtoActionPlan,
    "$typeName" | "$unknown" | "steps" | "metadata"
  > {
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
