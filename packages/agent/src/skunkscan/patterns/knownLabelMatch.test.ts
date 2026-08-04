import { describe, expect, it } from "vitest";
import { WalletRelationship } from "../types";
import { checkKnownLabelMatches } from "./knownLabelMatch";

// Same AnubisDAO Liquidity Rug 2 shape used by raiseAndDrain.test.ts. Neither
// counterparty here is a labeled exchange, so this fixture proves the check
// correctly returns false/[] because it looked and found nothing - not
// because it's hardcoded.
const ANUBISDAO_RUG2_RELATIONSHIPS: WalletRelationship[] = [
  {
    address: "0xanubisdao-public-sale-proceeds-source",
    relationship: "counterparty",
    confidence: "high",
    direction: "incoming",
  },
  {
    address: "0xb1302743acf31f567e9020810523f5030942e211",
    relationship: "counterparty",
    confidence: "high",
    direction: "outgoing",
  },
];

// Same shape, but the outbound counterparty is Binance 14
// (0x28c6c06298d514db089934071355e5743bf21d60) - a real, already-verified
// entry in labels/staticRegistry.ts's centralized_exchange category. This is
// the concrete false-positive risk Pattern B would have produced; proving
// this fires is the whole point of the check.
const DRAIN_TO_KNOWN_EXCHANGE_RELATIONSHIPS: WalletRelationship[] = [
  {
    address: "0xsome-unlabeled-funding-source",
    relationship: "counterparty",
    confidence: "high",
    direction: "incoming",
  },
  {
    address: "0x28c6c06298d514db089934071355e5743bf21d60",
    relationship: "counterparty",
    confidence: "high",
    direction: "outgoing",
  },
];

describe("checkKnownLabelMatches", () => {
  it("returns no matches for AnubisDAO's real counterparties (true negative)", () => {
    const result = checkKnownLabelMatches(
      "ethereum",
      "0x9fc53c75046900d1f58209f50f534852ae9f912a",
      ANUBISDAO_RUG2_RELATIONSHIPS,
    );

    expect(result.hasKnownLabelMatch).toBe(false);
    expect(result.labelMatches).toEqual([]);
  });

  it("flags a counterparty that is already labeled Binance 14 (false-positive defense)", () => {
    const result = checkKnownLabelMatches(
      "ethereum",
      "0xsome-flagged-wallet",
      DRAIN_TO_KNOWN_EXCHANGE_RELATIONSHIPS,
    );

    expect(result.hasKnownLabelMatch).toBe(true);
    expect(result.labelMatches).toEqual([
      {
        address: "0x28c6c06298d514db089934071355e5743bf21d60",
        label: "Binance 14",
        relationship: "counterparty",
      },
    ]);
  });

  it("checks the flagged wallet itself, not just its counterparties", () => {
    const result = checkKnownLabelMatches(
      "ethereum",
      "0xf977814e90da44bfa03b6295a0616a897441acec", // Binance: Hot Wallet 20
      [],
    );

    expect(result.hasKnownLabelMatch).toBe(true);
    expect(result.labelMatches).toEqual([
      {
        address: "0xf977814e90da44bfa03b6295a0616a897441acec",
        label: "Binance: Hot Wallet 20",
        relationship: "self",
      },
    ]);
  });
});
