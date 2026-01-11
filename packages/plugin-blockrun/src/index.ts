/**
 * @elizaos/plugin-blockrun
 *
 * BlockRun x402 pay-per-request AI plugin for ElizaOS.
 *
 * This plugin enables ElizaOS agents to make LLM API calls using the x402 protocol,
 * paying with USDC micropayments on Base chain. No API keys required - just a wallet.
 *
 * Features:
 * - Pay-per-request AI access (OpenAI, Anthropic, Google, etc.)
 * - Automatic x402 micropayment handling
 * - USDC payments on Base chain
 * - Wallet balance provider for agent context
 *
 * Configuration:
 * Set BASE_CHAIN_WALLET_KEY in your agent settings or environment.
 *
 * @example
 * ```typescript
 * import { blockrunPlugin } from '@elizaos/plugin-blockrun';
 *
 * const agent = new Agent({
 *   plugins: [blockrunPlugin],
 *   settings: {
 *     BASE_CHAIN_WALLET_KEY: '0x...',
 *   },
 * });
 * ```
 *
 * @see https://blockrun.ai
 * @see https://x402.org
 */

import type { Plugin } from '@elizaos/core';
import { blockrunChatAction } from './actions/chat';
import { blockrunWalletProvider } from './providers/wallet';

// Re-export individual components
export * from './actions';
export * from './providers';

/**
 * BlockRun Plugin for ElizaOS
 *
 * Enables pay-per-request AI via x402 micropayments on Base.
 */
export const blockrunPlugin: Plugin = {
  name: 'blockrun',
  description: 'Pay-per-request AI via x402 micropayments on Base. Access OpenAI, Anthropic, Google, and more without API keys.',
  actions: [blockrunChatAction],
  providers: [blockrunWalletProvider],
  evaluators: [],
  services: [],
};

export default blockrunPlugin;
