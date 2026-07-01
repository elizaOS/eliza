/**
 * Token address normalization utilities.
 *
 * EVM addresses (0x-prefixed hex) are case-insensitive per EIP-55: the mixed-case
 * form is only a checksum encoding of the same 20-byte value.  Storing and
 * comparing them in lowercase prevents duplicate token↔agent linkages caused by
 * differing checksum capitalisation (e.g. `0xAbC…` vs `0xabc…`).
 *
 * Non-EVM chains (Solana base58, Cosmos bech32, etc.) are case-sensitive by
 * design, so we leave them untouched.
 */

/** Chains whose addresses are hex and should be lowercased. */
const EVM_CHAINS = new Set([
  "ethereum",
  "base",
  "arbitrum",
  "optimism",
  "polygon",
  "avalanche",
  "bsc",
  "binance",
  "fantom",
  "gnosis",
  "celo",
  "linea",
  "scroll",
  "zksync",
  "blast",
  "mantle",
  "mode",
  "moonbeam",
  "moonriver",
  "aurora",
  "metis",
  "cronos",
  "harmony",
  "zora",
]);

/**
 * Returns `true` when `address` looks like a standard EVM address:
 * exactly 42 characters (0x + 40 hex digits = 20 bytes).
 *
 * Earlier versions accepted any-length 0x-hex which could false-positive
 * on non-EVM identifiers that happen to start with "0x".  The 42-char
 * requirement matches the EVM address spec (EIP-55) and is used by all
 * major EVM chains.
 */
function looksLikeEvmAddress(address: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(address);
}

/**
 * Determine whether an address should be lowercased.
 *
 * Decision tree:
 * 1. If a known EVM chain is provided → lowercase.
 * 2. If chain is unknown/omitted but the address *looks* like `0x…` hex → lowercase.
 * 3. Otherwise → preserve original casing (Solana, Cosmos, etc.).
 */
function shouldLowercase(address: string, chain?: string | null): boolean {
  if (chain && EVM_CHAINS.has(chain.toLowerCase())) {
    return true;
  }
  // No chain or unrecognised chain: fall back to address shape heuristic.
  // This is intentionally conservative — only hex addresses are lowered.
  if (looksLikeEvmAddress(address)) {
    return true;
  }
  return false;
}

/**
 * Normalise a token address for storage and comparison.
 *
 * - EVM addresses → lowercased.
 * - Everything else → returned as-is.
 *
 * @param address Raw address string.
 * @param chain   Optional chain identifier (e.g. "ethereum", "solana").
 * @returns Normalised address string, or the original if no normalisation applies.
 */
export function normalizeTokenAddress(address: string, chain?: string | null): string {
  if (shouldLowercase(address, chain)) {
    return address.toLowerCase();
  }
  return address;
}
