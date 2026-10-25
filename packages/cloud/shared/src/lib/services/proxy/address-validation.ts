/**
 * Multi-chain address validation
 *
 * WHY multi-chain support:
 * - Market data API (Birdeye) supports 10+ chains
 * - Single validation module prevents duplication across routes
 * - Easier to add new chains (just update these constants)
 *
 * WHY these specific chains:
 * - Solana: native Helius RPC support
 * - EVM chains: Birdeye's top-volume networks
 * - Sui: emerging ecosystem with growing volume
 *
 * WHY strict format validation:
 * - DoS prevention: reject invalid addresses before hitting upstream
 * - Cost saving: prevents wasted credits on invalid requests
 * - User experience: fast feedback on typos vs slow upstream errors
 */

import bs58 from "bs58";

const SUPPORTED_CHAINS = new Set([
  "solana",
  "ethereum",
  "arbitrum",
  "avalanche",
  "bsc",
  "optimism",
  "polygon",
  "base",
  "zksync",
  "sui",
]);

const EVM_CHAINS = new Set([
  "ethereum",
  "arbitrum",
  "avalanche",
  "bsc",
  "optimism",
  "polygon",
  "base",
  "zksync",
]);

// WHY base58 for Solana: Base58 excludes confusing chars (0, O, I, l)
// WHY 32-44 chars: 32 bytes encoded = 43-44 chars typically, allow 32 for edge cases
const SOLANA_ADDRESS_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// WHY case-insensitive [a-fA-F]: EVM uses mixed-case checksums (EIP-55)
// WHY 40 hex chars: 20 bytes = 40 hex digits (0x prefix not counted in length)
const EVM_ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;

// WHY 64 hex chars: Sui uses 32-byte addresses = 64 hex digits
const SUI_ADDRESS_REGEX = /^0x[a-fA-F0-9]{64}$/;

export function isValidChain(chain: string): boolean {
  return SUPPORTED_CHAINS.has(chain.toLowerCase());
}

export function isValidAddress(chain: string, address: string): boolean {
  const normalizedChain = chain.toLowerCase();

  if (!isValidChain(normalizedChain)) {
    return false;
  }

  if (normalizedChain === "solana") {
    return isValidSolanaAddress(address);
  }

  if (EVM_CHAINS.has(normalizedChain)) {
    return EVM_ADDRESS_REGEX.test(address);
  }

  if (normalizedChain === "sui") {
    return SUI_ADDRESS_REGEX.test(address);
  }

  return false;
}

export function isValidSolanaAddress(address: string): boolean {
  if (!address || typeof address !== "string") {
    return false;
  }

  if (address.length < 32 || address.length > 44) {
    return false;
  }

  if (!SOLANA_ADDRESS_REGEX.test(address)) {
    return false;
  }

  try {
    return bs58.decode(address).length === 32;
  } catch {
    return false;
  }
}
