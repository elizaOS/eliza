import { ChainProtocol } from "../registry";

// See dex.ts for the lowercase-address convention used throughout
// the bnb/ registry files.
export const BNB_INFRASTRUCTURE_PROTOCOLS: Readonly<
  Record<string, ChainProtocol>
> = {
  "0x524bd5676d24d89c240276db69a7de2960f519a7": {
    programId: "0x524bd5676d24d89c240276db69a7de2960f519a7",
    name: "SPACE ID .bnb Name Service: Registrar Controller",
    category: "infrastructure",
    reputation: "high",
    verified: true,
    custodial: false,
    deprecated: false,
    website: "https://space.id",
    notes:
      "SPACE ID's BNBRegistrarControllerV9, used to register and renew .bnb names - BSC's equivalent to ENS. Not DeFi, but owning a .bnb name is a useful investor-facing signal about a wallet's identity/longevity, same rationale as ENS on Ethereum.",
    tags: [
      "space-id",
      "bnb-name-service",
      "naming",
      "infrastructure",
      "bnb",
    ],
  },
};
