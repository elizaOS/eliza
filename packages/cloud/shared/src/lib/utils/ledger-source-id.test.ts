/**
 * Deterministic unit coverage for `normalizeLedgerSourceId`. The helper is pure
 * apart from a SHA-256 digest, so every case is an exact input/output
 * assertion.
 *
 * This is a ledger identity function: `redeemable_earnings_ledger.source_id` is
 * a `uuid` column, and dedupe keys such as `revenue_split:<paymentIntent>:<user>`
 * are not UUIDs, so they are folded into one. Two properties are therefore
 * load-bearing and are asserted directly rather than assumed — the mapping must
 * be stable across calls (a retry must dedupe against the earlier row) and
 * injective enough that two distinct keys never collapse onto one id.
 *
 * The accepted-UUID gate is narrower than "looks like a UUID": the version
 * nibble is restricted to 1-5, so a UUIDv7 or the nil UUID is *derived* rather
 * than passed through. That is pinned below because it is invisible at the call
 * site and changes which ledger row a key lands on.
 */

import { describe, expect, it } from "vitest";
import { normalizeLedgerSourceId } from "./ledger-source-id";

/** The shape the ledger column requires: RFC-4122 version 1-5, variant 8/9/a/b. */
const UUID_CONTRACT = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const V4 = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const V1 = "b54adc00-67f9-11d9-9669-0800200c9a66";
const V5 = "886313e1-3b8a-5372-9b90-0c9aee199e5d";
/** UUIDv7 — valid RFC 9562, but version 7 is outside the accepted 1-5 class. */
const V7 = "0197b3f1-8c2a-7def-9abc-1234567890ab";
const NIL = "00000000-0000-0000-0000-000000000000";

describe("canonical UUIDs pass through", () => {
  it.each([V1, V4, V5])("returns %s unchanged", (uuid) => {
    expect(normalizeLedgerSourceId(uuid)).toBe(uuid);
  });

  it("lowercases an upper-case UUID so casing cannot split a dedupe key", () => {
    expect(normalizeLedgerSourceId(V4.toUpperCase())).toBe(V4);
  });

  it("trims surrounding whitespace before matching", () => {
    expect(normalizeLedgerSourceId(`  ${V4}\n`)).toBe(V4);
  });
});

describe("values outside the accepted UUID class are derived, not passed through", () => {
  it.each([
    ["UUIDv7", V7],
    ["the nil UUID", NIL],
    ["a UUID with an invalid variant nibble", "f47ac10b-58cc-4372-c567-0e02b2c3d479"],
    ["a truncated UUID", "f47ac10b-58cc-4372-a567-0e02b2c3d47"],
  ])("derives a new id for %s", (_label, value) => {
    const out = normalizeLedgerSourceId(value);
    expect(out).not.toBe(value.toLowerCase());
    expect(out).toMatch(UUID_CONTRACT);
  });

  it("derives an id for the dedupe keys the earnings ledger actually uses", () => {
    for (const key of [
      "revenue_split:pi_3PabcdEfGhIjKlMn:11111111-1111-4111-8111-111111111111",
      "crypto_revenue_split:9f2c:22222222-2222-4222-8222-222222222222",
      "",
    ]) {
      expect(normalizeLedgerSourceId(key)).toMatch(UUID_CONTRACT);
    }
  });
});

describe("identity properties the ledger depends on", () => {
  const keys = [
    "revenue_split:pi_1:user_a",
    "revenue_split:pi_1:user_b",
    "revenue_split:pi_2:user_a",
    "app_owner:9",
    "",
    " ",
  ];

  it("is stable across calls, so a retry dedupes against the first row", () => {
    for (const key of keys) {
      expect(normalizeLedgerSourceId(key)).toBe(normalizeLedgerSourceId(key));
    }
  });

  it("is idempotent — re-normalising a derived id returns it unchanged", () => {
    // Only holds because the derived id satisfies UUID_CONTRACT itself; if the
    // forced version/variant nibbles regressed, the second pass would re-hash.
    for (const key of keys) {
      const once = normalizeLedgerSourceId(key);
      expect(normalizeLedgerSourceId(once)).toBe(once);
    }
  });

  it("maps distinct keys to distinct ids", () => {
    // `" "` is excluded: it trims to `""`, so the two are the same key by
    // design — asserted separately below.
    const distinct = keys.filter((key) => key.trim() !== "");
    const ids = distinct.map((key) => normalizeLedgerSourceId(key));
    expect(new Set(ids).size).toBe(distinct.length);
  });

  it("treats whitespace-only and empty keys as the same key", () => {
    // Both trim to "", so they intentionally share one derived id.
    expect(normalizeLedgerSourceId(" ")).toBe(normalizeLedgerSourceId(""));
  });

  it("always produces a value the uuid column accepts", () => {
    for (const key of [...keys, V7, NIL, "x".repeat(512), "🙂 unicode key"]) {
      expect(normalizeLedgerSourceId(key)).toMatch(UUID_CONTRACT);
    }
  });
});
