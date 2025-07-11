import { names, uniqueNamesGenerator } from 'unique-names-generator';
import type { Action, ActionExample } from './types';

/**
 * Composes a set of example conversations based on provided actions and a specified count.
 * It randomly selects examples from the provided actions and formats them with generated names.
 *
 * @param actionsData - An array of `Action` objects from which to draw examples.
 * @param count - The number of examples to generate.
 * @returns A string containing formatted examples of conversations.
 */
export const composeActionExamples = (actionsData: Action[], count: number): string => {
  // Handle edge cases
  if (!actionsData.length || count <= 0) {
    return '';
  }

  // Filter out actions without examples
  const actionsWithExamples = actionsData.filter(
    (action) => action.examples && Array.isArray(action.examples) && action.examples.length > 0
  );

  // If no actions have examples, return empty string
  if (!actionsWithExamples.length) {
    return '';
  }

  // Create a working copy of the examples
  const examplesCopy: ActionExample[][][] = actionsWithExamples.map((action) => [
    ...action.examples,
  ]);

  const selectedExamples: ActionExample[][] = [];

  // Keep track of actions that still have examples
  let availableActionIndices = examplesCopy
    .map((examples, index) => (examples.length > 0 ? index : -1))
    .filter((index) => index !== -1);

  // Select examples until we reach the count or run out of examples
  while (selectedExamples.length < count && availableActionIndices.length > 0) {
    // Randomly select an action
    const randomIndex = Math.floor(Math.random() * availableActionIndices.length);
    const actionIndex = availableActionIndices[randomIndex];
    const examples = examplesCopy[actionIndex];

    // Select a random example from this action
    const exampleIndex = Math.floor(Math.random() * examples.length);
    selectedExamples.push(examples.splice(exampleIndex, 1)[0]);

    // Remove action if it has no more examples
    if (examples.length === 0) {
      availableActionIndices.splice(randomIndex, 1);
    }
  }

  // Format the selected examples
  return formatSelectedExamples(selectedExamples);
};

/**
 * Formats selected example conversations with random names.
 */
const formatSelectedExamples = (examples: ActionExample[][]): string => {
  const MAX_NAME_PLACEHOLDERS = 5;

  return examples
    .map((example) => {
      // Generate random names for this example
      const randomNames = Array.from({ length: MAX_NAME_PLACEHOLDERS }, () =>
        uniqueNamesGenerator({ dictionaries: [names] })
      );

      // Format the conversation
      const conversation = example
        .map((message) => {
          // Build the base message - only include the text, no action info
          let messageText = `${message.name}: ${message.content.text}`;

          // Replace name placeholders
          for (let i = 0; i < randomNames.length; i++) {
            messageText = messageText.replaceAll(`{{name${i + 1}}}`, randomNames[i]);
          }

          return messageText;
        })
        .join('\n');

      return `\n${conversation}`;
    })
    .join('\n');
};

/**
 * Formats the names of the provided actions into a comma-separated string.
 * @param actions - An array of `Action` objects from which to extract names.
 * @returns A comma-separated string of action names.
 */
export function formatActionNames(actions: Action[]): string {
  if (!actions?.length) return '';

  // Create a shuffled copy instead of mutating the original array
  return [...actions]
    .sort(() => Math.random() - 0.5)
    .map((action) => action.name)
    .join(', ');
}

/**
 * Formats the provided actions into a detailed string listing each action's name and description.
 * @param actions - An array of `Action` objects to format.
 * @returns A detailed string of actions, including names and descriptions.
 */
export function formatActions(actions: Action[]): string {
  if (!actions?.length) return '';

  // Create a shuffled copy without mutating the original
  return [...actions]
    .sort(() => Math.random() - 0.5)
    .map((action) => `- **${action.name}**: ${action.description || 'No description available'}`)
    .join('\n');
}
