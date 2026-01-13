/**
 * Jinja template warnings
 * Converted from sweagent/utils/jinja_warnings.py
 */

import { getLogger } from './log';

const logger = getLogger('jinja-warnings');

/**
 * Warn about probably wrong Jinja syntax
 */
export function warnProbablyWrongJinjaSyntax(template: string | null): void {
  if (!template) {
    return;
  }

  // Check for common Jinja syntax errors
  const patterns = [
    { pattern: /\{\{[^}]*\{[^}]*\}\}/, message: 'Nested braces detected in template' },
    { pattern: /\{%[^%]*\{[^%]*%\}/, message: 'Nested braces in control structure' },
    { pattern: /\{\{[^}]+\|\s*\}\}/, message: 'Empty filter detected' },
    { pattern: /\{%\s*end\s*%\}/, message: 'Incomplete end tag detected' },
  ];

  for (const { pattern, message } of patterns) {
    if (pattern.test(template)) {
      logger.warning(`Potential Jinja syntax issue: ${message}`);
    }
  }

  // Check for unclosed tags
  const openingTags = (template.match(/\{\{/g) || []).length;
  const closingTags = (template.match(/\}\}/g) || []).length;

  if (openingTags !== closingTags) {
    logger.warning(`Mismatched Jinja tags: ${openingTags} opening, ${closingTags} closing`);
  }

  const openingControlTags = (template.match(/\{%/g) || []).length;
  const closingControlTags = (template.match(/%\}/g) || []).length;

  if (openingControlTags !== closingControlTags) {
    logger.warning(`Mismatched Jinja control tags: ${openingControlTags} opening, ${closingControlTags} closing`);
  }
}
