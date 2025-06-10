import * as clack from '@clack/prompts';
import { logger } from '@elizaos/core';

export const NAV_BACK = '__back__';
export const NAV_NEXT = '__next__';

/**
 * Prompts the user with a text input and optional navigation options.
 * @param {string} label - The label to display to the user.
 * @param {string} initial - The initial value for the input (default is an empty string).
 * @param {(val: string) => true | string} validate - Optional validation function for the input.
 * @returns {Promise<string>} The user's input after processing any navigation commands.
 */
export async function promptWithNav(
  label: string,
  initial = '',
  validate?: (val: string) => true | string
): Promise<string> {
  const msg = `${label}${initial ? ` (current: ${initial})` : ''}`;
  const input = await clack.text({
    message: msg,
    placeholder: initial,
    defaultValue: initial,
    validate: validate
      ? (val) => {
          const result = validate(val);
          return typeof result === 'string' ? result : undefined;
        }
      : undefined,
  });

  if (clack.isCancel(input)) {
    clack.cancel('Operation cancelled.');
    process.exit(0);
  }

  const trimmedInput = input.trim();
  if (trimmedInput.toLowerCase() === 'cancel') return 'cancel';
  if (trimmedInput.toLowerCase() === 'back') return NAV_BACK;
  if (trimmedInput.toLowerCase() === 'quit' || trimmedInput.toLowerCase() === 'exit') {
    logger.info('Exiting...');
    process.exit(0);
  }
  if (trimmedInput === '' && initial) return initial; // Return initial if empty and exists
  if (trimmedInput === '' || trimmedInput.toLowerCase() === 'next') return NAV_NEXT;
  return trimmedInput;
}

/**
 * Prompts the user to enter multiple items for a specified field name.
 *
 * @param {string} fieldName - The name of the field being prompted for.
 * @param {string[]} initial - The initial values to display and allow the user to modify.
 * @returns {Promise<string[]>} The array of strings containing the user-entered values.
 */
export async function promptForMultipleItems(
  fieldName: string,
  initial: string[] = []
): Promise<string[]> {
  const items = [...initial];
  logger.info(`\n${fieldName}`);
  if (initial.length > 0) {
    logger.info('Current values:');
    initial.forEach((item, i) => logger.info(`  ${i + 1}. ${item}`));
    logger.info('\nPress Enter to keep existing values, or start typing new ones:');
  }

  while (true) {
    const val = await promptWithNav(`> ${fieldName}:`);
    if (val === NAV_NEXT) break;
    if (val === NAV_BACK) {
      if (items.length === initial.length) return initial; // Return original if no change
      break;
    }
    if (val === 'cancel') return initial;
    items.push(val);
  }
  return items;
}

/**
 * Asynchronous function that prompts the user with a confirmation message and returns a boolean value based on their response.
 * @param {string} message - The message to display for the confirmation prompt.
 * @returns {Promise<boolean>} A Promise that resolves to a boolean value representing the user's confirmation choice.
 */

export async function confirmAction(message: string): Promise<boolean> {
  const response = await clack.confirm({
    message,
    initialValue: false,
  });

  if (clack.isCancel(response)) {
    clack.cancel('Operation cancelled.');
    process.exit(0);
  }

  return Boolean(response);
}
