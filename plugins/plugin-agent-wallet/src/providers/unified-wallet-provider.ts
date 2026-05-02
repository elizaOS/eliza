import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import { WalletBackendService } from "../services/wallet-backend-service.js";
import {
	WalletBackendNotConfiguredError,
	StewardUnavailableError,
} from "../wallet/errors.js";

/**
 * Injects live addresses into planner context. Always-on (200-token budget in spec).
 */
export const unifiedWalletProvider: Provider = {
	name: "wallet",
	description:
		"Unified non-custodial wallet — EVM + Solana addresses (Milady agent-wallet plugin).",
	position: -5,
	dynamic: true,
	get: async (runtime: IAgentRuntime, _message: Memory, _state: State) => {
		void _message;
		void _state;
		const svc = runtime.getService(
			"wallet-backend",
		) as WalletBackendService | null;
		if (!svc) {
			return {
				text: "## Wallet\nWallet backend service is not running.",
				values: { walletReady: false },
			};
		}
		try {
			const w = svc.getWalletBackend();
			const { evm, solana } = w.getAddresses();
			const evmLine = evm ? `- EVM: ${evm}` : "- EVM: (not configured)";
			const solLine = solana
				? `- Solana: ${solana.toBase58()}`
				: "- Solana: (not configured)";
			return {
				text: `## Wallet\n${evmLine}\n${solLine}`,
				values: {
					walletReady: evm !== null || solana !== null,
					evmAddress: evm ?? null,
					solanaAddress: solana?.toBase58() ?? null,
					backendKind: w.kind,
				},
			};
		} catch (e) {
			if (
				e instanceof WalletBackendNotConfiguredError ||
				e instanceof StewardUnavailableError
			) {
				return {
					text: `## Wallet\n${e.message}`,
					values: { walletReady: false, walletError: e.name },
				};
			}
			throw e;
		}
	},
};
