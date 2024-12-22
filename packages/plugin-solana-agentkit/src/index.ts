export * from "./providers/token.ts";
export * from "./providers/wallet.ts";
export * from "./providers/trustScoreProvider.ts";
export * from "./evaluators/trust.ts";

import { Plugin } from "@elizaos/core";
import transferToken from "./actions/transfer.ts";
import { walletProvider } from "./providers/wallet.ts";
import { trustScoreProvider } from "./providers/trustScoreProvider.ts";
import { trustEvaluator } from "./evaluators/trust.ts";
import { TokenProvider } from "./providers/token.ts";
import { WalletProvider } from "./providers/wallet.ts";

export { TokenProvider, WalletProvider };

export const solanaAgentkitPlguin: Plugin = {
    name: "solana",
    description: "Solana Plugin with solana agent kit for Eliza",
    actions: [transferToken],
    evaluators: [trustEvaluator],
    providers: [walletProvider, trustScoreProvider],
};

export default solanaAgentkitPlguin;
