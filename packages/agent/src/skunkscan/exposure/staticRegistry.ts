import { isEvmChain, SupportedChain, WalletExposureSummary } from "../types";

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

// BNB Smart Chain addresses are stored lowercase, same convention as
// Ethereum's - see isEvmChain() in ../types.
//
// Both entries below were independently forensically verified (real
// on-chain transaction history pulled directly via Moralis, not just
// BscScan's own "Heist" labels or press coverage) before being added:
// Rug 1 deployed a proxy contract holding real SQUID/SQUID-derivative
// tokens (SQUIDv2, SQUID.S2, SQUID INU) and interacted with it 26 times in
// a ~50-minute burst on 2021-11-01, the exact day of the SQUID rug pull.
// Rug 2 directly received 48M+ of the real SQUID token
// (0x87230146e138d3f296a9a77e497a2a83012e9bc5, cross-checked against the
// live contract address), executed dozens of small probing token-transfer
// transactions to a fixed counterparty, and received/forwarded a 27.45 BNB
// inflow with only a 26-second gap before a 5 BNB outflow - both during
// the token's live trading window (2021-10-29, ~3 days before the Nov 1
// liquidity pull), not merely "labeled," genuinely tied to the scam
// token's own contract and timeline.
const STATIC_BNB_EXPOSURE_REGISTRY: Record<string, ExposureRegistryEntry> = {
  "0x1f5eabba9c56bca4a7828969b79bc87051125b31": {
    address: "0x1f5eabba9c56bca4a7828969b79bc87051125b31",
    label: "SQUID Token Rug 1",
    category: "rug_pull",
    confidence: "high",
    source: "static_registry",
    relationship: "self",
    contributesToScore: true,
  },

  "0x34400280a169f4685193926a513618cf7fe7f0aa": {
    address: "0x34400280a169f4685193926a513618cf7fe7f0aa",
    label: "SQUID Token Rug 2",
    category: "rug_pull",
    confidence: "high",
    source: "static_registry",
    relationship: "self",
    contributesToScore: true,
  },
};

// Base addresses are stored lowercase, same convention as Ethereum/BNB's -
// see isEvmChain() in ../types (already covered "base" before this
// registry existed, confirmed rather than assumed).
//
// Forensically verified directly via Moralis (real on-chain history, not
// just BaseScan's own labels or press coverage) before being added: this
// is the BALD token deployer/liquidity-operations wallet, repeatedly
// depositing large, escalating native ETH amounts (0.1 through 100 ETH per
// transaction) into the real BALD/WETH LP pool
// (0xe96df8f5ef1a8790415068c798765b07d57643bd) and swapping BALD out for
// ETH via the pool's counterparty contract, active precisely through
// 2023-07-29 to 2023-07-31 - the exact documented window of the BALD rug
// pull (the deployer removed ~10,700 ETH of liquidity on 2023-07-31,
// crashing the token 90%+). Directly tied to the real token contract
// (0x27d2decb4bfc9c76f0309b8e88dec3a601fe25a8) and the documented
// mechanism, not merely labeled.
const STATIC_BASE_EXPOSURE_REGISTRY: Record<string, ExposureRegistryEntry> = {
  "0xccfa0530b9d52f970d1a2daea670ce58e4176389": {
    address: "0xccfa0530b9d52f970d1a2daea670ce58e4176389",
    label: "BALD Token Deployer / Liquidity Rug",
    category: "rug_pull",
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
  bnb: STATIC_BNB_EXPOSURE_REGISTRY,
  base: STATIC_BASE_EXPOSURE_REGISTRY,
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

  // EVM addresses are checksummed (mixed-case) by convention from most
  // providers including Moralis, but this registry's EVM-chain keys are
  // stored lowercase - normalize here, once, rather than at every caller
  // (self-address, funding-wallet address, and any future counterparty
  // check). isEvmChain() keeps this from needing a repeat fix per chain
  // (fixed once already for Ethereum alone, would have needed a second
  // repeat for BSC without it): Solana addresses are base58 and
  // case-sensitive, so lowercasing them would corrupt the lookup.
  const normalizedAddress = isEvmChain(chain)
    ? address.toLowerCase()
    : address;

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
