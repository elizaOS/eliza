/**
 * Proves the scam_pattern_candidates persistence path end to end: a real
 * Pattern A (raise-and-drain) match, detected from the AnubisDAO fixture
 * already used in patterns/raiseAndDrain.test.ts, gets inserted through
 * the store and read back correctly - the same data-layer proof pattern
 * as approval/service.test.ts (an in-memory fake interpreting the store's
 * actual raw SQL, no live database connection).
 */

import { describe, expect, it, vi } from "vitest";
import { WalletRelationship } from "../types";
import { detectRaiseAndDrainPattern } from "../patterns/raiseAndDrain";
import { checkKnownLabelMatches } from "../patterns/knownLabelMatch";
import { ScamPatternCandidateStore } from "./store";
import type { RuntimeDb } from "./sql";

vi.mock("drizzle-orm", () => ({
  sql: {
    raw: (text: string) => ({ __sql: text, queryChunks: [text] }),
  },
}));

// Same AnubisDAO Liquidity Rug 2 fixture as patterns/raiseAndDrain.test.ts.
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

// Same raise-and-drain shape, but the outbound counterparty is Binance 14
// (0x28c6c06298d514db089934071355e5743bf21d60) - a real, already-verified
// centralized_exchange entry in labels/staticRegistry.ts. Detection should
// still match structurally, but the label-match check must flag it so a
// reviewer sees the exchange label immediately.
const DRAIN_TO_KNOWN_EXCHANGE_RELATIONSHIPS: WalletRelationship[] = [
  {
    address: "0xsome-unlabeled-funding-source",
    relationship: "counterparty",
    confidence: "high",
    direction: "incoming",
    firstInteractionAt: 1635429600,
    lastInteractionAt: 1635430800,
    totalNativeAmountReceived: 13597,
    totalNativeAmountSent: 0,
    transactionSignatures: ["0xfixture-known-exchange-inbound-1"],
  },
  {
    address: "0x28c6c06298d514db089934071355e5743bf21d60",
    relationship: "counterparty",
    confidence: "high",
    direction: "outgoing",
    firstInteractionAt: 1635502800,
    lastInteractionAt: 1635502800,
    totalNativeAmountReceived: 0,
    totalNativeAmountSent: 12800,
    transactionSignatures: ["0xfixture-known-exchange-outbound-1"],
  },
];

const NOW_TIMESTAMP = 1785900000;

/** Extract single-quoted SQL string literals in order, unescaping ''. */
function extractStringLiterals(sqlText: string): string[] {
  const matches = sqlText.match(/'(?:[^']|'')*'/g) ?? [];
  return matches.map((m) => m.slice(1, -1).replace(/''/g, "'"));
}

function extractInsertValues(sqlText: string): string[] {
  const valuesMatch = sqlText.match(/VALUES\s*\(([\s\S]*)\)\s*RETURNING/);
  if (!valuesMatch) throw new Error("could not find VALUES(...) in INSERT");
  return extractStringLiterals(valuesMatch[1]);
}

/**
 * Minimal in-memory fake of the scam_pattern_candidates table - recognizes
 * exactly the INSERT/SELECT/UPDATE shapes ScamPatternCandidateStore emits,
 * same purpose-built-interpreter approach as approval/service.test.ts.
 */
function createFakeDb(): RuntimeDb {
  const rows = new Map<string, Record<string, unknown>>();

  return {
    execute: async (query: { queryChunks: Array<{ value?: unknown }> }) => {
      const sqlText = (query as unknown as { __sql?: string }).__sql ?? "";

      if (sqlText.startsWith("INSERT INTO")) {
        // hasKnownLabelMatch renders as a bare TRUE/FALSE keyword (sqlBoolean),
        // not a quoted string literal, so it's checked separately rather
        // than destructured from the string-literal list below.
        const [id, chain, address, patterns, evidence, labelMatches] =
          extractInsertValues(sqlText);

        const row = {
          id,
          chain,
          address,
          patterns,
          evidence,
          has_known_label_match: /,\s*TRUE\s*,/.test(sqlText),
          label_matches: labelMatches,
          review_status: "pending",
          reviewed_by: null,
          reviewed_at: null,
          review_notes: null,
          created_at: new Date().toISOString(),
        };
        rows.set(id, row);
        return { rows: [row] };
      }

      if (sqlText.startsWith("SELECT")) {
        const literals = extractStringLiterals(sqlText);
        const all = Array.from(rows.values());

        if (sqlText.includes("WHERE id =")) {
          const [id] = literals;
          return { rows: all.filter((r) => r.id === id) };
        }
        if (sqlText.includes("WHERE chain =") && sqlText.includes("address =")) {
          const [chain, address] = literals;
          return { rows: all.filter((r) => r.chain === chain && r.address === address) };
        }
        return { rows: all };
      }

      if (sqlText.startsWith("UPDATE")) {
        const literals = extractStringLiterals(sqlText);
        // literals order per store.ts's UPDATE: [target, reviewedBy, reviewNotes, id]
        const [target, reviewedBy, reviewNotes, id] = literals;
        const existing = rows.get(id);
        if (!existing) return { rows: [] };
        const updated = {
          ...existing,
          review_status: target,
          reviewed_by: reviewedBy,
          reviewed_at: new Date().toISOString(),
          review_notes: reviewNotes,
        };
        rows.set(id, updated);
        return { rows: [updated] };
      }

      throw new Error(`unrecognized SQL in fake db: ${sqlText}`);
    },
  };
}

