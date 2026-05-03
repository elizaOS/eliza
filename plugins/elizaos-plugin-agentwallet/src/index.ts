import type { Plugin } from '@elizaos/core';
import { balanceAction } from './actions/balance';
import { transferAction } from './actions/transfer';
import { swapAction } from './actions/swap';
import { bridgeAction } from './actions/bridge';
import { x402PayAction } from './actions/x402pay';
import { walletProvider } from './providers/wallet';

export { balanceAction, transferAction, swapAction, bridgeAction, x402PayAction, walletProvider };
export * from './types';

/**
 * elizaos-plugin-agentwallet
 *
 * Gives ElizaOS agents a fully non-custodial wallet with:
 *  - EVM support: Base, Arbitrum, Optimism, Ethereum
 *  - Solana support: mainnet + devnet
 *  - x402 micropayments (agent-to-agent or agent-to-API)
 *  - CCTP cross-chain bridge (17 chains, USDC)
 *  - Jupiter swaps (Solana) + Uniswap V3 (EVM)
 *  - Spend limits — cap per-tx amount so no single action drains the wallet
 *
 * Required agent settings:
 *  AGENTWALLET_PRIVATE_KEY        — private key (hex for EVM, base58 for Solana)
 *  AGENTWALLET_CHAIN              — 'evm' | 'solana'
 *  AGENTWALLET_EVM_NETWORK        — 'base' | 'arbitrum' | 'optimism' | 'ethereum' (default: base)
 *  AGENTWALLET_SOLANA_NETWORK     — 'mainnet-beta' | 'devnet' (default: mainnet-beta)
 *  AGENTWALLET_SPEND_LIMIT_USD    — max USD per transaction (default: 50)
 *  AGENTWALLET_RPC_URL            — optional custom RPC (recommended for production)
 */
const agentWalletPlugin: Plugin = {
  name: 'agentwallet',
  description:
    'Non-custodial wallet plugin for ElizaOS — EVM + Solana, x402 micropayments, CCTP cross-chain bridge, spend limits.',
  actions: [balanceAction, transferAction, swapAction, bridgeAction, x402PayAction],
  providers: [walletProvider],
  evaluators: [],
};

export default agentWalletPlugin;
