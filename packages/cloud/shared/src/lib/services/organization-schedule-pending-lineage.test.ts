import { expect, test } from "bun:test";
import { readConfiguredPendingSource as read } from "./organization-schedule-pending-lineage";
import { reviewFixture } from "./organization-schedule-target-review-test-fixture";
import { SUBSCRIPTION_PAYMENT_GRACE_MS } from "./subscription-payment-grace";

function fixture() {
  const source: Parameters<typeof read>[0] = {
    ...reviewFixture().source,
    organization_id: "org_original",
    lifecycle_revision: 2,
    pending_plan_key: "plus_monthly",
    status: "active",
    quantity: 1,
    provider_object_digest: "a".repeat(64),
  };
  const configured = { ...source, subscription_id: source.id, revision: 2 };
  const current = {
    ...source,
    lifecycle_revision: 3,
    status: "grace" as const,
    provider_object_digest: "b".repeat(64),
    dunning_started_at: source.current_period_end,
    grace_expires_at: new Date(source.current_period_end.getTime() + SUBSCRIPTION_PAYMENT_GRACE_MS),
  };
  const revisions: Parameters<typeof read>[1] = [
    configured,
    { ...current, subscription_id: source.id, revision: 3 },
  ];
  return { source: current as Parameters<typeof read>[0], revisions };
}
test("recovers the actual configured source while preserving current dunning authority", () => {
  const f = fixture(),
    original = read(f.source, f.revisions, 2);
  expect(original.lifecycle_revision).toBe(2);
  expect(original.status).toBe("active");
  expect(original.provider_object_digest).toBe("a".repeat(64));
  expect(original.pending_plan_key).toBe("plus_monthly");
  expect(f.source.status).toBe("grace");
});
test("supports complete subsequent past_due and unpaid revisions without resetting grace", () => {
  const f = fixture();
  for (const status of ["past_due", "unpaid"] as const) {
    f.source = {
      ...f.source,
      status,
      lifecycle_revision: f.source.lifecycle_revision + 1,
      provider_object_digest: status.repeat(8),
    };
    f.revisions.push({
      ...f.source,
      subscription_id: f.source.id,
      revision: f.source.lifecycle_revision,
    });
  }
  expect(read(f.source, f.revisions, 2).lifecycle_revision).toBe(2);
});
const mutations: Array<[string, (f: ReturnType<typeof fixture>) => void]> = [
  [
    "early dunning start",
    (f) => {
      f.revisions[1]!.dunning_started_at = new Date(100000);
    },
  ],
  [
    "missing configured revision",
    (f) => {
      f.revisions.shift();
    },
  ],
  [
    "revision gap",
    (f) => {
      f.revisions[1]!.revision++;
    },
  ],
  [
    "foreign subscription",
    (f) => {
      f.revisions[1]!.subscription_id = "foreign";
    },
  ],
  [
    "foreign organization",
    (f) => {
      f.revisions[1]!.organization_id = "foreign";
    },
  ],
  [
    "changed paid plan",
    (f) => {
      f.revisions[1]!.plan_key = "plus_monthly";
    },
  ],
  [
    "removed pending target",
    (f) => {
      f.revisions[1]!.pending_plan_key = null;
    },
  ],
  [
    "changed paid period",
    (f) => {
      f.revisions[1]!.current_period_end = new Date(201000);
    },
  ],
  [
    "changed paid item",
    (f) => {
      f.revisions[1]!.stripe_subscription_item_id = "si_foreign";
    },
  ],
  [
    "cancellation",
    (f) => {
      f.revisions[1]!.cancel_at_period_end = true;
    },
  ],
  [
    "unsupported active descendant",
    (f) => {
      f.revisions[1]!.status = "active";
    },
  ],
  [
    "missing dunning start",
    (f) => {
      f.revisions[1]!.dunning_started_at = null;
    },
  ],
  [
    "late dunning start",
    (f) => {
      f.revisions[1]!.dunning_started_at = new Date(201000);
    },
  ],
  [
    "reversed grace window",
    (f) => {
      f.revisions[1]!.grace_expires_at = new Date(100000);
    },
  ],
  [
    "changed current observation",
    (f) => {
      f.source.provider_object_digest = "foreign";
    },
  ],
  [
    "changed current grace",
    (f) => {
      f.source.grace_expires_at = new Date(999999);
    },
  ],
];
test("a later dunning revision cannot extend the retained grace window", () => {
  const f = fixture();
  f.source = {
    ...f.source,
    lifecycle_revision: 4,
    grace_expires_at: new Date(f.source.grace_expires_at!.getTime() + 1000),
  };
  f.revisions.push({ ...f.source, subscription_id: f.source.id, revision: 4 });
  expect(() => read(f.source, f.revisions, 2)).toThrow();
});
for (const [name, mutate] of mutations)
  test(`rejects ${name}`, () => {
    const f = fixture();
    mutate(f);
    expect(() => read(f.source, f.revisions, 2)).toThrow();
  });