describe("ScamPatternCandidateStore - end-to-end with a real Pattern A match", () => {
  it("inserts an AnubisDAO-shaped raise-and-drain match as pending and reads it back", async () => {
    const evidence = detectRaiseAndDrainPattern(
      ANUBISDAO_RUG2_RELATIONSHIPS,
      NOW_TIMESTAMP,
    );

    // Prerequisite: the detector itself must actually match this fixture -
    // if this fails, the persistence proof below would be meaningless.
    expect(evidence).not.toBeNull();

    const walletAddress = "0x9fc53c75046900d1f58209f50f534852ae9f912a";

    // Real check, not a hardcoded literal - AnubisDAO's actual counterparties
    // aren't labeled exchanges, so this should come back false/[].
    const labelCheck = checkKnownLabelMatches(
      "ethereum",
      walletAddress,
      ANUBISDAO_RUG2_RELATIONSHIPS,
    );
    expect(labelCheck.hasKnownLabelMatch).toBe(false);
    expect(labelCheck.labelMatches).toEqual([]);

    const db = createFakeDb();
    const store = new ScamPatternCandidateStore(db);

    const inserted = await store.insert({
      chain: "ethereum",
      address: walletAddress,
      patterns: ["raise_and_drain"],
      evidence: evidence as unknown as Record<string, unknown>,
      hasKnownLabelMatch: labelCheck.hasKnownLabelMatch,
      labelMatches: labelCheck.labelMatches,
    });

    expect(inserted.reviewStatus).toBe("pending");
    expect(inserted.chain).toBe("ethereum");
    expect(inserted.address).toBe(walletAddress);
    expect(inserted.patterns).toEqual(["raise_and_drain"]);
    expect(inserted.hasKnownLabelMatch).toBe(false);
    expect(inserted.labelMatches).toEqual([]);

    // Read back via a fresh lookup, not just the insert's own return value -
    // proves the round trip, not just that insert echoes its input.
    const readBack = await store.byAddress("ethereum", walletAddress);

    expect(readBack).not.toBeNull();
    expect(readBack?.reviewStatus).toBe("pending");
    expect(readBack?.hasKnownLabelMatch).toBe(false);
    expect(readBack?.evidence).toMatchObject({
      patternId: "raise_and_drain",
      inboundTotalNative: 13597,
      outboundTotalNative: 12800,
    });

    // The review-status transition path also works against the same row.
    const accepted = await store.accept(inserted.id, {
      reviewedBy: "test-reviewer",
      reviewNotes: "Matches the documented AnubisDAO shape.",
    });
    expect(accepted.reviewStatus).toBe("accepted");
    expect(accepted.reviewedBy).toBe("test-reviewer");
  });

  it("flags and persists a match whose counterparty is already labeled a known exchange", async () => {
    const walletAddress = "0xanother-flagged-wallet";

    const evidence = detectRaiseAndDrainPattern(
      DRAIN_TO_KNOWN_EXCHANGE_RELATIONSHIPS,
      NOW_TIMESTAMP,
    );
    expect(evidence).not.toBeNull();

    const labelCheck = checkKnownLabelMatches(
      "ethereum",
      walletAddress,
      DRAIN_TO_KNOWN_EXCHANGE_RELATIONSHIPS,
    );
    expect(labelCheck.hasKnownLabelMatch).toBe(true);
    expect(labelCheck.labelMatches).toEqual([
      {
        address: "0x28c6c06298d514db089934071355e5743bf21d60",
        label: "Binance 14",
        relationship: "counterparty",
      },
    ]);

    const db = createFakeDb();
    const store = new ScamPatternCandidateStore(db);

    const inserted = await store.insert({
      chain: "ethereum",
      address: walletAddress,
      patterns: ["raise_and_drain"],
      evidence: evidence as unknown as Record<string, unknown>,
      hasKnownLabelMatch: labelCheck.hasKnownLabelMatch,
      labelMatches: labelCheck.labelMatches,
    });

    expect(inserted.hasKnownLabelMatch).toBe(true);
    expect(inserted.labelMatches).toEqual([
      {
        address: "0x28c6c06298d514db089934071355e5743bf21d60",
        label: "Binance 14",
        relationship: "counterparty",
      },
    ]);

    const readBack = await store.byAddress("ethereum", walletAddress);
    expect(readBack?.hasKnownLabelMatch).toBe(true);
    expect(readBack?.labelMatches).toEqual([
      {
        address: "0x28c6c06298d514db089934071355e5743bf21d60",
        label: "Binance 14",
        relationship: "counterparty",
      },
    ]);
  });
});
