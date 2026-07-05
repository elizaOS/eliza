/**
 * error-policy pin for the Vast internal-snapshot pricing provider. Vast prices
 * come from an in-source default table plus an operator VAST_PRICING_PER_1M_JSON
 * override — there is NO network fetch, so the only failure surface is a
 * malformed override. This locks that (a) a malformed override is sanitized to
 * "no overrides" and surfaces a warning — it never throws and never
 * fabricates/empties the snapshot; the snapshot degrades to the documented
 * in-source defaults (a money-path decision, left unchanged); and (b) that
 * failure is DISTINCT from a legitimately-absent override (no warning) and from
 * a real override (which actually applies). Uses bun:test with mock.module +
 * dynamic import; global fetch is stubbed to throw to prove vast never touches
 * the wire. No source edit was needed — vast already fails closed.
 */
import { afterEach, beforeEach, expect, mock, test } from "bun:test";

const warnCalls: unknown[][] = [];

// Capture warnings so the "failure surfaces observably" invariant is checkable
// and distinguishable from a silent legitimately-empty result.
mock.module("../../../utils/logger", () => ({
  logger: {
    warn: (...args: unknown[]) => {
      warnCalls.push(args);
    },
    info: () => {},
    error: () => {},
    debug: () => {},
  },
}));

// Passthrough cache so each case re-runs the loader with its own env override.
// The real cache keys on "vast" for 15 min (would return the first case's
// snapshot for every later case) and carries its own dedicated test.
mock.module("../cache", () => ({
  getCachedExternalEntries: async (_key: string, loader: () => Promise<unknown>) => loader(),
}));

const originalFetch = globalThis.fetch;
const originalEnv = process.env.VAST_PRICING_PER_1M_JSON;

beforeEach(() => {
  warnCalls.length = 0;
  // Vast is an internal snapshot: a dead network must NOT affect its pricing.
  globalThis.fetch = (async () => {
    throw new Error("network is unavailable in this test");
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalEnv === undefined) {
    delete process.env.VAST_PRICING_PER_1M_JSON;
  } else {
    process.env.VAST_PRICING_PER_1M_JSON = originalEnv;
  }
});

test("malformed override JSON is sanitized to {} and warns — never throws (J3)", async () => {
  process.env.VAST_PRICING_PER_1M_JSON = "{not valid json";
  const { parseVastPricingOverrides } = await import("./vast");

  // The untrusted env parse failure produces an explicit empty result, not a
  // fabricated price and not an uncaught throw that would 500 the pricing path.
  expect(parseVastPricingOverrides()).toEqual({});
  expect(warnCalls.length).toBeGreaterThan(0);
});

test("absent override env yields {} with NO warning — empty is DISTINCT from failure", async () => {
  delete process.env.VAST_PRICING_PER_1M_JSON;
  const { parseVastPricingOverrides } = await import("./vast");

  // Same {} shape as the malformed case above, but a legitimately-empty result
  // is silent — the failure warns, the empty does not.
  expect(parseVastPricingOverrides()).toEqual({});
  expect(warnCalls.length).toBe(0);
});

test("malformed override still yields the full default snapshot — degrade, not empty/crash", async () => {
  process.env.VAST_PRICING_PER_1M_JSON = "totally not json";
  const { fetchVastSnapshotEntries } = await import("./vast");

  const entries = await fetchVastSnapshotEntries();
  const models = new Set(entries.map((e) => e.model));

  // A parse failure must NOT collapse pricing to empty; it degrades to the
  // documented in-source defaults (money-path behavior, unchanged). Every model
  // contributes an input + output charge.
  expect(models.has("vast/eliza-1-2b")).toBe(true);
  expect(models.has("vast/eliza-1-27b-256k")).toBe(true);
  expect(entries.length).toBe(models.size * 2);
});

test("a valid override actually applies — DISTINCT from the malformed-ignored path", async () => {
  // Caller-chosen override values (not asserting a business price) prove the
  // override is plumbed through rather than swallowed like the malformed case.
  process.env.VAST_PRICING_PER_1M_JSON = JSON.stringify({
    "vast/eliza-1-2b": { input: 7, output: 11 },
  });
  const { fetchVastSnapshotEntries } = await import("./vast");

  const entries = await fetchVastSnapshotEntries();
  const input2b = entries.find((e) => e.model === "vast/eliza-1-2b" && e.chargeType === "input");

  expect(input2b?.metadata).toMatchObject({ perMillionTokens: 7 });
  expect(input2b?.unitPrice).toBe(7 / 1_000_000);
  expect(warnCalls.length).toBe(0);
});

test("invalid override values are skipped + warned; models keep their defaults", async () => {
  process.env.VAST_PRICING_PER_1M_JSON = JSON.stringify({
    "vast/eliza-1-2b": { input: -5, output: 1 }, // negative → rejected
    "vast/eliza-1-9b": { input: "x", output: 2 }, // non-numeric → rejected
  });
  const { fetchVastSnapshotEntries } = await import("./vast");

  const entries = await fetchVastSnapshotEntries();
  const models = new Set(entries.map((e) => e.model));

  // Rejected overrides do not drop the model — it falls back to the in-source
  // default snapshot, and each rejection is warned (one per invalid entry).
  expect(models.has("vast/eliza-1-2b")).toBe(true);
  expect(models.has("vast/eliza-1-9b")).toBe(true);
  expect(warnCalls.length).toBe(2);
});
