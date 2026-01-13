/**
 * Model pricing data for cost calculation
 * Based on actual API pricing as of 2024
 */

export interface ModelPricing {
  inputCostPer1k: number; // Cost per 1000 input tokens in USD
  outputCostPer1k: number; // Cost per 1000 output tokens in USD
  maxInputTokens?: number;
  maxOutputTokens?: number;
  provider: string;
}

/**
 * Comprehensive model pricing database
 * Prices are in USD per 1000 tokens
 */
export const MODEL_PRICING: Record<string, ModelPricing> = {
  // Current OpenAI Models
  'gpt-4o': {
    inputCostPer1k: 0.005,
    outputCostPer1k: 0.015,
    maxInputTokens: 128000,
    maxOutputTokens: 4096,
    provider: 'openai',
  },
  'gpt-4o-mini': {
    inputCostPer1k: 0.00015,
    outputCostPer1k: 0.0006,
    maxInputTokens: 128000,
    maxOutputTokens: 16384,
    provider: 'openai',
  },
  'gpt-4-turbo': {
    inputCostPer1k: 0.01,
    outputCostPer1k: 0.03,
    maxInputTokens: 128000,
    maxOutputTokens: 4096,
    provider: 'openai',
  },
  'gpt-4': {
    inputCostPer1k: 0.03,
    outputCostPer1k: 0.06,
    maxInputTokens: 8192,
    maxOutputTokens: 8192,
    provider: 'openai',
  },
  'gpt-3.5-turbo': {
    inputCostPer1k: 0.0005,
    outputCostPer1k: 0.0015,
    maxInputTokens: 16385,
    maxOutputTokens: 4096,
    provider: 'openai',
  },

  // Future/Hypothetical OpenAI Models
  'gpt-5': {
    inputCostPer1k: 1.25,
    outputCostPer1k: 10.0,
    maxInputTokens: 128000,
    maxOutputTokens: 4096,
    provider: 'openai',
  },
  'gpt-5-mini': {
    inputCostPer1k: 0.25,
    outputCostPer1k: 2.0,
    maxInputTokens: 128000,
    maxOutputTokens: 4096,
    provider: 'openai',
  },
  'gpt-5-nano': {
    inputCostPer1k: 0.05,
    outputCostPer1k: 0.4,
    maxInputTokens: 128000,
    maxOutputTokens: 4096,
    provider: 'openai',
  },

  // Claude 4 Sonnet pricing is tiered based on prompt size.
  // For prompts ≤ 200K tokens:
  //   Input: $3 / 1K tokens, Output: $15 / 1K tokens
  // For prompts > 200K tokens:
  //   Input: $6 / 1K tokens, Output: $22.50 / 1K tokens
  // Prompt caching (not currently modeled in this structure):
  //   ≤ 200K: Write $3.75/1K, Read $0.30/1K
  //   >200K: Write $7.50/1K, Read $0.60/1K
  // This entry models the ≤ 200K tier for standard completions.
  'claude-4-sonnet': {
    inputCostPer1k: 0.003, // $3 / 1K tokens
    outputCostPer1k: 0.015, // $15 / 1K tokens
    maxInputTokens: 200000,
    maxOutputTokens: 4096,
    provider: 'anthropic',
  },
  // Claude 4.1 Opus pricing:
  //   Input: $15 / 1K tokens, Output: $75 / 1K tokens
  //   Prompt caching: Write $18.75/1K, Read $1.50/1K
  'claude-4-1-opus': {
    inputCostPer1k: 0.015, // $15 / 1K tokens
    outputCostPer1k: 0.075, // $75 / 1K tokens
    maxInputTokens: 200000,
    maxOutputTokens: 4096,
    provider: 'anthropic',
  },
  'claude-4-opus': {
    inputCostPer1k: 0.015, // $15 / 1K tokens
    outputCostPer1k: 0.075, // $75 / 1K tokens
    maxInputTokens: 200000,
    maxOutputTokens: 4096,
    provider: 'anthropic',
  },
  'claude-3-5-haiku': {
    inputCostPer1k: 0.00025,
    outputCostPer1k: 0.00125,
    maxInputTokens: 200000,
    maxOutputTokens: 4096,
    provider: 'anthropic',
  },

  // Google Models
  'gemini-pro': {
    inputCostPer1k: 0.00025,
    outputCostPer1k: 0.0005,
    maxInputTokens: 32760,
    maxOutputTokens: 8192,
    provider: 'google',
  },
  'gemini-1.5-pro': {
    inputCostPer1k: 0.00125,
    outputCostPer1k: 0.005,
    maxInputTokens: 2097152,
    maxOutputTokens: 8192,
    provider: 'google',
  },
  'gemini-1.5-flash': {
    inputCostPer1k: 0.000075,
    outputCostPer1k: 0.0003,
    maxInputTokens: 1048576,
    maxOutputTokens: 8192,
    provider: 'google',
  },

  // Cohere Models
  'command-r': {
    inputCostPer1k: 0.0005,
    outputCostPer1k: 0.0015,
    maxInputTokens: 128000,
    maxOutputTokens: 4000,
    provider: 'cohere',
  },
  'command-r-plus': {
    inputCostPer1k: 0.003,
    outputCostPer1k: 0.015,
    maxInputTokens: 128000,
    maxOutputTokens: 4000,
    provider: 'cohere',
  },

  // AWS Bedrock Models (same pricing as Anthropic)
  'bedrock/claude-3-opus': {
    inputCostPer1k: 0.015, // Same as claude-4-opus
    outputCostPer1k: 0.075, // Same as claude-4-opus
    maxInputTokens: 200000,
    maxOutputTokens: 4096,
    provider: 'bedrock',
  },
  'bedrock/claude-3-sonnet': {
    inputCostPer1k: 0.003, // Same as claude-4-sonnet
    outputCostPer1k: 0.015, // Same as claude-4-sonnet
    maxInputTokens: 200000,
    maxOutputTokens: 4096,
    provider: 'bedrock',
  },
  'bedrock/claude-3-haiku': {
    inputCostPer1k: 0.00025, // Same as claude-3-5-haiku
    outputCostPer1k: 0.00125, // Same as claude-3-5-haiku
    maxInputTokens: 200000,
    maxOutputTokens: 4096,
    provider: 'bedrock',
  },

  // Azure OpenAI Models (same pricing as OpenAI)
  'azure/gpt-4o': {
    inputCostPer1k: 0.005, // Same as gpt-4o
    outputCostPer1k: 0.015, // Same as gpt-4o
    maxInputTokens: 128000,
    maxOutputTokens: 4096,
    provider: 'azure',
  },
  'azure/gpt-4o-mini': {
    inputCostPer1k: 0.00015, // Same as gpt-4o-mini
    outputCostPer1k: 0.0006, // Same as gpt-4o-mini
    maxInputTokens: 128000,
    maxOutputTokens: 16384,
    provider: 'azure',
  },
  'azure/gpt-4': {
    inputCostPer1k: 0.03, // Same as gpt-4
    outputCostPer1k: 0.06, // Same as gpt-4
    maxInputTokens: 8192,
    maxOutputTokens: 8192,
    provider: 'azure',
  },
  'azure/gpt-4-turbo': {
    inputCostPer1k: 0.01, // Same as gpt-4-turbo
    outputCostPer1k: 0.03, // Same as gpt-4-turbo
    maxInputTokens: 128000,
    maxOutputTokens: 4096,
    provider: 'azure',
  },
  'azure/gpt-35-turbo': {
    inputCostPer1k: 0.0005, // Same as gpt-3.5-turbo
    outputCostPer1k: 0.0015, // Same as gpt-3.5-turbo
    maxInputTokens: 16385,
    maxOutputTokens: 4096,
    provider: 'azure',
  },

  // Together AI Models
  'together/llama-3-70b': {
    inputCostPer1k: 0.0009,
    outputCostPer1k: 0.0009,
    maxInputTokens: 8192,
    maxOutputTokens: 8192,
    provider: 'together',
  },
  'together/llama-3-8b': {
    inputCostPer1k: 0.0002,
    outputCostPer1k: 0.0002,
    maxInputTokens: 8192,
    maxOutputTokens: 8192,
    provider: 'together',
  },
  'together/mixtral-8x7b': {
    inputCostPer1k: 0.0006,
    outputCostPer1k: 0.0006,
    maxInputTokens: 32768,
    maxOutputTokens: 32768,
    provider: 'together',
  },

  // Mistral AI Models
  'mistral/mistral-large': {
    inputCostPer1k: 0.008,
    outputCostPer1k: 0.024,
    maxInputTokens: 32000,
    maxOutputTokens: 32000,
    provider: 'mistral',
  },
  'mistral/mistral-medium': {
    inputCostPer1k: 0.0027,
    outputCostPer1k: 0.0081,
    maxInputTokens: 32000,
    maxOutputTokens: 32000,
    provider: 'mistral',
  },
  'mistral/mistral-small': {
    inputCostPer1k: 0.002,
    outputCostPer1k: 0.006,
    maxInputTokens: 32000,
    maxOutputTokens: 32000,
    provider: 'mistral',
  },

  // Perplexity Models
  'perplexity/llama-3-sonar-large': {
    inputCostPer1k: 0.001,
    outputCostPer1k: 0.001,
    maxInputTokens: 32768,
    maxOutputTokens: 32768,
    provider: 'perplexity',
  },
  'perplexity/llama-3-sonar-small': {
    inputCostPer1k: 0.0002,
    outputCostPer1k: 0.0002,
    maxInputTokens: 32768,
    maxOutputTokens: 32768,
    provider: 'perplexity',
  },

  // DeepSeek Models
  'deepseek/deepseek-coder': {
    inputCostPer1k: 0.00014,
    outputCostPer1k: 0.00028,
    maxInputTokens: 128000,
    maxOutputTokens: 4096,
    provider: 'deepseek',
  },
  'deepseek/deepseek-chat': {
    inputCostPer1k: 0.00014,
    outputCostPer1k: 0.00028,
    maxInputTokens: 128000,
    maxOutputTokens: 4096,
    provider: 'deepseek',
  },

  // Local/Open Source Models (no cost)
  'ollama/llama3': {
    inputCostPer1k: 0,
    outputCostPer1k: 0,
    maxInputTokens: 8192,
    maxOutputTokens: 8192,
    provider: 'ollama',
  },
  'ollama/codellama': {
    inputCostPer1k: 0,
    outputCostPer1k: 0,
    maxInputTokens: 16384,
    maxOutputTokens: 16384,
    provider: 'ollama',
  },
  'ollama/mistral': {
    inputCostPer1k: 0,
    outputCostPer1k: 0,
    maxInputTokens: 32768,
    maxOutputTokens: 32768,
    provider: 'ollama',
  },
};

