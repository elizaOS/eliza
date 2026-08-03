import { ChainProtocol } from "../registry";

// See dex.ts for the lowercase-address convention used throughout
// the ethereum/ registry files.
export const ETHEREUM_YIELD_PROTOCOLS: Readonly<
  Record<string, ChainProtocol>
> = {
  "0x5f18c75abdae578b483e5f43f12a39cf75b973a9": {
    programId: "0x5f18c75abdae578b483e5f43f12a39cf75b973a9",
    name: "Yearn yUSDC Vault V2",
    category: "yield",
    reputation: "high",
    verified: true,
    custodial: false,
    deprecated: false,
    website: "https://yearn.fi",
    notes:
      "Yearn's V2 USDC vault. Yearn has no single router/registry that retail deposits route through — users call individual vault contracts directly, and there are many vault versions per asset. This registry only covers this vault plus yDAI and yWETH V2 below: partial coverage, not exhaustive Yearn vault detection.",
    tags: [
      "yearn",
      "yvault",
      "yield",
      "vault",
      "usdc",
      "ethereum",
    ],
  },

  "0x19d3364a399d251e894ac732651be8b0e4e85001": {
    programId: "0x19d3364a399d251e894ac732651be8b0e4e85001",
    name: "Yearn yDAI Vault V2",
    category: "yield",
    reputation: "high",
    verified: true,
    custodial: false,
    deprecated: false,
    website: "https://yearn.fi",
    notes:
      "Yearn's V2 DAI vault, alongside yUSDC and yWETH V2 above/below. Partial coverage — see yUSDC vault notes.",
    tags: [
      "yearn",
      "yvault",
      "yield",
      "vault",
      "dai",
      "ethereum",
    ],
  },

  "0xe1237aa7f535b0cc33fd973d66cbf830354d16c7": {
    programId: "0xe1237aa7f535b0cc33fd973d66cbf830354d16c7",
    name: "Yearn yWETH Vault",
    category: "yield",
    reputation: "high",
    verified: true,
    custodial: false,
    deprecated: false,
    website: "https://yearn.fi",
    notes:
      "Yearn's WETH vault. Etherscan's label for this contract does not explicitly say \"V2\" the way the yUSDC/yDAI labels do, though it matches the same generation/style — flagging slightly lower confidence on the version than the other two Yearn entries. Partial coverage — see yUSDC vault notes.",
    tags: [
      "yearn",
      "yvault",
      "yield",
      "vault",
      "weth",
      "ethereum",
    ],
  },
};
