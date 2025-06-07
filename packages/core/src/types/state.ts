/**
 * Represents the current state or context of a conversation or agent interaction.
 * This interface is a flexible container for various pieces of information that define the agent's
 * understanding at a point in time. It includes:
 * - `values`: A key-value store for general state variables, often populated by providers.
 * - `data`: Another key-value store, potentially for more structured or internal data.
 * - `text`: A string representation of the current context, often a summary or concatenated history.
 * The `[key: string]: any;` allows for dynamic properties, though `EnhancedState` offers better typing.
 * This state object is passed to handlers for actions, evaluators, and providers.
 */
export interface State {
  /** Additional dynamic properties */
  [key: string]: any;
  values: {
    [key: string]: any;
  };
  data: {
    [key: string]: any;
  };
  text: string;
}

/**
 * Defines the possible primitive types or structured types for a value within the agent's state.
 * This type is used to provide more specific typing for properties within `StateObject` and `StateArray`,
 * moving away from a generic 'any' type for better type safety and clarity in state management.
 */
export type StateValue = string | number | boolean | null | StateObject | StateArray;
/**
 * Represents a generic object structure within the agent's state, where keys are strings
 * and values can be any `StateValue`. This allows for nested objects within the state.
 * It's a fundamental part of the `EnhancedState` interface.
 */
export interface StateObject {
  [key: string]: StateValue;
}
/**
 * Represents an array of `StateValue` types within the agent's state.
 * This allows for lists of mixed or uniform types to be stored in the state,
 * contributing to the structured definition of `EnhancedState`.
 */
export type StateArray = StateValue[];

/**
 * Enhanced State interface with more specific types for its core properties.
 * This interface provides a more structured representation of an agent's conversational state,
 * building upon the base `State` by typing `values` and `data` as `StateObject`.
 * The `text` property typically holds a textual summary or context derived from the state.
 * Additional dynamic properties are still allowed via the index signature `[key: string]: StateValue;`.
 */
export interface EnhancedState {
  /** Holds directly accessible state values, often used for template rendering or quick lookups. */
  values: StateObject;
  /** Stores more complex or structured data, potentially namespaced by providers or internal systems. */
  data: StateObject;
  /** A textual representation or summary of the current state, often used as context for models. */
  text: string;
  /** Allows for additional dynamic properties to be added to the state object. */
  [key: string]: StateValue;
}
