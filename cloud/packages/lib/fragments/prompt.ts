/**
 * Prompt Builder (Legacy Compatibility)
 *
 * Re-exports from the new modular prompt system.
 * New code should import from '@/lib/prompts' directly.
 */

export {
  BASE_SYSTEM_PROMPT as FULL_APP_BASE_PROMPT,
  buildSystemPrompt as buildFullAppPrompt,
  getExamplePrompts,
  TEMPLATE_EXAMPLES as FULL_APP_EXAMPLE_PROMPTS,
  TEMPLATE_PROMPTS as FULL_APP_TEMPLATE_PROMPTS,
  type TemplateType as FullAppTemplateType,
} from "@/lib/prompts";

import { buildApiContext } from "./api-context";
// Legacy fragment builder (for quick mode)
import { Templates, templatesToPrompt } from "./templates";

export async function buildFragmentPrompt(
  template: Templates,
  includeApiContext = true,
): Promise<string> {
  const basePrompt = `You are a skilled software engineer.
Generate a fragment using the provided template.
Do not wrap code in backticks.
Templates available: ${templatesToPrompt(template)}`;

  if (!includeApiContext) return basePrompt;

  const apiContext = await buildApiContext({
    categories: ["AI Completions", "Image Generation", "Video Generation"],
    tags: ["ai-generation"],
    limit: 20,
    includeExamples: true,
  });

  return `${basePrompt}\n\n## Available APIs\n${apiContext}`;
}
