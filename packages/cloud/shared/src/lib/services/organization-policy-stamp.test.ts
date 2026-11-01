/**
 * The policy stamp validator accepts what the quota policy reader emits. A
 * lifetime subscription grant (subscription_grants.ends_at NULL) is served as
 * a promo_grant policy whose effectiveUntil is null; every other malformed
 * stamp stays rejected.
 */
import { describe, expect, test } from "bun:test";
import { isOrganizationPolicyStamp } from "./organization-policy-stamp";
import type { OrganizationPolicyStamp } from "./organization-quota-policy";

const NOW = Date.parse("2026-11-01T12:00:00.000Z");
const DAY_MS = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

/** The authority readOrganizationQuotaPolicy emits for a redeemed lifetime grant. */
const lifetimeGrant: OrganizationPolicyStamp = {
  generation: "1",
  source: "promo_grant",
  sourceSubscriptionId: null,
  sourceRevision: null,
  projectionRevision: "1",
  catalogVersion: "v1",
  sourceGrantId: "5ab06ba4-13dd-48de-8df0-3e0d1d4af7bd",
  effectiveFrom: iso(NOW - DAY_MS),
  effectiveUntil: null,
};
const timeLimitedGrant: OrganizationPolicyStamp = {
  ...lifetimeGrant,
  effectiveUntil: iso(NOW + 30 * DAY_MS),
};

describe("isOrganizationPolicyStamp", () => {
  test("accepts a lifetime promo grant stamp (effectiveUntil null)", () => {
    expect(isOrganizationPolicyStamp(lifetimeGrant, NOW)).toBe(true);
    // A JSON cache round trip keeps it valid.
    expect(isOrganizationPolicyStamp(JSON.parse(JSON.stringify(lifetimeGrant)), NOW)).toBe(true);
    // It stays valid however far in the future it is read.
    expect(isOrganizationPolicyStamp(lifetimeGrant, NOW + 3650 * DAY_MS)).toBe(true);
  });

  test("a time-limited promo grant stamp is unchanged: valid before its end, rejected from it", () => {
    expect(isOrganizationPolicyStamp(timeLimitedGrant, NOW)).toBe(true);
    const end = Date.parse(timeLimitedGrant.effectiveUntil as string);
    expect(isOrganizationPolicyStamp(timeLimitedGrant, end - 1)).toBe(true);
    expect(isOrganizationPolicyStamp(timeLimitedGrant, end)).toBe(false);
    expect(isOrganizationPolicyStamp(timeLimitedGrant, end + DAY_MS)).toBe(false);
  });

  test("legacy and subscription stamps are unchanged", () => {
    const legacy: OrganizationPolicyStamp = {
      generation: "0",
      source: "legacy",
      sourceSubscriptionId: null,
      sourceRevision: null,
      projectionRevision: null,
      catalogVersion: null,
      effectiveFrom: iso(0),
      effectiveUntil: null,
    };
    expect(isOrganizationPolicyStamp(legacy, NOW)).toBe(true);
    expect(isOrganizationPolicyStamp({ ...legacy, catalogVersion: "v1" }, NOW)).toBe(false);
    const subscription: OrganizationPolicyStamp = {
      generation: "3",
      source: "subscription",
      sourceSubscriptionId: "sub-1",
      sourceRevision: "2",
      projectionRevision: "4",
      catalogVersion: "v1",
      effectiveFrom: iso(NOW - DAY_MS),
      effectiveUntil: iso(NOW + DAY_MS),
    };
    expect(isOrganizationPolicyStamp(subscription, NOW)).toBe(true);
    expect(isOrganizationPolicyStamp({ ...subscription, effectiveUntil: null }, NOW)).toBe(true);
    expect(isOrganizationPolicyStamp({ ...subscription, sourceRevision: "0" }, NOW)).toBe(false);
  });

  test("every other malformed promo grant stamp is still rejected", () => {
    const malformed: Array<[string, unknown]> = [
      ["missing effectiveUntil", { ...lifetimeGrant, effectiveUntil: undefined }],
      ["unparseable effectiveUntil", { ...lifetimeGrant, effectiveUntil: "never" }],
      ["numeric effectiveUntil", { ...lifetimeGrant, effectiveUntil: NOW + DAY_MS }],
      ["empty effectiveUntil", { ...lifetimeGrant, effectiveUntil: "" }],
      ["future effectiveFrom", { ...lifetimeGrant, effectiveFrom: iso(NOW + DAY_MS) }],
      ["missing effectiveFrom", { ...lifetimeGrant, effectiveFrom: null }],
      ["missing sourceGrantId", { ...lifetimeGrant, sourceGrantId: undefined }],
      ["null sourceGrantId", { ...lifetimeGrant, sourceGrantId: null }],
      ["empty sourceGrantId", { ...lifetimeGrant, sourceGrantId: "" }],
      ["subscription id", { ...lifetimeGrant, sourceSubscriptionId: "sub-1" }],
      ["subscription revision", { ...lifetimeGrant, sourceRevision: "1" }],
      ["null projectionRevision", { ...lifetimeGrant, projectionRevision: null }],
      ["non-numeric projectionRevision", { ...lifetimeGrant, projectionRevision: "x" }],
      ["null catalogVersion", { ...lifetimeGrant, catalogVersion: null }],
      ["empty catalogVersion", { ...lifetimeGrant, catalogVersion: "" }],
      ["non-numeric generation", { ...lifetimeGrant, generation: "01" }],
      ["unknown source", { ...lifetimeGrant, source: "gift" }],
      ["null", null],
    ];
    for (const [label, stamp] of malformed)
      expect({ label, valid: isOrganizationPolicyStamp(stamp, NOW) }).toEqual({
        label,
        valid: false,
      });
  });
});
