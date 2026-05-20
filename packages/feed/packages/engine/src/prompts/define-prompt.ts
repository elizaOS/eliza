/**
 * Prompt Definition System
 *
 * Type-safe prompt definitions for LLM interactions. Provides a structured
 * way to define prompts with metadata, templates, and rendering capabilities.
 */

/**
 * Defines a prompt template for LLM interactions.
 *
 * Each prompt includes metadata (id, version, category) and configuration
 * (temperature, maxTokens) along with a template string that can be
 * rendered with variables.
 */
export interface PromptDefinition {
  /** Unique identifier for the prompt */
  id: string;
  /** Semantic version of the prompt (e.g., '2.0.0') */
  version: string;
  /** Category/type of prompt (e.g., 'feed', 'game', 'image') */
  category: string;
  /** Human-readable description of what the prompt generates */
  description: string;
  /** Temperature setting for LLM (0-2, default varies by prompt) */
  temperature?: number;
  /** Maximum tokens for LLM response (default varies by prompt) */
  maxTokens?: number;
  /** Template string with {{variable}} placeholders */
  template: string;
}

/**
 * Helper to define a prompt with full type safety.
 *
 * Validates the prompt definition structure and returns it unchanged.
 * Used by all prompt files to ensure type safety.
 *
 * @param prompt - The prompt definition object
 * @returns The same prompt definition (for type inference)
 *
 * @example
 * ```ts
 * export const myPrompt = definePrompt({
 *   id: 'my-prompt',
 *   version: '1.0.0',
 *   category: 'feed',
 *   description: 'Generates a post',
 *   temperature: 0.9,
 *   maxTokens: 5000,
 *   template: 'Hello {{name}}!'
 * });
 * ```
 */
export function definePrompt(prompt: PromptDefinition): PromptDefinition {
  return prompt;
}

/**
 * Helper to render a prompt template with variable substitution.
 *
 * Replaces {{variable}} placeholders in the template with actual values.
 * Variables can be strings, numbers, booleans, null, or undefined.
 *
 * @param template - The template string with {{variable}} placeholders
 * @param variables - Object mapping variable names to their values
 * @returns The rendered template string with variables substituted
 *
 * @example
 * ```ts
 * const rendered = renderTemplate(
 *   'Hello {{name}}, you have {{count}} messages',
 *   { name: 'Alice', count: 5 }
 * );
 * // Returns: 'Hello Alice, you have 5 messages'
 * ```
 */
export function renderTemplate(
  template: string,
  variables: Record<string, string | number | boolean | null | undefined>,
): string {
  let rendered = template;
  for (const [key, value] of Object.entries(variables)) {
    const pattern = new RegExp(`\\{\\{${key}\\}\\}`, "g");
    rendered = rendered.replace(pattern, String(value ?? ""));
  }
  return rendered;
}
