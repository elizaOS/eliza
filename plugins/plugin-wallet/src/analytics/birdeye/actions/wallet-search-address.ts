import { tokenInfoAction } from "../../token-info/action";

/**
 * Compatibility export for the old BIRDEYE_LOOKUP action module.
 * Birdeye lookup is now TOKEN_INFO with target="birdeye".
 */
export const walletSearchAddressAction = tokenInfoAction;

export default tokenInfoAction;
