import type { Plugin } from "@elizaos/core";
import createToken from "./actions/createToken.ts";
import swap from "./actions/swap.ts";
import lend from "./actions/lend.ts";
import stake from "./actions/stake.ts";
import transfer from "./actions/transfer.ts";
import getTokenInfo from "./actions/getTokenInfo.ts";
import gibwork from "./actions/gibwork.ts";

export const solanaAgentkitPlugin: Plugin = {
    name: "solana",
    description: "Solana Plugin with solana agent kit for Eliza",
    actions: [createToken, swap, lend, stake, transfer, getTokenInfo, gibwork],
    evaluators: [],
    providers: [],
};

export default solanaAgentkitPlugin;
