/** Proves entitlement projection derives lifecycle authority while preserving unresolved ceilings. */

import { describe, expect, test } from "bun:test";
import type { BillingSubscriptionRevision } from "../schemas/billing-subscriptions";
import { deriveSubscriptionEntitlementValues } from "./subscription-entitlements";

const revision = {
  id: "10000000-0000-4000-8000-000000000001",
  organization_id: "10000000-0000-4000-8000-000000000002",
  subscription_id: "10000000-0000-4000-8000-000000000003",
  revision: 7,
  source: "webhook",
  provider: "stripe",
  provider_environment: "test",
  stripe_customer_id: "cus_customer",
  stripe_subscription_id: "sub_subscription",
  stripe_subscription_item_id: "si_item",
  plan_key: "plus_monthly",
  catalog_version: "v1",
  status: "grace",
  current_period_start: new Date("2026-08-01T00:00:00.000Z"),
  current_period_end: new Date("2026-09-01T00:00:00.000Z"),
  cancel_at_period_end: false,
  canceled_at: null,
  ended_at: null,
  dunning_started_at: new Date("2026-08-20T00:00:00.000Z"),
  grace_expires_at: new Date("2026-08-27T00:00:00.000Z"),
  pending_plan_key: null,
  provider_event_id: "evt_paid",
  provider_event_created_at: new Date("2026-08-20T00:00:00.000Z"),
  provider_object_digest: "a".repeat(64),
  recorded_at: new Date("2026-08-20T00:00:01.000Z"),
} satisfies BillingSubscriptionRevision;

const catalogValues = {
  completions_rpm: 120,
  embeddings_rpm: 200,
  standard_rpm: 60,
  strict_rpm: 10,
  cloud_characters_ceiling: null,
  agent_sandboxes_ceiling: null,
  containers_ceiling: null,
  storage_gib_ceiling: null,
  apps_ceiling: null,
};

describe("subscription entitlement derivation", () => {
  test("derives state, bounds, catalog identity, and source instead of trusting a projection caller", () => {
    expect(deriveSubscriptionEntitlementValues(revision)).toEqual({
      ...catalogValues,
      plan_key: "plus_monthly",
      state: "grace",
      entitlement_effective: true,
      effective_from: revision.current_period_start,
      effective_until: revision.current_period_end,
      catalog_version: "v1",
      source_digest: revision.provider_object_digest,
      source_subscription_id: revision.subscription_id,
      source_subscription_revision: 7,
    });
  });

  test("projects terminal lifecycle revisions back to Free", () => {
    const endedAt = new Date("2026-08-25T00:00:00.000Z");
    expect(
      deriveSubscriptionEntitlementValues({ ...revision, status: "canceled", ended_at: endedAt }),
    ).toMatchObject({
      plan_key: "free",
      state: "free",
      entitlement_effective: true,
      effective_from: endedAt,
      effective_until: null,
      source_subscription_id: null,
      source_subscription_revision: null,
    });
    expect(
      deriveSubscriptionEntitlementValues({ ...revision, status: "incomplete_expired" }),
    ).toMatchObject({ plan_key: "free", state: "free" });
  });

  test("keeps unknown paid resource ceilings nullable and rejects unapproved catalogs", () => {
    expect(deriveSubscriptionEntitlementValues(revision).apps_ceiling).toBeNull();
    expect(() =>
      deriveSubscriptionEntitlementValues({ ...revision, catalog_version: "unapproved" }),
    ).toThrow("not present in the immutable catalog");
  });
});
