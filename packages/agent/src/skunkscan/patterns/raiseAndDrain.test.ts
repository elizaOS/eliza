import { describe, expect, it } from "vitest";
import { WalletRelationship } from "../types";
import { detectRaiseAndDrainPattern } from "./raiseAndDrain";

// True-positive fixture: modeled on AnubisDAO Liquidity Rug 2
// (0x9fc53c75046900d1f58209f50f534852ae9f912a), independently verified
// during this project's exposure-registry research - the address
// documented as receiving the bulk of the ~13,597 ETH (~$60M) public-sale
// proceeds, which was then drained within roughly 20 hours before the
// wallet went dormant for years. The outgoing counterparty address here
// (AnubisDAO Liquidity Rug 3) is one of our own real, verified registry
// entries, not a placeholder.
const ANUBISDAO_RUG2_RELATIONSHIPS: WalletRelationship[] = [
  {
    address: "0xanubisdao-public-sale-proceeds-source",
    relationship: "counterparty",
    confidence: "high",
    direction: "incoming",
    firstInteractionAt: 1635429600,
    lastInteractionAt: 1635430800,
    totalNativeAmountReceived: 13597,
    totalNativeAmountSent: 0,
    transactionSignatures: ["0xfixture-anubisdao-inbound-1"],
  },
  {
    // AnubisDAO Liquidity Rug 3 - real, independently-verified address
    // already in our exposure registry.
    address: "0xb1302743acf31f567e9020810523f5030942e211",
    relationship: "counterparty",
    confidence: "high",
    direction: "outgoing",
    firstInteractionAt: 1635502800,
    lastInteractionAt: 1635502800,
    totalNativeAmountReceived: 0,
    totalNativeAmountSent: 12800,
    transactionSignatures: ["0xfixture-anubisdao-outbound-1"],
  },
];

// True-negative fixture: routine treasury consolidation. Same "big in, big
// out" shape as the AnubisDAO fixture (large inbound, ~92% drained to a
// cold-storage/multisig address shortly after) - the one deliberate
// difference is the third relationship: continued incoming revenue well
// after the consolidation event. This is exactly the distinguishing
// detail the pattern is designed to check for, and the reason this fixture
// exists is to prove the pattern does NOT fire on it.
const TREASURY_CONSOLIDATION_RELATIONSHIPS: WalletRelationship[] = [
  {
    address: "0xpublic-sale-buyer-pool",
    relationship: "counterparty",
    confidence: "medium",
    direction: "incoming",
    firstInteractionAt: 1700000000,
    lastInteractionAt: 1700003600,
    totalNativeAmountReceived: 500,
    totalNativeAmountSent: 0,
    transactionSignatures: ["0xfixture-treasury-inbound-1"],
  },
  {
    address: "0xcold-storage-multisig",
    relationship: "counterparty",
    confidence: "high",
    direction: "outgoing",
    firstInteractionAt: 1700176400,
    lastInteractionAt: 1700176400,
    totalNativeAmountReceived: 0,
    totalNativeAmountSent: 460,
    transactionSignatures: ["0xfixture-treasury-outbound-1"],
  },
  {
    // The distinguishing detail: this project kept receiving revenue ~60
    // days after the "drain" - a live project, not an abandoned one.
    address: "0xongoing-customer-revenue",
    relationship: "counterparty",
    confidence: "medium",
    direction: "incoming",
    firstInteractionAt: 1705360400,
    lastInteractionAt: 1705360400,
    totalNativeAmountReceived: 50,
    totalNativeAmountSent: 0,
    transactionSignatures: ["0xfixture-treasury-ongoing-revenue-1"],
  },
];

// A "now" far enough past both fixtures' outbound events to satisfy the
// dormancy check for whichever fixture is actually expected to match.
const NOW_TIMESTAMP = 1785900000; // ~2026-08, well past both fixtures

describe("detectRaiseAndDrainPattern", () => {
  it("matches AnubisDAO Liquidity Rug 2's real, documented shape (true positive)", () => {
    const result = detectRaiseAndDrainPattern(
      ANUBISDAO_RUG2_RELATIONSHIPS,
      NOW_TIMESTAMP,
    );

    expect(result).not.toBeNull();
    expect(result?.patternId).toBe("raise_and_drain");
    expect(result?.inboundTotalNative).toBe(13597);
    expect(result?.outboundTotalNative).toBe(12800);
    // ~94% drained - matches the documented near-total liquidity pull.
    expect(result?.drainRatio).toBeCloseTo(12800 / 13597, 5);
    // Matches the real, independently-documented ~20-hour window between
    // the public sale and the liquidity pull.
    expect(result?.hoursBetweenInboundAndOutbound).toBeCloseTo(20, 5);
    expect(result?.dormancyDays).toBeGreaterThan(30);
  });

  it("does not match routine treasury consolidation followed by continued revenue (true negative)", () => {
    const result = detectRaiseAndDrainPattern(
      TREASURY_CONSOLIDATION_RELATIONSHIPS,
      NOW_TIMESTAMP,
    );

    expect(result).toBeNull();
  });

  it("does not match a wallet with no outgoing activity at all", () => {
    const incomingOnly = ANUBISDAO_RUG2_RELATIONSHIPS.filter(
      (r) => r.direction === "incoming",
    );

    expect(detectRaiseAndDrainPattern(incomingOnly, NOW_TIMESTAMP)).toBeNull();
  });

  it("does not match if the drain hasn't been dormant long enough yet", () => {
    // Same shape as the true positive, but evaluated only a few days after
    // the drain - too recent to call it "dormant" with confidence.
    const recentNow = 1635502800 + 5 * 86400; // 5 days after the drain

    expect(
      detectRaiseAndDrainPattern(ANUBISDAO_RUG2_RELATIONSHIPS, recentNow),
    ).toBeNull();
  });

  it("does not match if the outbound amount is too small relative to inbound", () => {
    const partialDrain: WalletRelationship[] = [
      ANUBISDAO_RUG2_RELATIONSHIPS[0],
      {
        ...ANUBISDAO_RUG2_RELATIONSHIPS[1],
        totalNativeAmountSent: 3000, // ~22% of inbound - not a drain
      },
    ];

    expect(
      detectRaiseAndDrainPattern(partialDrain, NOW_TIMESTAMP),
    ).toBeNull();
  });
});
