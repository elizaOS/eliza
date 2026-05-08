import { walletRouterAction } from "../../wallet-action";

/**
 * Compatibility export for code importing the old WALLET_GOV action module.
 * Governance is now routed through WALLET with subaction="gov".
 */
export const govOpAction = walletRouterAction;

export default walletRouterAction;
