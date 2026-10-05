import { expect, test } from "bun:test";
import { configurationProofTestInput } from "./organization-schedule-configuration-test-fixture";
import { proveRetainedScheduleTargetLifecycle as prove } from "./organization-schedule-target-lifecycle";
import { settlementDigest } from "./settlement-digest";

function fixture(status: "released" | "completed" = "released") {
  const original = configurationProofTestInput().rawCurrentSchedule,
    target = original.phases[1]!;
  return {
    originalSnapshot: original,
    originalSnapshotDigest: settlementDigest(original),
    scheduleId: original.id,
    customerId: original.customer,
    subscriptionId: original.subscription,
    livemode: original.livemode,
    targetPriceId: "price_plus",
    effectiveAt: target.start_date,
    observedAt: new Date((target.end_date + 10) * 1000),
    rawCurrentSchedule: {
      ...structuredClone(original),
      status: String(status),
      current_phase: null,
      subscription: status === "released" ? null : original.subscription,
      released_subscription: status === "released" ? original.subscription : null,
      released_at: status === "released" ? target.start_date + 10 : null,
      completed_at: status === "completed" ? target.end_date : null,
    },
  };
}
for (const state of ["released", "completed"] as const)
  test(`retains original target terms after ${state}`, () => {
    const f = fixture(state),
      before = structuredClone(f),
      proof = prove(f);
    expect(proof.state).toBe(state);
    expect(proof.end.getTime()).toBe(f.originalSnapshot.phases[1]!.end_date * 1000);
    expect(proof.originalSnapshotDigest).toBe(f.originalSnapshotDigest);
    expect(f).toEqual(before);
  });
test("completion can use the retained original identity after its current association is absent", () => {
  const f = fixture("completed");
  f.rawCurrentSchedule.subscription = null;
  expect(prove(f).state).toBe("completed");
});
const changes: Array<[string, (f: ReturnType<typeof fixture>) => void]> = [
  [
    "early release",
    (f) => {
      f.rawCurrentSchedule.released_at = f.effectiveAt - 1;
    },
  ],
  [
    "future release",
    (f) => {
      f.rawCurrentSchedule.released_at = f.observedAt.getTime() / 1000 + 1;
    },
  ],
  [
    "foreign released subscription",
    (f) => {
      f.rawCurrentSchedule.released_subscription = "sub_foreign";
    },
  ],
  [
    "release still attached",
    (f) => {
      f.rawCurrentSchedule.subscription = f.subscriptionId;
    },
  ],
  [
    "missing release timestamp",
    (f) => {
      f.rawCurrentSchedule.released_at = null;
    },
  ],
  [
    "conflicting terminal timestamps",
    (f) => {
      f.rawCurrentSchedule.completed_at = f.effectiveAt;
    },
  ],
  [
    "foreign customer",
    (f) => {
      f.rawCurrentSchedule.customer = "cus_foreign";
    },
  ],
  [
    "foreign schedule",
    (f) => {
      f.rawCurrentSchedule.id = "sub_sched_foreign";
    },
  ],
  [
    "mode drift",
    (f) => {
      f.rawCurrentSchedule.livemode = !f.livemode;
    },
  ],
  [
    "phase drift",
    (f) => {
      f.rawCurrentSchedule.phases[1]!.end_date++;
    },
  ],
  [
    "unknown field drift",
    (f) => {
      Object.assign(f.rawCurrentSchedule, { unknown: true });
    },
  ],
  [
    "canceled schedule",
    (f) => {
      f.rawCurrentSchedule.status = "canceled";
    },
  ],
  [
    "terminal current phase",
    (f) => {
      Object.assign(f.rawCurrentSchedule, {
        current_phase: { start_date: f.effectiveAt, end_date: f.effectiveAt + 1 },
      });
    },
  ],
  [
    "snapshot corruption",
    (f) => {
      f.originalSnapshotDigest = "0".repeat(64);
    },
  ],
];
for (const [name, change] of changes)
  test(`rejects ${name}`, () => {
    const f = fixture();
    change(f);
    expect(() => prove(f)).toThrow();
  });
test("completion cannot predate the original target end", () => {
  const f = fixture("completed");
  f.rawCurrentSchedule.completed_at = f.effectiveAt + 1;
  expect(() => prove(f)).toThrow();
});
test("completion cannot name another subscription", () => {
  const f = fixture("completed");
  f.rawCurrentSchedule.subscription = "sub_foreign";
  expect(() => prove(f)).toThrow();
});
test("terminal SDK transport metadata does not change retained terms", () => {
  const f = fixture();
  Object.assign(f.rawCurrentSchedule, { lastResponse: { requestId: "req_read" } });
  expect(prove(f).state).toBe("released");
});
