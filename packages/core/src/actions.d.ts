import type { Action } from './types';
/**
 * Composes a set of example conversations based on provided actions and a specified count.
 * It randomly selects examples from the provided actions and formats them with generated names.
 *
 * @param actionsData - An array of `Action` objects from which to draw examples.
 * @param count - The number of examples to generate.
 * @returns A string containing formatted examples of conversations.
 */
export declare const composeActionExamples: (actionsData: Action[], count: number) => string;
/**
 * Formats the names of the provided actions into a comma-separated string.
 * @param actions - An array of `Action` objects from which to extract names.
 * @returns A comma-separated string of action names.
 */
export declare function formatActionNames(actions: Action[]): string;
/**
 * Formats the provided actions into a detailed string listing each action's name and description.
 * @param actions - An array of `Action` objects to format.
 * @returns A detailed string of actions, including names and descriptions.
 */
export declare function formatActions(actions: Action[]): string;
//# sourceMappingURL=actions.d.ts.map