/**
 * Pins the settlement replay digest to UTF-16 code-unit key ordering. The digest
 * is the idempotency key for invoice creation, app-charge callback outbox
 * delivery, and direct wallet payment replay, so "same settlement contract =>
 * same digest" must hold on every host. ICU collation breaks that twice: it
 * orders mixed-case and non-ASCII keys by locale, and it ranks canonically
 * equivalent-but-distinct keys as equal, which leaves their relative order
 * decided by object insertion order rather than by content.
 */
import { describe, expect, test } from "bun:test";

import { canonicalSettlementJson, settlementDigest } from "./settlement-digest";

// Precomposed U+00E9 vs decomposed "e" + U+0301. Distinct JavaScript property
// keys that `localeCompare` reports as equal (returns 0).
const NFC_KEY = "caf\u00e9"; // precomposed U+00E9
const NFD_KEY = "cafe\u0301"; // decomposed "e" + U+0301

describe("settlement digest canonical key order", () => {
  test("orders mixed-case keys by code unit, not by locale collation", () => {
    // Code unit: "B" (0x42) < "a" (0x61). ICU collation puts "a" before "B".
    expect(canonicalSettlementJson({ a: 1, B: 2 })).toBe('{"B":2,"a":1}');
  });

  test("orders non-ASCII keys by code unit, not by locale collation", () => {
    // Code unit: "z" (0x7a) < "\u00e4" (0xe4). ICU collation puts "\u00e4" before "z".
    expect(canonicalSettlementJson({ "\u00e4": 1, z: 2 })).toBe('{"z":2,"\u00e4":1}');
  });

  test("nested settlement metadata uses the same code-unit ordering", () => {
    expect(canonicalSettlementJson({ meta: { a: 1, B: 2 }, A: 3 })).toBe(
      '{"A":3,"meta":{"B":2,"a":1}}',
    );
  });

  test("canonically equivalent distinct keys get a total order independent of insertion order", () => {
    // Under ICU collation these two keys compare equal, so the sort is stable on
    // insertion order and the same contract digests two different ways.
    const inserted = { [NFC_KEY]: 1, [NFD_KEY]: 2 };
    const reversed = { [NFD_KEY]: 2, [NFC_KEY]: 1 };
    expect(Object.keys(inserted)).toHaveLength(2);
    expect(settlementDigest(inserted)).toBe(settlementDigest(reversed));
    expect(canonicalSettlementJson(inserted)).toBe(canonicalSettlementJson(reversed));
  });

  test("zero-width-joined metadata keys also stay insertion-order independent", () => {
    const plain = "sku";
    const zeroWidth = "sk\u200bu";
    expect(settlementDigest({ [plain]: 1, [zeroWidth]: 2 })).toBe(
      settlementDigest({ [zeroWidth]: 2, [plain]: 1 }),
    );
  });

  test("digest stays a pure function of content for a realistic settlement contract", () => {
    const contract = {
      amount_due: "10.00",
      Currency: "usd",
      metadata: { Plan: "pro", plan_id: "p-1" },
      stripe_invoice_id: "in_123",
    };
    const reordered = {
      stripe_invoice_id: "in_123",
      metadata: { plan_id: "p-1", Plan: "pro" },
      Currency: "usd",
      amount_due: "10.00",
    };
    expect(settlementDigest(contract)).toBe(settlementDigest(reordered));
    expect(canonicalSettlementJson(contract)).toBe(
      '{"Currency":"usd","amount_due":"10.00","metadata":{"Plan":"pro","plan_id":"p-1"},"stripe_invoice_id":"in_123"}',
    );
  });
});
