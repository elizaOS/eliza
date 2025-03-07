import type { Plugin } from "@elizaos/core";
import { executeSwap } from "./actions/swap.ts";
import transferToken from "./actions/transfer.ts";
import { walletProvider } from "./providers/wallet.ts";
import { SolanaService } from "./service.ts";
import { SOLANA_SERVICE_NAME } from "./constants.ts";

export const solanaPlugin: Plugin = {
	name: SOLANA_SERVICE_NAME,
	description: "Solana Plugin for Eliza",
	actions: [transferToken, executeSwap],
	evaluators: [],
	providers: [walletProvider],
	services: [SolanaService],
};
export default solanaPlugin;
