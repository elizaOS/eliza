export * from "./actions/helloLit/helloLit";
export * from "./actions/tools/erc20transfer/toolCall";
export * from "./actions/tools/ecdsaSign/toolCall";
export * from "./actions/tools/uniswapSwap/toolCall";

import type { Plugin } from "@elizaos/core";
import { HELLO_LIT_ACTION } from "./actions/helloLit/helloLit";
import { WALLET_TRANSFER_LIT_ACTION } from "./actions/tools/erc20transfer/toolCall";
import { ECDSA_SIGN_LIT_ACTION } from "./actions/tools/ecdsaSign/toolCall";
import { UNISWAP_SWAP_LIT_ACTION } from "./actions/tools/uniswapSwap/toolCall";

export const litPlugin: Plugin = {
    name: "lit",
    description: "Lit Protocol integration plugin",
    providers: [],
    evaluators: [],
    services: [],
    actions: [WALLET_TRANSFER_LIT_ACTION, HELLO_LIT_ACTION, 
              ECDSA_SIGN_LIT_ACTION, UNISWAP_SWAP_LIT_ACTION],
};

export default litPlugin;
