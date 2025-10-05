/**
 * Represents the current state or context of a conversation or agent interaction.
 * This interface is a flexible container for various pieces of information that define the agent's
 * understanding at a point in time. It includes:
 * - `values`: A key-value store for general state variables, often populated by providers.
 * - `data`: Another key-value store, potentially for more structured or internal data.
 * - `text`: A string representation of the current context, often a summary or concatenated history.
 * The `[key: string]: any;` allows for dynamic properties to be added as needed.
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
