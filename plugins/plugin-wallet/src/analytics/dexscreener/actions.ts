import { tokenInfoAction } from "../token-info/action";

/**
 * Compatibility exports for the old DexScreener action modules.
 * DexScreener is now a TOKEN_INFO provider selected with target="dexscreener".
 */
export const searchTokensAction = tokenInfoAction;
export const getTokenInfoAction = tokenInfoAction;
export const getTrendingAction = tokenInfoAction;
export const getNewPairsAction = tokenInfoAction;
export const getPairsByChainAction = tokenInfoAction;
export const getBoostedTokensAction = tokenInfoAction;
export const getTokenProfilesAction = tokenInfoAction;

export const dexscreenerActions = [tokenInfoAction];
