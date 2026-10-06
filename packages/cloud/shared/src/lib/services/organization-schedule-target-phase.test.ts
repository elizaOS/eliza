import { expect, test } from "bun:test";
import { configurationProofTestInput } from "./organization-schedule-configuration-test-fixture";
import { proveRetainedScheduleTargetPhase as prove } from "./organization-schedule-target-phase";
import { settlementDigest } from "./settlement-digest";

function fixture() {
  const f = configurationProofTestInput();
  const original = f.rawCurrentSchedule;
  const target = original.phases[1]!;
  return {
    originalSnapshot: original,
    originalSnapshotDigest: settlementDigest(original),
    scheduleId: original.id,
    customerId: original.customer,
    subscriptionId: original.subscription,
    livemode: original.livemode,
    targetPriceId: "price_plus",
    effectiveAt: 200,
    rawCurrentSchedule: {
      ...structuredClone(original),
      current_phase: { start_date: target.start_date, end_date: target.end_date },
    },
    observedAt: new Date(30 * 86400 * 1000 + 150000),
  };
}
test("durable original snapshot proves the active target after event history has aged out", () => {
  const f = fixture();
  expect(f.observedAt.getTime() - 120000).toBeGreaterThan(30 * 86400 * 1000);
  const p = prove(f);
  expect(p.targetPriceId).toBe("price_plus");
  expect(p.start.getTime()).toBe(200000);
  expect(p.end.getTime()).toBe(f.rawCurrentSchedule.phases[1]!.end_date * 1000);
});
for (const [name, change] of [
  [
    "snapshot corruption",
    (f: ReturnType<typeof fixture>) => {
      f.originalSnapshotDigest = "0".repeat(64);
    },
  ],
  [
    "foreign current customer",
    (f: ReturnType<typeof fixture>) => {
      f.rawCurrentSchedule.customer = "cus_other";
    },
  ],
  [
    "foreign reviewed price",
    (f: ReturnType<typeof fixture>) => {
      f.targetPriceId = "price_other";
    },
  ],
  [
    "target phase end drift",
    (f: ReturnType<typeof fixture>) => {
      f.rawCurrentSchedule.phases[1]!.end_date += 1;
    },
  ],
  [
    "before target boundary",
    (f: ReturnType<typeof fixture>) => {
      f.observedAt = new Date(199999);
    },
  ],
  [
    "at target end",
    (f: ReturnType<typeof fixture>) => {
      f.observedAt = new Date(f.rawCurrentSchedule.phases[1]!.end_date * 1000);
    },
  ],
  [
    "unexpected future phase",
    (f: ReturnType<typeof fixture>) => {
      f.rawCurrentSchedule.phases.push(structuredClone(f.rawCurrentSchedule.phases[1]!));
    },
  ],
  [
    "unknown field drift",
    (f: ReturnType<typeof fixture>) => {
      Object.assign(f.rawCurrentSchedule, { unreviewed: true });
    },
  ],
] as const)
  test(name + " rejects target proof", () => {
    const f = fixture();
    change(f);
    expect(() => prove(f)).toThrow(
      expect.objectContaining({ code: "SUBSCRIPTION_SCHEDULE_TARGET_UNVERIFIED" }),
    );
  });

test("invalid target date range cannot become renewal authority", () => {
  const f = fixture();
  f.originalSnapshot.phases[1]!.end_date = Number.MAX_SAFE_INTEGER;
  f.originalSnapshotDigest = settlementDigest(f.originalSnapshot);
  f.rawCurrentSchedule = structuredClone(f.originalSnapshot);
  f.rawCurrentSchedule.current_phase = { start_date: 200, end_date: Number.MAX_SAFE_INTEGER };
  expect(() => prove(f)).toThrow(
    expect.objectContaining({ code: "SUBSCRIPTION_SCHEDULE_TARGET_UNVERIFIED" }),
  );
});
