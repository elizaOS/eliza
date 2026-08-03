import { ChainProtocol } from "../registry";

// See dex.ts for the lowercase-address convention used throughout
// the ethereum/ registry files.
export const ETHEREUM_LENDING_PROTOCOLS: Readonly<
  Record<string, ChainProtocol>
> = {
  "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2": {
    programId: "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2",
    name: "Aave V3 Pool",
    category: "lending",
    reputation: "high",
    verified: true,
    custodial: false,
    deprecated: false,
    website: "https://aave.com",
    notes: "Aave V3 Pool on Ethereum mainnet, the current main Aave lending/borrowing market.",
    tags: [
      "aave",
      "aave-v3",
      "lending",
      "borrowing",
      "ethereum",
    ],
  },

  "0x7d2768de32b0b80b7a3454c06bdac94a69ddc7a9": {
    programId: "0x7d2768de32b0b80b7a3454c06bdac94a69ddc7a9",
    name: "Aave V2 LendingPool",
    category: "lending",
    reputation: "high",
    verified: true,
    custodial: false,
    deprecated: true,
    website: "https://aave.com",
    notes:
      "Aave V2 LendingPool on Ethereum mainnet. Aave has been winding this market down in favor of V3, but historical retail activity (2020-2023) commonly used it — kept in the registry with deprecated: true rather than removed.",
    tags: [
      "aave",
      "aave-v2",
      "lending",
      "borrowing",
      "ethereum",
    ],
  },

  "0x3d9819210a31b4961b30ef54be2aed79b9c9cd3b": {
    programId: "0x3d9819210a31b4961b30ef54be2aed79b9c9cd3b",
    name: "Compound V2 Comptroller",
    category: "lending",
    reputation: "high",
    verified: true,
    custodial: false,
    deprecated: false,
    website: "https://compound.finance",
    notes: "Compound V2 Comptroller on Ethereum mainnet.",
    tags: [
      "compound",
      "compound-v2",
      "lending",
      "borrowing",
      "ethereum",
    ],
  },

  "0xc3d688b66703497daa19211eedff47f25384cdc3": {
    programId: "0xc3d688b66703497daa19211eedff47f25384cdc3",
    name: "Compound III (Comet) USDC Market",
    category: "lending",
    reputation: "high",
    verified: true,
    custodial: false,
    deprecated: false,
    website: "https://compound.finance",
    notes:
      "Compound III (Comet) USDC market on Ethereum mainnet. Compound III runs one Comet contract per base asset; this registers the USDC market only, not the other Comet deployments (e.g. WETH).",
    tags: [
      "compound",
      "compound-v3",
      "comet",
      "lending",
      "borrowing",
      "ethereum",
    ],
  },

  "0x5ef30b9986345249bc32d8928b7ee64de9435e39": {
    programId: "0x5ef30b9986345249bc32d8928b7ee64de9435e39",
    name: "MakerDAO CDP Manager",
    category: "lending",
    reputation: "high",
    verified: true,
    custodial: false,
    deprecated: false,
    website: "https://makerdao.com",
    notes:
      "MakerDAO's DssCdpManager (Vault/CDP manager), the standard entrypoint retail users interact with to open and manage collateralized debt positions and borrow DAI.",
    tags: [
      "makerdao",
      "maker",
      "cdp",
      "vault",
      "lending",
      "dai",
      "ethereum",
    ],
  },
};
