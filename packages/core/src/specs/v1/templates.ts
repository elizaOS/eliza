import { State } from './state';

/**
 * Template type definition for v1 compatibility
 * A template can be either a string or a function that takes state and returns a string
 * This aligns with V2's TemplateType
 */
export type TemplateType = string | ((options: { state: State }) => string);

/**
 * Generic template values interface for typed access to state.values
 * Users can extend this interface for type safety in their templates
 */
export interface TemplateValues {
  [key: string]: unknown;
}

/**
 * Create a template function from a v1 template
 * @param template The v1 template (string or function)
 * @returns A function that processes the template with the given state
 */
export function createTemplateFunction(template: TemplateType): (state: State) => string {
  if (typeof template === 'string') {
    // For string templates, just return the string
    return () => template;
  } else {
    // For function templates, wrap it to match the expected signature
    return (state: State) => {
      // Handle null or undefined state
      if (!state) {
        return '';
      }
      return template({ state });
    };
  }
}

/**
 * Process a template with the given state
 * @param template The template to process (string or function)
 * @param state The state to use for processing
 * @returns The processed template string
 */
export function processTemplate(template: TemplateType, state: State): string {
  // Handle null/undefined template
  if (!template) {
    return '';
  }

  // Handle null/undefined state
  if (!state) {
    return typeof template === 'string' ? template : '';
  }

  if (typeof template === 'string') {
    return template;
  } else {
    return template({ state });
  }
}

/**
 * Type-safe accessor for template values
 * @param state The state containing the values
 * @param defaultValues Optional default values to use if values are missing
 * @returns The values object with type information
 */
export function getTemplateValues<T extends TemplateValues>(
  state: State,
  defaultValues?: Partial<T>
): T {
  if (!state || !state.values) {
    return (defaultValues || {}) as T;
  }

  // First cast state.values to a valid object type to use with spread
  const stateValues = state.values as Record<string, unknown>;
  const defaults = defaultValues || ({} as Partial<T>);

  // Create a new object with both default values and state values
  return { ...defaults, ...stateValues } as T;
}
