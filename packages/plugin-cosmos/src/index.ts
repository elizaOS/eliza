import { Plugin } from "@ai16z/eliza/src/types";
import { walletProvider } from "./providers/wallet";
import { executeTransfer } from "./actions/transfer";
// If you want to implement swap, custom tokens, etc., create the files similarly and import them.

export const cosmosPlugin: Plugin = {
  name: "COSMOS",
  description: "Cosmos (e.g. Osmosis) Plugin for Eliza",
  providers: [walletProvider],
  actions: [executeTransfer],
  evaluators: [],
};

export default cosmosPlugin;
