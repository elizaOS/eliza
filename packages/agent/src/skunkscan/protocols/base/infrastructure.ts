import { ChainProtocol } from "../registry";

// See dex.ts for the lowercase-address convention used throughout
// the base/ registry files.
export const BASE_INFRASTRUCTURE_PROTOCOLS: Readonly<
  Record<string, ChainProtocol>
> = {
  "0x4ccb0bb02fcaba27e82a56646e81d8c5bc4119a5": {
    programId: "0x4ccb0bb02fcaba27e82a56646e81d8c5bc4119a5",
    name: "Basenames: Registrar Controller",
    category: "infrastructure",
    reputation: "high",
    verified: true,
    custodial: false,
    deprecated: false,
    website: "https://www.base.org/names",
    notes:
      "Basenames' Registrar Controller, used to register and renew .base.eth names - Base's own ENS-like naming service. Not DeFi, but owning a .base.eth name is a useful investor-facing identity/longevity signal, same rationale as ENS on Ethereum and SPACE ID on BSC - arguably more relevant here given Base's identity/consumer-app focus.",
    tags: [
      "basenames",
      "naming",
      "infrastructure",
      "base",
    ],
  },
};
