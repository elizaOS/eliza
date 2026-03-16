/**
 * Prompt Builder
 *
 * Composes the system prompt from modular pieces.
 * Clean, maintainable, and easy to update.
 */

import { BASE_SYSTEM_PROMPT } from "./base";
import { SDK_REFERENCE, SDK_RESTRICTIONS } from "./sdk";
import { BUILD_RULES, WORKFLOW_RULES } from "./rules";
import {
  TEMPLATE_PROMPTS,
  TEMPLATE_EXAMPLES,
  type TemplateType,
} from "./templates";
import { DATABASE_SETUP_PROMPT, DATABASE_SECURITY_RULES } from "./database";

export type { TemplateType };

export interface PromptConfig {
  /** Template type for app-specific guidance */
  templateType?: TemplateType;
  /** Include monetization guidance */
  includeMonetization?: boolean;
  /** Include analytics guidance */
  includeAnalytics?: boolean;
  /** Include database setup instructions (for stateful apps) */
  includeDatabase?: boolean;
  /** Custom instructions to append */
  customInstructions?: string;
}

/**
 * Build the complete system prompt for the AI App Builder.
 * Composes from modular pieces for maintainability.
 */
export function buildSystemPrompt(config: PromptConfig = {}): string {
  const {
    templateType = "blank",
    includeMonetization = true,
    includeAnalytics = true,
    includeDatabase = false,
    customInstructions,
  } = config;

  const sections = [
    BASE_SYSTEM_PROMPT,
    SDK_REFERENCE,
    SDK_RESTRICTIONS,
    BUILD_RULES,
    WORKFLOW_RULES,
    TEMPLATE_PROMPTS[templateType] || TEMPLATE_PROMPTS.blank,
  ];

  if (includeMonetization) {
    sections.push(MONETIZATION_GUIDANCE);
  }

  if (includeAnalytics) {
    sections.push(ANALYTICS_GUIDANCE);
  }

  // Include database setup instructions for stateful apps
  if (includeDatabase) {
    sections.push(DATABASE_SETUP_PROMPT);
    sections.push(DATABASE_SECURITY_RULES);
  }

  if (customInstructions) {
    sections.push(`## Additional Instructions\n${customInstructions}`);
  }

  return sections.join("\n\n");
}

/**
 * Get example prompts for a template type.
 */
export function getExamplePrompts(
  templateType: TemplateType = "blank",
): string[] {
  return TEMPLATE_EXAMPLES[templateType] || TEMPLATE_EXAMPLES.blank;
}

// Short guidance blocks for optional features
const MONETIZATION_GUIDANCE = `## Monetization

Track and display user credits:
\`\`\`tsx
import { useAppCredits, AppCreditDisplay, PurchaseCreditsButton } from '@/components/eliza';

// Check balance before expensive ops
const { balance, hasLowBalance } = useAppCredits();
if (balance < 5) showWarning();

// Display balance in header
<AppCreditDisplay />

// Purchase button
<PurchaseCreditsButton amount={50} />
\`\`\`

Approximate costs: Chat $0.01-0.10 | Image $0.50-2.00 | Video $5-20
`;

const ANALYTICS_GUIDANCE = `## Analytics

Analytics are automatic via ElizaProvider. For custom tracking:
\`\`\`tsx
import { trackPageView } from '@/lib/eliza';
trackPageView('/custom-path');
\`\`\`
`;

// Re-export for convenience
export { BASE_SYSTEM_PROMPT } from "./base";
export { SDK_REFERENCE, SDK_RESTRICTIONS } from "./sdk";
export { BUILD_RULES, WORKFLOW_RULES } from "./rules";
export { TEMPLATE_PROMPTS, TEMPLATE_EXAMPLES } from "./templates";
export { DATABASE_SETUP_PROMPT, DATABASE_SECURITY_RULES } from "./database";
