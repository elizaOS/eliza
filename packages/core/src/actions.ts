import { names, uniqueNamesGenerator } from 'unique-names-generator';
import type { Action, ActionExample } from './types';

/**
 * Composes a set of example conversations based on provided actions and a specified count.
 * It randomly selects examples from the provided actions and formats them with generated names.
 * @param actionsData - An array of `Action` objects from which to draw examples.
 * @param count - The number of examples to generate.
 * @returns A string containing formatted examples of conversations.
 */
/**
 * Compose a specified number of random action examples from the given actionsData.
 *
 * @param {Action[]} actionsData - The list of actions to generate examples from.
 * @param {number} count - The number of examples to compose.
 * @returns {string} The formatted action examples.
 */
export const composeActionExamples = (actionsData: Action[], count: number) => {
  const data: ActionExample[][][] = actionsData.map((action: Action) => [...action.examples]);

  const actionExamples: ActionExample[][] = [];
  let length = data.length;
  for (let i = 0; i < count && length; i++) {
    const actionId = i % length;
    const examples = data[actionId];
    if (examples.length) {
      const rand = ~~(Math.random() * examples.length);
      actionExamples[i] = examples.splice(rand, 1)[0];
    } else {
      i--;
    }

    if (examples.length === 0) {
      data.splice(actionId, 1);
      length--;
    }
  }

  const formattedExamples = actionExamples.map((example) => {
    const exampleNames = Array.from({ length: 5 }, () =>
      uniqueNamesGenerator({ dictionaries: [names] })
    );

    return `\n${example
      .map((message) => {
        let messageString = `${message.name}: ${message.content.text}${message.content.action ? ` (action: ${message.content.action})` : ''}${message.content.actions ? ` (actions: ${message.content.actions.join(', ')})` : ''}`;
        for (let i = 0; i < exampleNames.length; i++) {
          messageString = messageString.replaceAll(`{{name${i + 1}}}`, exampleNames[i]);
        }
        return messageString;
      })
      .join('\n')}`;
  });

  return formattedExamples.join('\n');
};

/**
 * Formats the names of the provided actions into a comma-separated string.
 * @param actions - An array of `Action` objects from which to extract names.
 * @returns A comma-separated string of action names.
 */
export function formatActionNames(actions: Action[]) {
  return actions
    .sort(() => 0.5 - Math.random())
    .map((action: Action) => `${action.name}`)
    .join(', ');
}

/**
 * Formats the provided actions into a detailed string listing each action's name and description, separated by commas and newlines.
 * @param actions - An array of `Action` objects to format.
 * @returns A detailed string of actions, including names and descriptions.
 */
export function formatActions(actions: Action[]) {
  return actions
    .sort(() => 0.5 - Math.random())
    .map((action: Action) => `${action.name}: ${action.description}`)
    .join(',\n');
}
