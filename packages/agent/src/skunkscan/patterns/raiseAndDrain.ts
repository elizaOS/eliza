import { WalletRelationship } from "../types";

/**
 * "Raise-and-drain" scam-pattern signature: a wallet receives one or a few
 * large inbound native-asset transfers in a short window, sends out ~90%+
 * of that balance within hours-to-days, then goes dormant on the incoming
 * side (no further inbound activity at all afterward). Sanity-checked
 * against AnubisDAO's real, documented shape during design work: public
 * sale proceeds in, liquidity pulled ~20 hours later, dormant for years.
 *
 * This is a lead-generation signal for human review only. It never
 * decides a wallet is a scam, and its output is never written to the
 * exposure registry directly - see candidates/ for the review-pending
 * storage this feeds.
 *
 * Known false-positive risk (by design, not a bug): routine treasury
 * consolidation to cold storage/a multisig produces the same "big in,
 * big out" shape. The one distinguishing detail this pattern actually
 * checks for is the ABSENCE of further incoming activity afterward - a
 * live project keeps receiving revenue; an abandoned one doesn't. A
 * consolidation event followed by continued incoming activity correctly
 * does not match.
 */

export type RaiseAndDrainEvidence = {
  patternId: "raise_and_drain";
  inboundTotalNative: number;
  inboundTransactionSignatures: string[];
  inboundWindowStart: number;
  inboundWindowEnd: number;
  outboundTotalNative: number;
  outboundTransactionSignatures: string[];
  outboundAt: number;
  drainRatio: number;
  hoursBetweenInboundAndOutbound: number;
  dormantSinceAt: number;
  dormancyDays: number;
};

// Outbound must represent at least this fraction of inbound to count as a
// "drain" rather than routine partial spending.
const MIN_DRAIN_RATIO = 0.85;

// The drain must happen within this many hours of the inbound window
// closing - generous enough to cover both AnubisDAO's ~20-hour rug pull
// and slower variants, while still requiring the two events to be
// meaningfully connected in time rather than coincidental.
const MAX_HOURS_TO_DRAIN = 24 * 14;

// No further incoming activity for at least this long (relative to the
// time the pattern is evaluated) before treating the wallet as genuinely
// dormant rather than just "quiet for now."
const MIN_DORMANCY_DAYS = 30;

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

export function detectRaiseAndDrainPattern(
  relationships: WalletRelationship[],
  nowTimestamp: number,
): RaiseAndDrainEvidence | null {
  const incoming = relationships.filter(
    (relationship) =>
      (relationship.direction === "incoming" ||
        relationship.direction === "bidirectional") &&
      (relationship.totalNativeAmountReceived ?? 0) > 0,
  );

  const outgoing = relationships.filter(
    (relationship) =>
      (relationship.direction === "outgoing" ||
        relationship.direction === "bidirectional") &&
      (relationship.totalNativeAmountSent ?? 0) > 0,
  );

  if (incoming.length === 0 || outgoing.length === 0) {
    return null;
  }

  const inboundTotal = sum(
    incoming.map((r) => r.totalNativeAmountReceived ?? 0),
  );
  const inboundWindowStart = Math.min(
    ...incoming.map((r) => r.firstInteractionAt ?? Number.POSITIVE_INFINITY),
  );
  const inboundWindowEnd = Math.max(
    ...incoming.map((r) => r.lastInteractionAt ?? Number.NEGATIVE_INFINITY),
  );

  if (
    !Number.isFinite(inboundWindowStart) ||
    !Number.isFinite(inboundWindowEnd)
  ) {
    return null;
  }

  const outboundTotal = sum(outgoing.map((r) => r.totalNativeAmountSent ?? 0));
  const outboundAt = Math.max(
    ...outgoing.map((r) => r.lastInteractionAt ?? Number.NEGATIVE_INFINITY),
  );

  if (!Number.isFinite(outboundAt)) {
    return null;
  }

  const hoursBetweenInboundAndOutbound =
    (outboundAt - inboundWindowEnd) / 3600;

  if (
    hoursBetweenInboundAndOutbound < 0 ||
    hoursBetweenInboundAndOutbound > MAX_HOURS_TO_DRAIN
  ) {
    return null;
  }

  const drainRatio = inboundTotal > 0 ? outboundTotal / inboundTotal : 0;

  if (drainRatio < MIN_DRAIN_RATIO) {
    return null;
  }

  // The distinguishing check: does any incoming relationship show activity
  // AFTER the drain event? If so, this looks like routine consolidation
  // (revenue kept arriving), not abandonment - do not match.
  const hasIncomingAfterDrain = incoming.some(
    (r) => (r.lastInteractionAt ?? Number.NEGATIVE_INFINITY) > outboundAt,
  );

  if (hasIncomingAfterDrain) {
    return null;
  }

  const dormancyDays = (nowTimestamp - outboundAt) / 86400;

  if (dormancyDays < MIN_DORMANCY_DAYS) {
    return null;
  }

  return {
    patternId: "raise_and_drain",
    inboundTotalNative: inboundTotal,
    inboundTransactionSignatures: incoming.flatMap(
      (r) => r.transactionSignatures ?? [],
    ),
    inboundWindowStart,
    inboundWindowEnd,
    outboundTotalNative: outboundTotal,
    outboundTransactionSignatures: outgoing.flatMap(
      (r) => r.transactionSignatures ?? [],
    ),
    outboundAt,
    drainRatio,
    hoursBetweenInboundAndOutbound,
    dormantSinceAt: outboundAt,
    dormancyDays,
  };
}
