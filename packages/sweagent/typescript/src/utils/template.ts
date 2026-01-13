/**
 * Template rendering utilities used outside the agent layer.
 *
 * We keep a single implementation by delegating to `src/agent/utils/template.ts`.
 */

import type { TemplateContext } from "../agent/utils/template";
import { renderAdvancedTemplate } from "../agent/utils/template";

export function renderTemplate(
  template: string,
  context: TemplateContext,
): string {
  return renderAdvancedTemplate(template, context);
}

/**
 * Escape special characters in a string for use in templates
 */
export function escapeTemplate(str: string): string {
  return str
    .replace(/{{/g, "\\{\\{")
    .replace(/}}/g, "\\}\\}")
    .replace(/{%/g, "\\{\\%")
    .replace(/%}/g, "\\%\\}");
}

/**
 * Check if a string contains template syntax
 */
export function hasTemplateSyntax(str: string): boolean {
  return /{{.*?}}|{%.*?%}/.test(str);
}
