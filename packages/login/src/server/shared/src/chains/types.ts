/**
 * Extensible chain provider definition.
 *
 * Every supported chain is defined by a single `ChainProvider` object in
 * its own module under `chains/`. The aggregate registry is built by
 * `chains/index.ts` from these modules, so adding a new chain is a one-file
 * drop-in: create `chains/<name>.ts`, export a `ChainProvider`, and import
 * it from `chains/index.ts`.
 */
export interface ChainProvider {
  /** CAIP-2 identifier (e.g. "eip155:100"). */
  caip2: string;
  /** Internal numeric ID. For EVM chains this matches the chain ID. For
   * non-EVM chains this is a convention used to map back to CAIP-2. */
  numericId: number;
  /** Family/VM the chain belongs to. */
  family: "evm" | "solana" | "bitcoin" | "monero";
  /** Human-readable display name. */
  name: string;
  /** Native asset ticker. */
  symbol: string;
  /** Whether this is a testnet. */
  testnet: boolean;
  /** Block-explorer base URL (no trailing slash). */
  explorerUrl: string;
  /** Brand color used by UI chain badges. */
  color: string;
  /** Function building the explorer URL for a transaction hash. */
  explorerTxUrl: (txHash: string) => string;
  /** Function building the explorer URL for an address. */
  explorerAddressUrl: (address: string) => string;
}
