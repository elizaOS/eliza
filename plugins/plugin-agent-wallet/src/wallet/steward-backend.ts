import type { IAgentRuntime } from "@elizaos/core";
import type { Hex, TypedDataDefinition } from "viem";
import { StewardUnavailableError } from "./errors.js";
import type { WalletBackend } from "./backend.js";
import type { SignResult, SignScope } from "./pending.js";

/**
 * Cloud / mobile signing via Steward. Lifted from app-steward in Phase 1.
 *
 * Until wired, `create` rejects so operators do not assume custody exists.
 */
export class StewardBackend implements WalletBackend {
	readonly kind = "steward" as const;

	static async create(_runtime: IAgentRuntime): Promise<StewardBackend> {
		void _runtime;
		throw new StewardUnavailableError(
			"StewardBackend is not wired in this package revision yet. Use MILADY_WALLET_BACKEND=local on desktop, or wait for the Steward bridge migration (Phase 1).",
		);
	}

	getAddresses(): never {
		throw new StewardUnavailableError("StewardBackend is not initialized.");
	}

	canSign(_chainHint: "evm" | "solana" | "off-chain"): boolean {
		void _chainHint;
		return false;
	}

	getEvmAccount(_chainId: number): never {
		void _chainId;
		throw new StewardUnavailableError("StewardBackend is not initialized.");
	}

	getSolanaSigner(): never {
		throw new StewardUnavailableError("StewardBackend is not initialized.");
	}

	async signMessage(_scope: SignScope, _message: Hex): Promise<SignResult> {
		void _scope;
		void _message;
		throw new StewardUnavailableError("StewardBackend is not initialized.");
	}

	async signTypedData(
		_scope: SignScope,
		_typedData: TypedDataDefinition,
	): Promise<SignResult> {
		void _scope;
		void _typedData;
		throw new StewardUnavailableError("StewardBackend is not initialized.");
	}
}
