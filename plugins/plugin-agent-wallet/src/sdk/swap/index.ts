/**
 * @module swap
 * Re-exports for the SwapModule: multi-chain Uniswap V3 swaps.
 *
 * Supported chains: base, arbitrum, optimism, polygon.
 * Use SwapModule directly or attachSwap(wallet, { chain }) for a wallet-bound instance.
 */
export { SwapModule, attachSwap, calcProtocolFee, applySlippage, calcDeadline } from './SwapModule.js';
export { UniswapV3RouterAbi, UniswapV3QuoterV2Abi, ERC20Abi } from './abi.js';
export {
  BASE_TOKENS, ARBITRUM_TOKENS, OPTIMISM_TOKENS, POLYGON_TOKENS,
  UNISWAP_V3_BASE, UNISWAP_V3_ADDRESSES,
  PROTOCOL_FEE_BPS, PROTOCOL_FEE_COLLECTOR, DEFAULT_SLIPPAGE_BPS,
} from './types.js';
export type { UniswapFeeTier, SwapChain, SwapQuote, SwapOptions, SwapResult, SwapModuleConfig } from './types.js';
