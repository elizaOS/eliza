import assert from "node:assert/strict";
import test from "node:test";
import { projectSubscriptionManagement } from "./cloud-services.mjs";

const now = Date.now(),
  id = "11111111-1111-4111-8111-111111111111";
function snapshot(undo = false) {
  return {
    success: true,
    data: {
      v2: {
        snapshotCompletedAt: new Date(now).toISOString(),
        subscription: {
          status: "available",
          value: {
            subscriptionId: id,
            planKey: "plus_monthly",
            state: "active",
            currentPeriodEnd: new Date(now + 86400000).toISOString(),
            cancelAtPeriodEnd: undo,
            pendingPlanKey: null,
            dunningStartedAt: null,
            graceExpiresAt: null,
            cancellationControl: {
              action: undo ? "undo" : "cancel",
              method: "POST",
              endpoint: "/api/v1/subscriptions/cancel" + (undo ? "/undo" : ""),
              subscriptionId: id,
              expectedSubscriptionRevision: 3,
              eligible: true,
              blockers: [],
            },
            privateProviderValue: "hidden",
          },
        },
      },
    },
  };
}
const project = (x) =>
  projectSubscriptionManagement(x, ["plus_monthly", "pro_monthly"], now);
test("management projects server action, revision and date without private provider data", () => {
  for (const undo of [false, true]) {
    const result = project(snapshot(undo));
    assert.equal(result.control.action, undo ? "undo" : "cancel");
    assert.equal(result.control.revision, 3);
    assert.equal(result.subscription.id, id);
    assert.equal(result.control.eligible, true);
    assert.ok(!JSON.stringify(result).includes("hidden"));
    assert.equal(Date.parse(result.expiresAt), now + 60000);
  }
  const value = snapshot();
  value.data.v2.subscription.value.cancellationControl.eligible = false;
  value.data.v2.subscription.value.cancellationControl.blockers = [
    "interactive_session_required",
  ];
  assert.equal(project(value).control.eligible, false);
});
test("management rejects stale, inconsistent and malformed server controls", () => {
  for (const mutate of [
    (v) => (v.success = false),
    (v) =>
      (v.data.v2.snapshotCompletedAt = new Date(now - 60001).toISOString()),
    (v) =>
      (v.data.v2.snapshotCompletedAt = new Date(now + 300001).toISOString()),
    (v) =>
      (v.data.v2.subscription.value.cancellationControl.subscriptionId =
        "other"),
    (v) => (v.data.v2.subscription.value.cancellationControl.action = "undo"),
    (v) =>
      (v.data.v2.subscription.value.cancellationControl.endpoint =
        "/arbitrary"),
    (v) =>
      (v.data.v2.subscription.value.cancellationControl.expectedSubscriptionRevision = 0),
    (v) =>
      (v.data.v2.subscription.value.cancellationControl.expectedSubscriptionRevision = 1.5),
    (v) =>
      (v.data.v2.subscription.value.cancellationControl.blockers = ["unknown"]),
    (v) => (v.data.v2.subscription.value.cancellationControl.eligible = false),
    (v) =>
      (v.data.v2.subscription.value.currentPeriodEnd = new Date(
        now - 1,
      ).toISOString()),
    (v) => (v.data.v2.subscription.value.pendingPlanKey = "pro_monthly"),
    (v) => (v.data.v2.subscription.value.state = "past_due"),
  ]) {
    const value = snapshot();
    mutate(value);
    assert.throws(() => project(value), /unavailable/);
  }
  const absent = snapshot();
  absent.data.v2.subscription = {
    status: "not_applicable",
    reason: "no_organization_subscription",
  };
  assert.equal(project(absent).status, "not_applicable");
  absent.data.v2.subscription = { status: "unavailable" };
  assert.throws(() => project(absent), /unavailable/);
});

test("pending plan is read-only presentation and cannot invent cancellation eligibility", () => {
  const value = snapshot(),
    sub = value.data.v2.subscription.value;
  sub.pendingPlanKey = "pro_monthly";
  sub.cancellationControl.eligible = false;
  sub.cancellationControl.blockers = ["subscription_state_unsupported"];
  const result = project(value);
  assert.equal(result.subscription.pendingPlanKey, "pro_monthly");
  assert.equal(result.subscription.planKey, "plus_monthly");
  assert.equal(result.control.eligible, false);
  assert.deepEqual(result.control.blockers, ["subscription_state_unsupported"]);
  for (const invalid of [undefined, "unknown", "plus_monthly", 7]) {
    sub.pendingPlanKey = invalid;
    assert.throws(() => project(value), /unavailable/);
  }
  assert.equal(project(snapshot()).subscription.pendingPlanKey, null);
});
