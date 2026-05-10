import type {
  PublicKey,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import type { Account, Hex, TypedDataDefinition } from "viem";
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
  /**
   * Detached Ed25519 signature of an opaque message. Returned bytes are 64
   * bytes (raw signature). Used by Wallet-Standard `signMessage` and any
   * non-transaction sign-in flows.
   */
  signMessage(message: Uint8Array): Promise<Uint8Array>;
}

export interface WalletAddresses {
  readonly evm: `0x${string}` | null;
  readonly solana: PublicKey | null;
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

  getEvmAccount(chainId: number): Account;

  getSolanaSigner(): SolanaSigner;

  signMessage(scope: SignScope, message: Hex): Promise<SignResult>;

  signTypedData(
    scope: SignScope,
    typedData: TypedDataDefinition,
  ): Promise<SignResult>;
}
