/**
 * AI App Builder System Prompts (Legacy)
 *
 * Re-exports from the new modular prompt system.
 * New code should import from '@/lib/prompts' directly.
 */

// Legacy type alias
export type { TemplateType as keyof } from "@/lib/prompts";
export {
  BASE_SYSTEM_PROMPT,
  buildSystemPrompt,
  getExamplePrompts,
  TEMPLATE_EXAMPLES as EXAMPLE_PROMPTS,
  TEMPLATE_PROMPTS,
  type TemplateType,
} from "@/lib/prompts";

// Legacy function wrapper
export function getSystemPrompt(templateType: string = "blank"): string {
  const { buildSystemPrompt } = require("@/lib/prompts");
  return buildSystemPrompt({ templateType: templateType as "blank" });
}

// Legacy monetization/analytics prompts (now built into main builder)
export const MONETIZATION_PROMPT = `## Monetization
Track user credits with useAppCredits and AppCreditDisplay components.
`;

export const ANALYTICS_PROMPT = `## Analytics
Analytics are automatic via ElizaProvider.
`;
