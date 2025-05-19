/**
 * RAG Plugin - Main Entry Point
 *
 * This file exports all the necessary functions and types for the RAG plugin.
 */

import type { Plugin, IAgentRuntime } from '@elizaos/core';
import { logger } from '@elizaos/core';
import { validateModelConfig } from './config';
import { RagService } from './service';

/**
 * RAG Plugin - Provides Retrieval Augmented Generation capabilities
 */
export const ragPlugin: Plugin = {
  name: 'plugin-rag',
  description:
    'Plugin for Retrieval Augmented Generation, including knowledge management and embedding.',
  config: {
    // Embedding configuration (can use plugin-openai settings automatically)
    EMBEDDING_PROVIDER: process.env.EMBEDDING_PROVIDER,
    TEXT_EMBEDDING_MODEL: process.env.TEXT_EMBEDDING_MODEL,
    EMBEDDING_DIMENSION: process.env.EMBEDDING_DIMENSION,

    // Text generation (only required when CTX_RAG_ENABLED=true)
    TEXT_PROVIDER: process.env.TEXT_PROVIDER,
    TEXT_MODEL: process.env.TEXT_MODEL,

    // API keys (will depend on selected providers)
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,

    // Optional base URLs
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
    OPENROUTER_BASE_URL: process.env.OPENROUTER_BASE_URL,
    GOOGLE_BASE_URL: process.env.GOOGLE_BASE_URL,

    // Token limits
    MAX_INPUT_TOKENS: process.env.MAX_INPUT_TOKENS,
    MAX_OUTPUT_TOKENS: process.env.MAX_OUTPUT_TOKENS,

    // Contextual RAG settings
    CTX_RAG_ENABLED: process.env.CTX_RAG_ENABLED || 'false',
  },
  async init(config: Record<string, string>, runtime?: IAgentRuntime) {
    logger.info('Initializing RAG Plugin...');
    try {
      // Validate the model configuration
      logger.info('Validating model configuration for RAG plugin...');
      const validatedConfig = validateModelConfig();

      // Log the operational mode
      if (validatedConfig.CTX_RAG_ENABLED) {
        logger.info('Running in Contextual RAG mode with text generation capabilities.');
        logger.info(
          `Using ${validatedConfig.EMBEDDING_PROVIDER} for embeddings and ${validatedConfig.TEXT_PROVIDER} for text generation.`
        );
      } else {
        const usingPluginOpenAI = !process.env.EMBEDDING_PROVIDER;

        if (usingPluginOpenAI) {
          logger.info(
            'Running in Basic Embedding mode with auto-detected configuration from plugin-openai.'
          );
        } else {
          logger.info(
            'Running in Basic Embedding mode (CTX_RAG_ENABLED=false). TEXT_PROVIDER and TEXT_MODEL not required.'
          );
        }

        logger.info(
          `Using ${validatedConfig.EMBEDDING_PROVIDER} for embeddings with ${validatedConfig.TEXT_EMBEDDING_MODEL}.`
        );
      }

      logger.info('Model configuration validated successfully.');

      if (runtime) {
        logger.info(`RAG Plugin initialized for agent: ${runtime.agentId}`);
      }
      logger.info('RAG Plugin initialized.');
    } catch (error) {
      logger.error('Failed to initialize RAG plugin:', error);
      throw error;
    }
  },
  services: [RagService],
};

export default ragPlugin;
