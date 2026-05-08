import { walletRouterAction } from "../../wallet-action";

/**
 * Compatibility export for code importing the old SOLANA_SWAP action module.
 * Solana swaps are now routed through WALLET with target="solana" and
 * subaction="swap".
 */
export const executeSwap = walletRouterAction;

export default walletRouterAction;
