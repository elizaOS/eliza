import { ChainProtocol } from "../registry";

// See dex.ts for the lowercase-address convention used throughout
// the ethereum/ registry files.
export const ETHEREUM_STAKING_PROTOCOLS: Readonly<
  Record<string, ChainProtocol>
> = {
  "0xae7ab96520de3a18e5e111b5eaab095312d7fe84": {
    programId: "0xae7ab96520de3a18e5e111b5eaab095312d7fe84",
    name: "Lido (stETH)",
    category: "staking",
    reputation: "high",
    verified: true,
    custodial: false,
    deprecated: false,
    website: "https://lido.fi",
    notes:
      "Lido's stETH contract. Unlike most registry entries, this address is both the stETH ERC-20 token and the staking entrypoint (submit()) — a retail wallet holding stETH will show as having interacted with this address for the deposit itself, not merely for a token transfer.",
    tags: [
      "lido",
      "steth",
      "liquid-staking",
      "staking",
      "ethereum",
    ],
  },

  "0xdd3f50f8a6cafbe9b31a427582963f465e745af8": {
    programId: "0xdd3f50f8a6cafbe9b31a427582963f465e745af8",
    name: "Rocket Pool Deposit Pool",
    category: "staking",
    reputation: "high",
    verified: true,
    custodial: false,
    deprecated: false,
    website: "https://rocketpool.net",
    notes:
      "Rocket Pool's current (v1.2) RocketDepositPool contract, the entrypoint for depositing ETH in exchange for rETH. Earlier v1.0/v1.1 deposit pool deployments are not included.",
    tags: [
      "rocket-pool",
      "reth",
      "liquid-staking",
      "staking",
      "ethereum",
    ],
  },
};
