import { ChainProtocol } from "../registry";

// Ethereum addresses are stored lowercase throughout this file.
// EIP-55 checksum casing is a display convention only; addresses are
// case-insensitive on-chain, but lookupProtocol() does an exact string
// match with no normalization. Whatever collects contract addresses out
// of parsed transactions (see PR B) must lowercase them before lookup,
// or matches against this registry will silently fail.
export const ETHEREUM_DEX_PROTOCOLS: Readonly<
  Record<string, ChainProtocol>
> = {
  "0x7a250d5630b4cf539739df2c5dacb4c659f2488d": {
    programId: "0x7a250d5630b4cf539739df2c5dacb4c659f2488d",
    name: "Uniswap V2 Router02",
    category: "dex",
    reputation: "high",
    verified: true,
    custodial: false,
    deprecated: false,
    website: "https://uniswap.org",
    notes: "Uniswap V2 Router02 on Ethereum mainnet.",
    tags: [
      "uniswap",
      "uniswap-v2",
      "amm",
      "dex",
      "ethereum",
    ],
  },

  "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45": {
    programId: "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45",
    name: "Uniswap V3 SwapRouter02",
    category: "dex",
    reputation: "high",
    verified: true,
    custodial: false,
    deprecated: false,
    website: "https://uniswap.org",
    notes: "Uniswap V3 SwapRouter02 on Ethereum mainnet.",
    tags: [
      "uniswap",
      "uniswap-v3",
      "amm",
      "dex",
      "ethereum",
    ],
  },

  "0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad": {
    programId: "0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad",
    name: "Uniswap Universal Router",
    category: "dex",
    reputation: "high",
    verified: true,
    custodial: false,
    deprecated: false,
    website: "https://uniswap.org",
    notes:
      "Uniswap's Universal Router, the current preferred entrypoint for ERC-20 and NFT swaps. Superseded by Universal Router 2 below but still carries significant transaction volume.",
    tags: [
      "uniswap",
      "universal-router",
      "amm",
      "dex",
      "ethereum",
    ],
  },

  "0xef1c6e67703c7bd7107eed8303fbe6ec2554bf6b": {
    programId: "0xef1c6e67703c7bd7107eed8303fbe6ec2554bf6b",
    name: "Uniswap Universal Router 2",
    category: "dex",
    reputation: "high",
    verified: true,
    custodial: false,
    deprecated: false,
    website: "https://uniswap.org",
    notes: "Newer Uniswap Universal Router deployment, alongside the original above.",
    tags: [
      "uniswap",
      "universal-router",
      "amm",
      "dex",
      "ethereum",
    ],
  },

  "0x66a9893cc07d91d95644aedd05d03f95e1dba8af": {
    programId: "0x66a9893cc07d91d95644aedd05d03f95e1dba8af",
    name: "Uniswap V4 Universal Router",
    category: "dex",
    reputation: "high",
    verified: true,
    custodial: false,
    deprecated: false,
    website: "https://uniswap.org",
    notes:
      "Uniswap's V4-era Universal Router, labeled \"Uniswap V4: Universal Router\" on Etherscan. Per Uniswap's own universal-router GitHub repo, this router also routes through V2 and V3 pools, superseding the V2/V3-era Universal Router deployments above for current activity. Discovered via live verification against Vitalik Buterin's real transaction history (address independently re-confirmed against Etherscan before being added here, not taken on trust from that discovery).",
    tags: [
      "uniswap",
      "uniswap-v4",
      "universal-router",
      "amm",
      "dex",
      "ethereum",
    ],
  },

  "0x111111125421ca6dc452d289314280a0f8842a65": {
    programId: "0x111111125421ca6dc452d289314280a0f8842a65",
    name: "1inch Aggregation Router V6",
    category: "dex_aggregator",
    reputation: "high",
    verified: true,
    custodial: false,
    deprecated: false,
    website: "https://1inch.io",
    notes: "1inch Aggregation Router V6 on Ethereum mainnet.",
    tags: [
      "1inch",
      "dex-aggregator",
      "swap",
      "routing",
      "ethereum",
    ],
  },

  "0x45312ea0eff7e09c83cbe249fa1d7598c4c8cd4e": {
    programId: "0x45312ea0eff7e09c83cbe249fa1d7598c4c8cd4e",
    name: "Curve Router NG",
    category: "dex",
    reputation: "high",
    verified: true,
    custodial: false,
    deprecated: false,
    website: "https://curve.fi",
    notes:
      "Curve's current router, capable of routing through multiple pools in one transaction. Curve usage is structurally fragmented across many individual pool contracts (unlike Uniswap's router-centric model) — this registry only covers this router plus the two highest-volume pools below (3pool, stETH/ETH). This is partial coverage, not exhaustive Curve detection.",
    tags: [
      "curve",
      "dex",
      "router",
      "stableswap",
      "ethereum",
    ],
  },

  "0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7": {
    programId: "0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7",
    name: "Curve 3pool (DAI/USDC/USDT)",
    category: "dex",
    reputation: "high",
    verified: true,
    custodial: false,
    deprecated: false,
    website: "https://curve.fi",
    notes:
      "Curve's flagship DAI/USDC/USDT stableswap pool, called directly for years before Curve Router NG existed. Included as a hand-picked, high-volume pool alongside the router — partial coverage, not exhaustive Curve pool detection.",
    tags: [
      "curve",
      "dex",
      "stableswap",
      "liquidity",
      "ethereum",
    ],
  },

  "0x828b154032950c8ff7cf8085d841723db2696056": {
    programId: "0x828b154032950c8ff7cf8085d841723db2696056",
    name: "Curve stETH/ETH Pool",
    category: "dex",
    reputation: "high",
    verified: true,
    custodial: false,
    deprecated: false,
    website: "https://curve.fi",
    notes:
      "Curve's stETH/ETH pool, commonly used by retail investors to exit or enter Lido stETH positions. Hand-picked high-volume pool, alongside Curve Router NG and 3pool above — partial coverage, not exhaustive Curve pool detection.",
    tags: [
      "curve",
      "dex",
      "steth",
      "liquidity",
      "ethereum",
    ],
  },
};
