import { generateText as aiGenerateText, embed, GenerateTextResult } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { google } from '@ai-sdk/google';
import { ModelConfig, TextGenerationOptions } from './types';
import { validateModelConfig } from './config';
import { logger } from '@elizaos/core';

// Re-export for backwards compatibility
export { validateModelConfig } from './config';
export { getProviderRateLimits } from './config';
export type { ModelConfig, ProviderRateLimits } from './types';
