import { walletRouterAction } from "@elizaos/plugin-wallet";

/**
 * Compatibility export for the old WALLET_PREPARE action module.
 * Preview mode is now WALLET with mode="prepare".
 */
export const walletPrepareAction = walletRouterAction;

export default walletRouterAction;
