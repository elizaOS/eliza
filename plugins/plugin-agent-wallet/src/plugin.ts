import type { Plugin } from "@elizaos/core";
import { unifiedWalletProvider } from "./providers/unified-wallet-provider.js";
import { WalletBackendService } from "./services/wallet-backend-service.js";

/**
 * Unified wallet + trading surface. Canonical actions ship incrementally; Phase 0
 * wires the wallet backend service + `wallet` provider + lifted SDK re-exports.
 */
export const agentWalletPlugin: Plugin = {
	name: "agent-wallet",
	description:
		"Unified non-custodial wallet for elizaOS — EVM + Solana, x402, CCTP, routing, LP, and venue providers (canonical actions landing incrementally).",
	services: [WalletBackendService],
	providers: [unifiedWalletProvider],
	actions: [],
	evaluators: [],
};

export default agentWalletPlugin;
