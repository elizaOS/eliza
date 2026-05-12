/**
 * @module swap
 * Re-exports for the SwapModule: multi-chain Uniswap V3 swaps.
 *
 * Supported chains: base, arbitrum, optimism, polygon.
 * Use SwapModule directly or attachSwap(wallet, { chain }) for a wallet-bound instance.
 */

export { ERC20Abi, UniswapV3QuoterV2Abi, UniswapV3RouterAbi } from "./abi.js";
export {
  applySlippage,
  attachSwap,
  calcDeadline,
  calcProtocolFee,
  SwapModule,
} from "./SwapModule.js";
export type {
  SwapChain,
  SwapModuleConfig,
  SwapOptions,
  SwapQuote,
  SwapResult,
  UniswapFeeTier,
} from "./types.js";
export {
  ARBITRUM_TOKENS,
  BASE_TOKENS,
  DEFAULT_SLIPPAGE_BPS,
  OPTIMISM_TOKENS,
  POLYGON_TOKENS,
  PROTOCOL_FEE_BPS,
  PROTOCOL_FEE_COLLECTOR,
  UNISWAP_V3_ADDRESSES,
} from "./types.js";
