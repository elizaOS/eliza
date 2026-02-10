import type { Plugin } from '@elizaos/core';
import { logger } from '@elizaos/core';
import { configSchema } from './config.ts';
import { estimateSpotlightAction } from './actions/estimate.ts';
import { postSpotlightAction } from './actions/post.ts';
import { spotlightProvider } from './providers/spotlight.ts';
import { z } from 'zod';

/**
 * Signet plugin for ElizaOS.
 *
 * Enables agents to buy spotlight ads on Signet (https://signet.sebayaki.com),
 * an onchain advertising platform on Base. Payments are made in USDC via the
 * x402 protocol (HTTP 402 micropayments).
 *
 * Actions:
 * - SIGNET_ESTIMATE: Check current spotlight pricing
 * - SIGNET_POST_SPOTLIGHT: Pay USDC to place a URL in the spotlight
 *
 * Providers:
 * - SIGNET_SPOTLIGHT_STATUS: Injects pricing context into the agent
 */
export const signetPlugin: Plugin = {
  name: 'plugin-signet',
  description:
    'Signet onchain advertising — buy spotlight ads on Base with USDC via x402 payments',

  config: {
    SIGNET_BASE_URL: process.env.SIGNET_BASE_URL || 'https://signet.sebayaki.com',
    SIGNET_PRIVATE_KEY: process.env.SIGNET_PRIVATE_KEY,
    SIGNET_RPC_URL: process.env.SIGNET_RPC_URL || 'https://mainnet.base.org',
  },

  async init(config: Record<string, string>) {
    logger.info('Signet: plugin initializing...');
    try {
      const validated = await configSchema.parseAsync(config);
      for (const [key, value] of Object.entries(validated)) {
        if (value) process.env[key] = value;
      }
      logger.info('Signet: plugin initialized');
    } catch (error) {
      if (error instanceof z.ZodError) {
        const messages =
          error.issues?.map((e) => e.message)?.join(', ') || 'Unknown validation error';
        throw new Error(`Invalid Signet plugin configuration: ${messages}`);
      }
      throw error;
    }
  },

  actions: [estimateSpotlightAction, postSpotlightAction],
  providers: [spotlightProvider],
};
