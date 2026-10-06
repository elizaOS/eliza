import { expect, test } from "bun:test";
import { proveOriginalConfiguredTarget as prove } from "./organization-schedule-target-authority";
import { originalTargetFixture as fixture } from "./organization-schedule-target-test-fixture";

test("original durable command binds paid-target expectations beyond event retention without mutating source", () => {
  const f = fixture(),
    before = structuredClone(f);
  const result = prove(f);
  expect(result.targetPlanKey).toBe("plus_monthly");
  expect(result.targetAmountCents).toBe(3000);
  expect(result.targetAllowanceUsd).toBe("25.000000");
  expect(result.binding.targetPriceId).toBe("price_plus");
  expect(f).toEqual(before);
});
for (const [name, change] of [
  [
    "missing durable snapshot",
    (f: ReturnType<typeof fixture>) => {
      f.command.organization_schedule_configuration_snapshot = null;
    },
  ],
  [
    "foreign organization",
    (f: ReturnType<typeof fixture>) => {
      f.command.organization_id = "org_other";
    },
  ],
  [
    "foreign source",
    (f: ReturnType<typeof fixture>) => {
      f.command.subscription_id = "other";
    },
  ],
  [
    "later source revision",
    (f: ReturnType<typeof fixture>) => {
      f.source.lifecycle_revision++;
    },
  ],
  [
    "unapplied command",
    (f: ReturnType<typeof fixture>) => {
      f.command.status = "OUTCOME_UNKNOWN";
    },
  ],
  [
    "replaced proof digest",
    (f: ReturnType<typeof fixture>) => {
      f.command.provider_response_digest = "0".repeat(64);
    },
  ],
  [
    "cleared pending target",
    (f: ReturnType<typeof fixture>) => {
      f.source.pending_plan_key = null;
    },
  ],
  [
    "foreign quote",
    (f: ReturnType<typeof fixture>) => {
      f.quoteId = "other";
    },
  ],
  [
    "changed catalog binding",
    (f: ReturnType<typeof fixture>) => {
      f.providerBinding = {
        ...(f.providerBinding as Record<string, unknown>),
        targetProductId: "prod_other",
      };
    },
  ],
  [
    "changed effective period",
    (f: ReturnType<typeof fixture>) => {
      f.source.current_period_end = new Date(201000);
    },
  ],
  [
    "app scoped command",
    (f: ReturnType<typeof fixture>) => {
      f.command.app_id = "app_other";
    },
  ],
] as const)
  test(name + " cannot authorize target settlement", () => {
    const f = fixture();
    change(f);
    expect(() => prove(f)).toThrow(
      expect.objectContaining({ code: "SUBSCRIPTION_SCHEDULE_TARGET_UNVERIFIED" }),
    );
  });
