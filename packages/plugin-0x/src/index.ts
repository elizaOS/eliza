import { Plugin } from "@elizaos/core";
import { getIndicativePrice } from "./actions/getIndicativePrice";
import { getQuote } from "./actions/getQuote";
import { swap } from "./actions/swap";

export const zxPlugin: Plugin = {
    name: "0x",
    description: "0x Plugin for Eliza",
    actions: [
        getIndicativePrice,
        getQuote,
        swap,
    ],
    evaluators: [],
    providers: [],
};

export default zxPlugin;
