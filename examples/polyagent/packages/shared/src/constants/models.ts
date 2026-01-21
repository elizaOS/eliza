/**
 * AI Model Configuration
 *
 * Centralized configuration for AI models used across the platform.
 * This is the SINGLE SOURCE OF TRUTH for model selection.
 * To change models, update the modelId values here.
 *
 * @example Frontend usage:
 * ```tsx
 * import { GROQ_MODELS } from '@polyagent/shared';
 * <span>{GROQ_MODELS.FREE.displayName}</span> // "Groq 8B"
 * ```
 *
 * @example Backend usage:
 * ```ts
 * import { GROQ_MODELS } from '@polyagent/shared';
 * const modelId = usePro ? GROQ_MODELS.PRO.modelId : GROQ_MODELS.FREE.modelId;
 * ```
 */

/**
 * Groq model configuration interface
 */
export interface GroqModelConfig {
  /** Human-readable display name for UI */
  displayName: string;
  /** Actual Groq model identifier for API calls */
  modelId: string;
  /** User-facing tier name */
  tier: "free" | "pro";
  /** Short description for UI tooltips */
  description: string;
}

/**
 * Groq model configurations by tier
 *
 * SINGLE SOURCE OF TRUTH for model selection.
 * To change models, update the modelId values here.
 */
export const GROQ_MODELS = {
  /** Free tier model - fast and efficient */
  FREE: {
    displayName: "GPT-OSS 20B",
    modelId: "openai/gpt-oss-20b",
    tier: "free",
    description: "Fast and efficient for everyday tasks",
  },
  /** Pro tier model - more capable */
  PRO: {
    displayName: "Kimi K2",
    modelId: "moonshotai/kimi-k2-instruct",
    tier: "pro",
    description: "Advanced reasoning and complex tasks",
  },
} as const satisfies Record<string, GroqModelConfig>;

/** Type for Groq model tier keys */
export type GroqModelTier = keyof typeof GROQ_MODELS;

/**
 * Get model config by tier string
 *
 * @param tier - 'free' or 'pro'
 * @returns The corresponding model configuration
 *
 * @example
 * ```ts
 * const config = getGroqModelByTier(agent.modelTier);
 * console.log(config.displayName); // "Groq 8B" or "Groq 70B"
 * ```
 */
export function getGroqModelByTier(tier: "free" | "pro"): GroqModelConfig {
  return tier === "pro" ? GROQ_MODELS.PRO : GROQ_MODELS.FREE;
}
