import { definePrompt } from '../define-prompt';

/**
 * System prompt for enforcing XML-only LLM responses.
 *
 * Instructs the LLM to respond only with valid XML, with no explanations,
 * markdown, or other text. Used as a system message to ensure structured
 * output format for prompts that require XML responses.
 *
 * @example
 * ```ts
 * // Use as system message before other prompts
 * const systemPrompt = renderPrompt(xmlAssistant, {});
 * ```
 */
export const xmlAssistant = definePrompt({
  id: 'xml-assistant',
  version: '2.0.0',
  category: 'system',
  description: 'System message for XML-only LLM responses',
  temperature: 0,
  maxTokens: 0,
  template: `
You are an XML-only assistant. You must respond ONLY with valid XML. No explanations, no markdown, no other text.
`.trim(),
});
