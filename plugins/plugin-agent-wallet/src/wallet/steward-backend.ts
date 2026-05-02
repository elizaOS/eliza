import { PublicKey } from "@solana/web3.js";
import type { Account } from "viem";
import { hexToBytes } from "viem";
import type { Hex, TypedDataDefinition } from "viem";
import type { IAgentRuntime } from "@elizaos/core";
import type { WalletBackend, WalletAddresses } from "./backend.js";
import { StewardUnavailableError } from "./errors.js";
import type { SignResult, SignScope } from "./pending.js";

/**
 * Cloud / mobile signing via Steward for EVM. Solana addresses may be exposed from
 * Steward when `/vault/.../addresses` returns them; Solana **transaction** signing is
 * not implemented here yet — callers must treat Solana writes as unavailable until wired.
 */
export class StewardBackend implements WalletBackend {
	readonly kind = "steward" as const;

	private readonly account: Account;

	private readonly solanaPubkey: PublicKey | null;

	private constructor(account: Account, solanaPubkey: PublicKey | null) {
		this.account = account;
		this.solanaPubkey = solanaPubkey;
	}

	static async create(_runtime: IAgentRuntime): Promise<StewardBackend> {
		void _runtime;
		let steward: typeof import("@elizaos/app-steward/services/steward-evm-account");
		try {
			steward = await import("@elizaos/app-steward/services/steward-evm-account");
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			throw new StewardUnavailableError(
				`Cannot load Steward wallet module (@elizaos/app-steward): ${detail}`,
			);
		}

		const account = await steward.initStewardEvmAccount();
		if (!account) {
			throw new StewardUnavailableError(
				"Steward EVM account initialization failed. Set STEWARD_API_URL, STEWARD_AGENT_TOKEN, and STEWARD_AGENT_ID (or a JWT whose payload contains agentId/sub).",
			);
		}

		const cfg = steward.resolveStewardEvmConfig();
		if (!cfg) {
			throw new StewardUnavailableError(
				"Steward env configuration resolved to null after account init.",
			);
		}

		const chains = await steward.fetchStewardVaultChainAddresses(
			cfg.apiUrl,
			cfg.agentToken,
			cfg.agentId,
		);

		let solanaPubkey: PublicKey | null = null;
		if (chains.solana) {
			try {
				solanaPubkey = new PublicKey(chains.solana);
			} catch {
				solanaPubkey = null;
			}
		}

		return new StewardBackend(account, solanaPubkey);
	}

	getAddresses(): WalletAddresses {
		return {
			evm: this.account.address as WalletAddresses["evm"],
			solana: this.solanaPubkey,
		};
	}

	canSign(chainHint: "evm" | "solana" | "off-chain"): boolean {
		if (chainHint === "solana") {
			return false;
		}
		return true;
	}

	getEvmAccount(_chainId: number): Account {
		void _chainId;
		return this.account;
	}

	getSolanaSigner(): never {
		throw new StewardUnavailableError(
			"Solana transaction signing via Steward is not implemented in this runtime yet.",
		);
	}

	async signMessage(scope: SignScope, message: Hex): Promise<SignResult> {
		void scope;
		const sig = await this.account.signMessage({
			message: { raw: hexToBytes(message) },
		});
		return { kind: "signature", signature: sig };
	}

	async signTypedData(
		scope: SignScope,
		typedData: TypedDataDefinition,
	): Promise<SignResult> {
		void scope;
		const sig = await this.account.signTypedData(typedData);
		return { kind: "signature", signature: sig };
	}
}
