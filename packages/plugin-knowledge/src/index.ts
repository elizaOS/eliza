/**
 * Knowledge Plugin - Main Entry Point
 *
 * This file exports all the necessary functions and types for the Knowledge plugin.
 */
import type { Plugin, IAgentRuntime } from '@elizaos/core';
import { logger } from '@elizaos/core';
import { validateModelConfig } from './config';
import { KnowledgeService } from './service';

/**
 * Knowledge Plugin - Provides Retrieval Augmented Generation capabilities
 */
export const knowledgePlugin: Plugin = {
  name: 'knowledge',
  description:
    'Plugin for Retrieval Augmented Generation, including knowledge management and embedding.',
  config: {
    // Token limits
    MAX_INPUT_TOKENS: process.env.MAX_INPUT_TOKENS,
    MAX_OUTPUT_TOKENS: process.env.MAX_OUTPUT_TOKENS,

    // Contextual Knowledge settings
    CTX_KNOWLEDGE_ENABLED: process.env.CTX_KNOWLEDGE_ENABLED || 'false',
  },
  async init(config: Record<string, string>, runtime?: IAgentRuntime) {
    logger.info('Initializing Knowledge Plugin...');
    try {
      // Validate the model configuration
      logger.info('Validating model configuration for Knowledge plugin...');
      const validatedConfig = validateModelConfig();

      // Log the operational mode
      if (validatedConfig.CTX_KNOWLEDGE_ENABLED) {
        logger.info('Running in Contextual Knowledge mode with text generation capabilities.');
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
            'Running in Basic Embedding mode (CTX_KNOWLEDGE_ENABLED=false). TEXT_PROVIDER and TEXT_MODEL not required.'
          );
        }

        logger.info(
          `Using ${validatedConfig.EMBEDDING_PROVIDER} for embeddings with ${validatedConfig.TEXT_EMBEDDING_MODEL}.`
        );
      }

      logger.info('Model configuration validated successfully.');

      if (runtime) {
        logger.info(`Knowledge Plugin initialized for agent: ${runtime.agentId}`);
      }
      logger.info('Knowledge Plugin initialized.');
    } catch (error) {
      logger.error('Failed to initialize Knowledge plugin:', error);
      throw error;
    }
  },
  services: [KnowledgeService],
};

export default knowledgePlugin;
