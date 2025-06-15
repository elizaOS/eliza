import type { Agent, MessageExample } from '@elizaos/core';
import { logger } from '@elizaos/core';
import colors from 'yoctocolors';

/**
 * Display character
 */
export function displayAgent(data: Partial<Agent>, title = 'Agent Review'): void {
  logHeader(title);

  // Display basic info
  console.log(`Name: ${data.name}`);
  console.log(`Username: ${data.username || data.name?.toLowerCase().replace(/\s+/g, '_')}`);

  // Display sections
  displaySection('Bio', Array.isArray(data.bio) ? data.bio : data.bio ? [data.bio] : undefined);
  displaySection('Adjectives', data.adjectives);
  displaySection('Topics', data.topics);
  displaySection('Plugins', data.plugins);

  // Display style sections
  if (data.style) {
    displaySection('General Style', data.style.all);
    displaySection('Chat Style', data.style.chat);
    displaySection('Post Style', data.style.post);
  }

  displaySection('Post Examples', data.postExamples);

  // Display message examples
  if (data.messageExamples && data.messageExamples.length > 0) {
    console.log(`\n${colors.cyan('Message Examples:')}`);
    console.log(
      data.messageExamples
        .map((conversation, i) => {
          const messages = formatConversation(conversation);
          return `\nConversation ${i + 1}:\n${messages}`;
        })
        .join('\n')
    );
  }
}

/**
 * Formats a conversation into a string
 */
function formatConversation(conversation: MessageExample[]): string {
  return conversation
    .map((msg) => {
      const user = msg.name === '{{name1}}' ? 'Anon' : msg.name;
      return `${user}: ${msg.content.text}`;
    })
    .join('\n');
}

/**
 * Displays a section with a title and list of items
 */
function displaySection(title: string, items: string[] | undefined): void {
  if (!items || items.length === 0) return;

  console.log(`\n${colors.cyan(`${title}:`)}`);
  for (const item of items) {
    console.log(`  ${item}`);
  }
}

/**
 * Logs a header inside a rectangular frame with extra padding.
 * @param {string} title - The header text to display.
 */
export function logHeader(title: string): void {
  const padding = 2; // number of spaces on each side
  const titleStr = `=== ${title} ===`;
  const paddedTitle = ' '.repeat(padding) + titleStr + ' '.repeat(padding);
  const borderLength = paddedTitle.length;

  // Create top and bottom borders using Unicode box drawing characters
  const topBorder = colors.green(`┌${'─'.repeat(borderLength)}┐`);
  const bottomBorder = colors.green(`└${'─'.repeat(borderLength)}┘`);

  const coloredTitle = `${' '.repeat(padding)}=== ${colors.green(title)} ===${' '.repeat(padding)}`;
  const middleRow = colors.green('│') + coloredTitle + colors.green('│');

  // Log the rectangle with a leading new line for spacing
  console.log(`\n${topBorder}\n${middleRow}\n${bottomBorder}`);
}
