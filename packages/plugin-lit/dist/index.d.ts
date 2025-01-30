import { Action, Plugin } from '@elizaos/core';

declare const HELLO_LIT_ACTION: Action;

declare const WALLET_TRANSFER_LIT_ACTION: Action;

/**
 * Action for executing an ECDSA signing using the Lit Protocol.
 */
declare const ECDSA_SIGN_LIT_ACTION: Action;

/**
 * Action for executing a Uniswap swap using the Lit Protocol.
 */
declare const UNISWAP_SWAP_LIT_ACTION: Action;

declare const litPlugin: Plugin;

export { ECDSA_SIGN_LIT_ACTION, HELLO_LIT_ACTION, UNISWAP_SWAP_LIT_ACTION, WALLET_TRANSFER_LIT_ACTION, litPlugin as default, litPlugin };
