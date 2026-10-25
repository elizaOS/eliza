import { expect, test } from "bun:test";
import type { BillingSubscription } from "../../db/schemas/billing-subscriptions";
import {
  type ConfiguredCancellationAuthority,
  configuredCancellationRequest,
  observeConfiguredCancellation,
} from "./configured-schedule-cancellation";
import { reviewFixture } from "./organization-schedule-target-review-test-fixture";
import { settlementDigest } from "./settlement-digest";

function fixture() {
  const f = reviewFixture();
  const request = f.originalConfiguration.originalRequest.request;
  if (request.kind !== "schedule_configure") throw Error("Expected configured fixture");
  const authority: ConfiguredCancellationAuthority = {
    scheduleId: request.scheduleId,
    originalSnapshot: structuredClone(f.rawCurrentSchedule),
    originalTerms: f.originalTerms,
    originalRequest: request,
    originalPending: true,
    authorityDigest: settlementDigest(request),
  };
  return {
    authority,
    source: { ...f.source, pending_plan_key: "plus_monthly" } as BillingSubscription,
    rawSchedule: structuredClone(f.rawCurrentSchedule),
    rawSubscription: { ...f.rawSubscription, schedule: authority.scheduleId },
    observedAt: new Date(150000),
  };
}
test("one phase request preserves every original current-phase term without proration or lower-plan renewal", () => {
  const f = fixture();
  const request = configuredCancellationRequest(f.authority, true);
  expect(request).toEqual({
    end_behavior: "cancel",
    proration_behavior: "none",
    phases: [f.authority.originalRequest.params.phases[0]],
  });
  request.phases[0]!.metadata = { changed: "value" };
  expect(request.phases).not.toEqual([f.authority.originalRequest.params.phases[0]]);
  expect(configuredCancellationRequest(f.authority, false).end_behavior).toBe("release");
});
test("observes original pending, cancel_at-bound cancellation and explicit single-phase resume", () => {
  const f = fixture();
  expect(observeConfiguredCancellation(f).mode).toBe("pending");
  f.rawSchedule.phases = [f.rawSchedule.phases[0]!];
  f.rawSchedule.end_behavior = "cancel";
  const cancelled = { ...f, rawSubscription: { ...f.rawSubscription, cancel_at: 200 } };
  expect(observeConfiguredCancellation(cancelled).scheduled).toBeTrue();
  expect(
    observeConfiguredCancellation({
      ...f,
      rawSchedule: { ...f.rawSchedule, end_behavior: "release" },
    }).mode,
  ).toBe("resumed");
  expect(() => observeConfiguredCancellation(f)).toThrow();
});
for (const change of [
  "schedule",
  "phase_price",
  "subscription_price",
  "period",
  "expired",
  "cancel_at",
  "restored_downgrade",
] as const)
  test(`configured cancellation rejects ${change} drift`, () => {
    const f = fixture();
    if (change === "schedule") f.rawSubscription.schedule = "sub_sched_foreign";
    if (change === "phase_price") f.rawSchedule.phases[0]!.items[0]!.price = "price_foreign";
    if (change === "subscription_price")
      f.rawSubscription.items.data[0]!.price.id = "price_foreign";
    if (change === "period") f.source.current_period_end = new Date(201000);
    if (change === "expired") f.observedAt = new Date(200000);
    if (change === "cancel_at") Object.assign(f.rawSubscription, { cancel_at: 200 });
    if (change === "restored_downgrade") f.authority.originalPending = false;
    expect(() => observeConfiguredCancellation(f)).toThrow();
  });