/**
 * Calculate cost for a model based on token usage
 */
export function calculateCost(modelName: string, inputTokens: number, outputTokens: number): number {
  // Try exact match first
  let pricing = MODEL_PRICING[modelName];

  // If not found, try to find a matching pattern
  if (!pricing) {
    // Handle versioned models (e.g., gpt-4-0613 -> gpt-4)
    const baseModel = modelName.replace(/-\d{4}$/, '').replace(/-\d{6}$/, '');
    pricing = MODEL_PRICING[baseModel];
  }

  // If still not found, try provider prefix matching
  if (!pricing) {
    for (const [key, value] of Object.entries(MODEL_PRICING)) {
      if (modelName.includes(key.replace(/^(azure|bedrock|together|mistral|perplexity|deepseek|ollama)\//, ''))) {
        pricing = value;
        break;
      }
    }
  }

  // Default pricing if model not found (conservative estimate)
  if (!pricing) {
    console.warn(`Model pricing not found for ${modelName}, using default pricing`);
    pricing = {
      inputCostPer1k: 0.001,
      outputCostPer1k: 0.002,
      provider: 'unknown',
    };
  }

  const inputCost = (inputTokens / 1000) * pricing.inputCostPer1k;
  const outputCost = (outputTokens / 1000) * pricing.outputCostPer1k;

  return inputCost + outputCost;
}

/**
 * Get model token limits
 */
export function getModelLimits(modelName: string): {
  maxInputTokens: number | undefined;
  maxOutputTokens: number | undefined;
} {
  const pricing = MODEL_PRICING[modelName];

  if (!pricing) {
    // Try to find a base model
    const baseModel = modelName.replace(/-\d{4}$/, '').replace(/-\d{6}$/, '');
    const basePricing = MODEL_PRICING[baseModel];

    if (basePricing) {
      return {
        maxInputTokens: basePricing.maxInputTokens,
        maxOutputTokens: basePricing.maxOutputTokens,
      };
    }
  }

  return {
    maxInputTokens: pricing?.maxInputTokens,
    maxOutputTokens: pricing?.maxOutputTokens,
  };
}

/**
 * Check if a model supports a certain number of tokens
 */
export function isWithinTokenLimit(modelName: string, inputTokens: number, outputTokens: number): boolean {
  const limits = getModelLimits(modelName);

  if (limits.maxInputTokens && inputTokens > limits.maxInputTokens) {
    return false;
  }

  if (limits.maxOutputTokens && outputTokens > limits.maxOutputTokens) {
    return false;
  }

  return true;
}
