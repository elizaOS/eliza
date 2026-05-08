import { walletRouterAction } from "@elizaos/plugin-wallet";

/**
 * Compatibility export for the old EXECUTE_TRADE action module.
 * Trades are now WALLET swap operations with mode="execute".
 */
export const executeTradeAction = walletRouterAction;

export default walletRouterAction;
