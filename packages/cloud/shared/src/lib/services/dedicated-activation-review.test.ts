import { describe, expect, test } from "bun:test";
import {
  DEDICATED_REVIEW_LIFETIME_MS,
  DedicatedActivationReviews,
  type DedicatedReviewRecord,
  dedicatedReviewBinding,
  isDedicatedReviewCurrent,
} from "./dedicated-activation-review";

function fixture() {
  let time = 1_800_000_000_000;
  const rows = new Map<string, unknown>();
  let writes = 0;
  const reviews = new DedicatedActivationReviews(
    {
      read: async (key) =>
        rows.has(key)
          ? { kind: "hit", value: rows.get(key), backend: "memory" }
          : { kind: "miss", backend: "memory" },
      write: async (key, value, ttl) => {
        expect(ttl).toBe(300);
        writes++;
        rows.set(key, structuredClone(value));
        return { kind: "written", backend: "memory" };
      },
    },
    () => time,
  );
  return {
    reviews,
    rows,
    now: () => time,
    advance: (ms: number) => {
      time += ms;
    },
    writes: () => writes,
  };
}
const binding = "a".repeat(64);
const terms = "b".repeat(64);

describe("server-issued Dedicated review", () => {
  test("binds verified session, account, organization, source and authentication method", async () => {
    const auth = {
      authMethod: "session" as const,
      session_token: "inert-session-a",
      user: { id: "user-a", organization_id: "org-a" },
    };
    const expected = await dedicatedReviewBinding(auth, "source-a");
    expect(expected).toMatch(/^[a-f0-9]{64}$/);
    expect(expected).not.toContain(auth.session_token);
    expect(await dedicatedReviewBinding({ ...auth }, "source-a")).toBe(expected);
    for (const changed of [
      { ...auth, session_token: "inert-session-b" },
      { ...auth, user: { ...auth.user, id: "user-b" } },
      { ...auth, user: { ...auth.user, organization_id: "org-b" } },
      { user: auth.user, authMethod: "api_key" as const, apiKey: { id: "key-a" } },
      { user: auth.user, authMethod: "wallet_signature" as const },
    ])
      expect(await dedicatedReviewBinding(changed, "source-a")).not.toBe(expected);
    expect(await dedicatedReviewBinding(auth, "source-b")).not.toBe(expected);
    await expect(
      dedicatedReviewBinding({ ...auth, session_token: undefined }, "source-a"),
    ).rejects.toThrow("current session");
    await expect(
      dedicatedReviewBinding({ user: auth.user, authMethod: "api_key" }, "source-a"),
    ).rejects.toThrow("current API key");
    const apiKey = { user: auth.user, authMethod: "api_key" as const, apiKey: { id: "key-a" } };
    expect(await dedicatedReviewBinding(apiKey, "source-a")).not.toBe(
      await dedicatedReviewBinding({ ...apiKey, apiKey: { id: "key-b" } }, "source-a"),
    );
  });
  test("each review has a distinct opaque ID and a non-sliding server lifetime", async () => {
    const f = fixture();
    const first = await f.reviews.issue(binding, terms);
    const second = await f.reviews.issue(binding, terms);
    expect(first.quoteId).toMatch(/^[a-f0-9]{64}$/);
    expect(first.quoteId).not.toBe(second.quoteId);
    expect(first.expiresAt - first.issuedAt).toBe(DEDICATED_REVIEW_LIFETIME_MS);
    f.advance(299_999);
    expect(await f.reviews.resolve(first.quoteId, binding)).toEqual(first);
    f.advance(1);
    expect(await f.reviews.resolve(first.quoteId, binding)).toBeNull();
    expect(f.writes()).toBe(2);
    expect(f.rows.size).toBe(2); // retained cache data cannot extend validity
  });
  test("missing or differently bound review cannot be reconstructed", async () => {
    const f = fixture();
    const issued = await f.reviews.issue(binding, terms);
    expect(await f.reviews.resolve(issued.quoteId, "c".repeat(64))).toBeNull();
    f.rows.clear();
    expect(await f.reviews.resolve(issued.quoteId, binding)).toBeNull();
    expect(f.writes()).toBe(1);
  });
  test("returns snapshots without giving a caller mutable store ownership", async () => {
    const f = fixture();
    const issued = await f.reviews.issue(binding, terms);
    const original = { ...issued };
    issued.expiresAt += 1000;
    const read = await f.reviews.resolve(issued.quoteId, binding);
    expect(read).toEqual(original);
    if (!read) throw new Error("missing fixture review");
    read.termsId = "d".repeat(64);
    expect(await f.reviews.resolve(issued.quoteId, binding)).toEqual(original);
  });
  for (const kind of ["unavailable", "error", "invalid"] as const) {
    test(`fails closed on ${kind} storage`, async () => {
      const reviews = new DedicatedActivationReviews({
        read: async () => ({ kind, backend: "memory" }),
        write: async () => ({ kind, backend: "memory" }),
      });
      await expect(reviews.issue(binding, terms)).rejects.toThrow("could not be issued");
      expect(await reviews.resolve("e".repeat(64), binding)).toBeNull();
    });
  }
  test("checks the deadline after an asynchronous store write", async () => {
    let time = 1_800_000_000_000;
    const reviews = new DedicatedActivationReviews(
      {
        read: async () => ({ kind: "miss", backend: "memory" }),
        write: async () => {
          time += DEDICATED_REVIEW_LIFETIME_MS;
          return { kind: "written", backend: "memory" };
        },
      },
      () => time,
    );
    await expect(reviews.issue(binding, terms)).rejects.toThrow("could not be issued");
  });
  for (const corrupt of [null, {}, { version: 2 }, { expiresAt: Infinity }]) {
    test(`rejects malformed cached review ${JSON.stringify(corrupt)}`, async () => {
      const f = fixture();
      const issued = await f.reviews.issue(binding, terms);
      for (const key of f.rows.keys()) f.rows.set(key, corrupt);
      expect(await f.reviews.resolve(issued.quoteId, binding)).toBeNull();
    });
  }
  test("rejects wrong identity, extended lifetime and future issuance in otherwise shaped records", async () => {
    const f = fixture();
    const issued = await f.reviews.issue(binding, terms);
    for (const change of [
      { quoteId: "c".repeat(64) },
      { expiresAt: issued.expiresAt + 1 },
      { issuedAt: issued.issuedAt + 1, expiresAt: issued.expiresAt + 1 },
    ]) {
      for (const key of f.rows.keys()) f.rows.set(key, { ...issued, ...change });
      expect(await f.reviews.resolve(issued.quoteId, binding)).toBeNull();
    }
    expect(isDedicatedReviewCurrent(issued, Number.NaN)).toBe(false);
    expect(
      isDedicatedReviewCurrent(
        { ...issued, expiresAt: Infinity } as DedicatedReviewRecord,
        f.now(),
      ),
    ).toBe(false);
  });
});
