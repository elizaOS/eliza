import type { PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import type { Account as ViemAccount } from "viem/accounts";
import type { Hex, TypedDataDefinition } from "viem";
import type { SignResult, SignScope } from "./pending.js";

/**
 * Narrow signing surface for Solana venues (swap, LP, transfers).
 */
export interface SolanaSigner {
	readonly publicKey: PublicKey;
	signTransaction(
		tx: Transaction | VersionedTransaction,
	): Promise<Transaction | VersionedTransaction>;
	signAllTransactions(
		txs: ReadonlyArray<Transaction | VersionedTransaction>,
	): Promise<Array<Transaction | VersionedTransaction>>;
}

export interface WalletAddresses {
	readonly evm: `0x${string}`;
	readonly solana: PublicKey;
}

export type WalletBackendKind = "local" | "steward";

/**
 * Canonical wallet abstraction. Providers and canonical actions reach signing
 * only through this interface — never via raw env reads inside venue code.
 *
 * See docs/architecture/wallet-and-trading.md §A.
 */
export interface WalletBackend {
	readonly kind: WalletBackendKind;

	getAddresses(): WalletAddresses;

	/**
	 * Returns true when this backend can satisfy signing for the given hint.
	 * Read-only QUERY_* flows may skip wallet checks per spec.
	 */
	canSign(chainHint: "evm" | "solana" | "off-chain"): boolean;

	getEvmAccount(chainId: number): ViemAccount;

	getSolanaSigner(): SolanaSigner;

	signMessage(scope: SignScope, message: Hex): Promise<SignResult>;

	signTypedData(
		scope: SignScope,
		typedData: TypedDataDefinition,
	): Promise<SignResult>;
}
