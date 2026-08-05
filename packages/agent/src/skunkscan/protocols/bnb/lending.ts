import { ChainProtocol } from "../registry";

// See dex.ts for the lowercase-address convention used throughout
// the bnb/ registry files.
export const BNB_LENDING_PROTOCOLS: Readonly<Record<string, ChainProtocol>> = {
  "0xfd36e2c2a6789db23113685031d7f16329158384": {
    programId: "0xfd36e2c2a6789db23113685031d7f16329158384",
    name: "Venus: Core Pool Comptroller",
    category: "lending",
    reputation: "high",
    verified: true,
    custodial: false,
    deprecated: false,
    website: "https://venus.io",
    notes:
      "Venus Protocol's Core Pool Comptroller on BSC, BSC's equivalent to Aave/Compound and the dominant BSC lending protocol. Venus suffered a ~$100M+ bad-debt incident in May 2021 from a price-oracle manipulation exploit during the LUNA/UST collapse - noted here factually, not as a reputation downgrade, since the protocol remains the actively-maintained, dominant BSC lending market today and the incident was oracle-manipulation-driven rather than unique to Venus (comparable oracle incidents have hit Aave/Compound-tier protocols too).",
    tags: [
      "venus",
      "lending",
      "borrowing",
      "bnb",
    ],
  },
};
