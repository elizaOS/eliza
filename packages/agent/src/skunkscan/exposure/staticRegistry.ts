import { SupportedChain, WalletExposureSummary } from "../types";

export type ExposureRegistryEntry =
  WalletExposureSummary["matches"][number];

const STATIC_SOLANA_EXPOSURE_REGISTRY: Record<string, ExposureRegistryEntry> = {};

// Ethereum addresses are stored lowercase, same convention as the DeFi
// protocol registry (protocols/ethereum/*.ts): EIP-55 checksum casing is
// display-only, and lookupStaticExposure() below does an exact string
// match with no normalization. Whatever feeds an address into that lookup
// (the investigated wallet's own address, its funding-wallet address)
// must be lowercased first, or matches against this registry will
// silently fail - see the follow-up fix for that.
//
// Every entry below was independently verified against Etherscan's own
// address label plus multiple corroborating security-firm/news sources
// before being added - not included on the basis of allegation alone.
const STATIC_ETHEREUM_EXPOSURE_REGISTRY: Record<string, ExposureRegistryEntry> = {
  "0x872254d530ae8983628cb1eaafc51f78d78c86d9": {
    address: "0x872254d530ae8983628cb1eaafc51f78d78c86d9",
    label: "AnubisDAO Liquidity Rug 1",
    category: "rug_pull",
    confidence: "high",
    source: "static_registry",
    relationship: "self",
    contributesToScore: true,
  },

  "0x9fc53c75046900d1f58209f50f534852ae9f912a": {
    address: "0x9fc53c75046900d1f58209f50f534852ae9f912a",
    label: "AnubisDAO Liquidity Rug 2",
    category: "rug_pull",
    confidence: "high",
    source: "static_registry",
    relationship: "self",
    contributesToScore: true,
  },

  "0xb1302743acf31f567e9020810523f5030942e211": {
    address: "0xb1302743acf31f567e9020810523f5030942e211",
    label: "AnubisDAO Liquidity Rug 3",
    category: "rug_pull",
    confidence: "high",
    source: "static_registry",
    relationship: "self",
    contributesToScore: true,
  },

  "0x658729879fca881d9526480b82ae00efc54b5c2d": {
    address: "0x658729879fca881d9526480b82ae00efc54b5c2d",
    label: "Ledger Connect Kit Exploit / Angel Drainer (collector wallet)",
    category: "scam",
    confidence: "high",
    source: "static_registry",
    relationship: "self",
    contributesToScore: true,
  },

  "0x412f10aad96fd78da6736387e2c84931ac20313f": {
    address: "0x412f10aad96fd78da6736387e2c84931ac20313f",
    label: "Angel Drainer (fee wallet, angel-drainer.eth)",
    category: "scam",
    confidence: "high",
    source: "static_registry",
    relationship: "self",
    contributesToScore: true,
  },

  "0x00001f78189be22c3498cff1b8e02272c3220000": {
    address: "0x00001f78189be22c3498cff1b8e02272c3220000",
    label: "Inferno Drainer",
    category: "scam",
    confidence: "high",
    source: "static_registry",
    relationship: "self",
    contributesToScore: true,
  },

  "0x0000daf60a1becf1bd617c584dea964455890000": {
    address: "0x0000daf60a1becf1bd617c584dea964455890000",
    label: "Inferno Drainer Phishing Contract 2",
    category: "scam",
    confidence: "high",
    source: "static_registry",
    relationship: "self",
    contributesToScore: true,
  },
};

const CHAIN_EXPOSURE_REGISTRIES: Partial<
  Record<SupportedChain, Readonly<Record<string, ExposureRegistryEntry>>>
> = {
  solana: STATIC_SOLANA_EXPOSURE_REGISTRY,
  ethereum: STATIC_ETHEREUM_EXPOSURE_REGISTRY,
};

export function lookupStaticExposure(
  chain: SupportedChain,
  address: string | null | undefined,
): ExposureRegistryEntry | null {
  if (!address) {
    return null;
  }

  const registry = CHAIN_EXPOSURE_REGISTRIES[chain];

  if (!registry) {
    return null;
  }

  // Ethereum addresses are checksummed (mixed-case) by convention from
  // most providers including Moralis, but this registry's Ethereum keys
  // are stored lowercase - normalize here, once, rather than at every
  // caller (self-address, funding-wallet address, and any future
  // counterparty check). Deliberately scoped to "ethereum" only, not
  // "every non-Solana chain": Solana addresses are base58 and
  // case-sensitive, so lowercasing them would corrupt the lookup.
  const normalizedAddress =
    chain === "ethereum" ? address.toLowerCase() : address;

  return registry[normalizedAddress] ?? null;
}

// Used by buildReverseIndex.ts to enumerate every currently-registered
// exposure address for a chain, so the reverse-index population script
// doesn't need its own hardcoded copy of the address list that could
// drift from the actual registry.
export function getExposureRegistryEntries(
  chain: SupportedChain,
): ExposureRegistryEntry[] {
  const registry = CHAIN_EXPOSURE_REGISTRIES[chain];

  return registry ? Object.values(registry) : [];
}
