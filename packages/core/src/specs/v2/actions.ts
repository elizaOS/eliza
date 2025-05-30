import type { Action } from './types';

/**
 * Compose a specified number of random action examples from the given actionsData.
 *
 * @param {Action[]} actionsData - The list of actions to generate examples from.
 * @param {number} count - The number of examples to compose.
 * @returns {string} The formatted action examples.
 */
export const composeActionExamples = (actionsData: Action[], count: number) => {
  const actionExamples: string[] = [];
  const names = ['Alice', 'Bob', 'Charlie', 'David', 'Eve', 'Frank', 'Grace', 'Heidi'];
  const usedNames = new Set<string>();

  // Helper function to get a random name
  const getRandomName = () => {
    const availableNames = names.filter((name) => !usedNames.has(name));
    if (availableNames.length === 0) {
      usedNames.clear();
      return names[Math.floor(Math.random() * names.length)];
    }
    const name = availableNames[Math.floor(Math.random() * availableNames.length)];
    usedNames.add(name);
    return name;
  };

  // Collect all examples from all actions
  const allExamples: Array<{ action: Action; example: any[] }> = [];
  for (const action of actionsData) {
    if (action.examples) {
      for (const example of action.examples) {
        allExamples.push({ action, example });
      }
    }
  }

  // Randomly select examples
  for (let i = 0; i < count && allExamples.length > 0; i++) {
    const randomIndex = Math.floor(Math.random() * allExamples.length);
    const { example } = allExamples[randomIndex];

    // Generate random names for placeholders
    const randomNames = Array.from({ length: 5 }, () => getRandomName());

    // Format the example
    const formattedExample = example
      .map((msg) => {
        let text = msg.content.text || '';

        // Replace placeholders with random names
        for (let j = 0; j < randomNames.length; j++) {
          text = text.replace(new RegExp(`{{name${j + 1}}}`, 'g'), randomNames[j]);
        }

        // Use the original name from the example (like 'name1', 'name2')
        return `${msg.name}: ${text}`;
      })
      .join('\n');

    actionExamples.push(formattedExample);
  }

  return actionExamples.join('\n\n');
};

/**
 * Formats the names of the provided actions into a comma-separated string.
 * @param actions - An array of `Action` objects from which to extract names.
 * @returns A comma-separated string of action names.
 */
export function formatActionNames(actions: Action[]): string {
  return actions.map((action) => action.name).join(', ');
}

/**
 * Formats the provided actions into a detailed string listing each action's name and description, separated by commas and newlines.
 * @param actions - An array of `Action` objects to format.
 * @returns A detailed string of actions, including names and descriptions.
 */
export function formatActions(actions: Action[]): string {
  return actions.map((action) => `${action.name}: ${action.description}`).join(',\n');
}
