import type { IAgentRuntime } from '@elizaos/core';
import { logger } from '@elizaos/core';
import { z } from 'zod';

/**
 * Configuration schema for the Signet plugin.
 *
 * - SIGNET_BASE_URL: Signet API endpoint (defaults to production)
 * - SIGNET_PRIVATE_KEY: EVM private key for signing x402 payments
 * - SIGNET_RPC_URL: Base chain RPC endpoint
 */
export const configSchema = z.object({
  SIGNET_BASE_URL: z
    .string()
    .url()
    .optional()
    .default('https://signet.sebayaki.com')
    .describe('Signet API base URL'),
  SIGNET_PRIVATE_KEY: z
    .string()
    .optional()
    .describe('Private key for signing x402 payments'),
  SIGNET_RPC_URL: z
    .string()
    .url()
    .optional()
    .default('https://mainnet.base.org')
    .describe('Base chain RPC URL'),
});

export interface SignetConfig {
  baseUrl: string;
  rpcUrl: string;
}

/**
 * Resolves the Signet configuration from the agent runtime settings.
 * Falls back to sensible defaults for Base mainnet.
 */
export function getSignetConfig(runtime: IAgentRuntime): SignetConfig {
  const baseUrl = (
    runtime.getSetting('SIGNET_BASE_URL') || 'https://signet.sebayaki.com'
  ).replace(/\/$/, '');
  const rpcUrl = runtime.getSetting('SIGNET_RPC_URL') || 'https://mainnet.base.org';

  return { baseUrl, rpcUrl };
}

/**
 * Resolves the private key from runtime settings.
 * Checks SIGNET_PRIVATE_KEY, BASE_PRIVATE_KEY, and EVM_PRIVATE_KEY in order.
 * Returns null if no key is configured.
 */
export function getPrivateKey(runtime: IAgentRuntime): string | null {
  const key =
    runtime.getSetting('SIGNET_PRIVATE_KEY') ||
    runtime.getSetting('BASE_PRIVATE_KEY') ||
    runtime.getSetting('EVM_PRIVATE_KEY');

  if (!key) {
    logger.warn(
      'Signet: No private key configured. Set SIGNET_PRIVATE_KEY, BASE_PRIVATE_KEY, or EVM_PRIVATE_KEY.'
    );
    return null;
  }

  return key.startsWith('0x') ? key : `0x${key}`;
}
