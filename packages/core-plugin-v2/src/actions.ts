import {
  composeActionExamples as coreComposeActionExamples,
  formatActionNames as coreFormatActionNames,
  formatActions as coreFormatActions,
} from '@elizaos/core';

/**
 * Compose a specified number of random action examples from the given actionsData.
 *
 * @param {Action[]} actionsData - The list of actions to generate examples from.
 * @param {number} count - The number of examples to compose.
 * @returns {string} The formatted action examples.
 */
export const composeActionExamples = (actionsData: Action[], count: number) => {
  return coreComposeActionExamples(actionsData, count);
};

/**
 * Formats the names of the provided actions into a comma-separated string.
 * @param actions - An array of `Action` objects from which to extract names.
 * @returns A comma-separated string of action names.
 */
export function formatActionNames(actions: Action[]) {
  return coreFormatActionNames(actions);
}

/**
 * Formats the provided actions into a detailed string listing each action's name and description, separated by commas and newlines.
 * @param actions - An array of `Action` objects to format.
 * @returns A detailed string of actions, including names and descriptions.
 */
export function formatActions(actions: Action[]) {
  return coreFormatActions(actions);
}
