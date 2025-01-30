import { Plugin } from "@elizaos/core";
import { getWalletPortfolio } from "./actions/getWalletPortfolio/index.ts";
import { getWalletPositions } from "./actions/getWalletPositions/index.ts";
const zerionPlugin: Plugin = {
    name: "zerion",
    description: "Plugin for interacting with zerion API to fetch wallet portfolio data",
    actions: [getWalletPortfolio, getWalletPositions] // implement actions and use them here

};

export { zerionPlugin };

