import { ChainProtocol } from "../registry";

// See dex.ts for the lowercase-address convention used throughout
// the ethereum/ registry files.
export const ETHEREUM_INFRASTRUCTURE_PROTOCOLS: Readonly<
  Record<string, ChainProtocol>
> = {
  "0x253553366da8546fc250f225fe3d25d0c782303b": {
    programId: "0x253553366da8546fc250f225fe3d25d0c782303b",
    name: "ENS ETHRegistrarController",
    category: "infrastructure",
    reputation: "high",
    verified: true,
    custodial: false,
    deprecated: false,
    website: "https://ens.domains",
    notes:
      "Ethereum Name Service's ETHRegistrarController, used to register and renew .eth names. Not DeFi, but owning a .eth name is a useful investor-facing signal about a wallet's identity/longevity.",
    tags: [
      "ens",
      "naming",
      "infrastructure",
      "ethereum",
    ],
  },
};
