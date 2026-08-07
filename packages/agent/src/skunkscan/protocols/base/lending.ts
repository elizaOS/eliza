import { ChainProtocol } from "../registry";

// See dex.ts for the lowercase-address convention used throughout
// the base/ registry files.
export const BASE_LENDING_PROTOCOLS: Readonly<Record<string, ChainProtocol>> = {
  "0xa238dd80c259a72e81d7e4664a9801593f98d1c5": {
    programId: "0xa238dd80c259a72e81d7e4664a9801593f98d1c5",
    name: "Aave: Pool Proxy Base",
    category: "lending",
    reputation: "high",
    verified: true,
    custodial: false,
    deprecated: false,
    website: "https://aave.com",
    notes: "Aave V3's Pool Proxy on Base, the globally dominant Aave brand's Base deployment.",
    tags: [
      "aave",
      "aave-v3",
      "lending",
      "borrowing",
      "base",
    ],
  },

  "0xfbb21d0380bee3312b33c4353c8936a0f13ef26c": {
    programId: "0xfbb21d0380bee3312b33c4353c8936a0f13ef26c",
    name: "Moonwell: Comptroller",
    category: "lending",
    reputation: "high",
    verified: true,
    custodial: false,
    deprecated: false,
    website: "https://moonwell.fi",
    notes:
      "Moonwell's Comptroller on Base, a Compound V2-style fork and Base's dominant native lending protocol - 93.9% of Moonwell's TVL is on Base specifically, roughly 35-42% share of Base lending.",
    tags: [
      "moonwell",
      "lending",
      "borrowing",
      "base",
    ],
  },
};
