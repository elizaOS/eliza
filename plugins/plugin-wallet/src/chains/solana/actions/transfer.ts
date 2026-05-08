import { walletRouterAction } from "../../wallet-action";

/**
 * Compatibility export for code importing the old SOLANA_TRANSFER action
 * module. Solana transfers are now routed through WALLET with target="solana"
 * and subaction="transfer".
 */
export default walletRouterAction;
