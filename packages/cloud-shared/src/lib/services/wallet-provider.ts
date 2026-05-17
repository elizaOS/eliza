/**
 * WalletProvider — abstraction for agent wallet management.
 *
 * Allows pluggable wallet backends while
 * presenting a uniform interface to the rest of the application.
 *
 * Phase 1: The concrete routing lives in server-wallets.ts using
 * feature flags. This interface is the target for Phase 2+ when
 * each provider becomes a standalone class.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CreateWalletOptions {
  /** Human-readable agent name. */
  name?: string;
  /** Blockchain ecosystem. */
  chainType?: "evm" | "solana";
  /** Platform identifier (e.g. client address). */
  platformId?: string;
}

export interface WalletInfo {
  /** Provider-specific wallet/agent ID. */
  walletId: string;
  /** On-chain public address. */
  address: string;
  /** Which provider manages this wallet. */
  provider: "steward";
  /** Chain type. */
  chainType: "evm" | "solana";
}

export interface TransactionRequest {
  to: string;
  value?: string;
  data?: string;
  chainId?: number;
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface WalletProvider {
  /** Create a new wallet for an agent. */
  createWallet(agentId: string, options?: CreateWalletOptions): Promise<WalletInfo>;

  /** Look up an existing wallet for an agent. Returns null if none exists. */
  getWallet(agentId: string): Promise<WalletInfo | null>;

  /** Get native balance for a chain (returns wei/lamports as string). */
  getBalance(agentId: string, chain: string): Promise<string>;

  /** Sign and optionally broadcast a transaction. Returns tx hash or signed tx. */
  signTransaction(agentId: string, tx: TransactionRequest): Promise<string>;

  /** Sign an arbitrary message. Returns hex signature. */
  signMessage(agentId: string, message: string): Promise<string>;
}
