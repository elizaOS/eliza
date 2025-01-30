import type { Plugin } from "@elizaos/core";
import transferAction from "./actions/trikon";
import { walletProvider } from "./providers/wallet";

export const trikonPlugin: Plugin = {
    name: "trikon",
    description: "Trikon Plugin for Eliza - POC for token transfer functionality",
    actions: [transferAction],
    evaluators: [], // No evaluators needed for POC
    providers: [walletProvider],
    services: [], // No services needed for POC
    clients: [], // No clients needed for POC
};

// Export types and utilities
export * from "./providers/wallet";
export { transferAction as TransferTrikonToken };
export default trikonPlugin;