import { expect, test } from "bun:test";
import { projectUpgradeAllowanceAdjustment as project } from "./organization-upgrade-allowance-posting";

const now = new Date("2026-10-04T20:00:00Z");
function period() {
  return {
    granted_amount: "25.000000",
    adjustment_amount: "0.000000",
    available_amount: "12.000000",
    reserved_amount: "5.000000",
    settled_amount: "8.000000",
    expired_amount: "0.000000",
    clawed_back_amount: "0.000000",
    state: "open" as "open" | "expired" | "closed" | "clawed_back",
    expires_at: new Date(now.getTime() + 1000),
  };
}
test("mid-period increment preserves reserved/settled/base grant", () => {
  const p = period(),
    r = project(p, "32.500000", now);
  expect(r.periodChanges).toMatchObject({
    adjustment_amount: "32.500000",
    available_amount: "44.500000",
    reserved_amount: "5.000000",
    settled_amount: "8.000000",
  });
  expect(r.periodChanges).not.toHaveProperty("granted_amount");
  expect(r.entries).toHaveLength(1);
});
test("expired posting retires old balance and new credit without reviving spending", () => {
  const p = period();
  p.expires_at = now;
  const r = project(p, "32.500000", now);
  expect(r.periodChanges).toMatchObject({
    state: "expired",
    available_amount: "0.000000",
    reserved_amount: "5.000000",
    settled_amount: "8.000000",
    expired_amount: "44.500000",
    adjustment_amount: "32.500000",
  });
  expect(r.entries.map((x) => [x.kind, x.amount, x.reason])).toEqual([
    ["expire", "12.000000", "period_ended"],
    ["grant_adjustment", "32.500000", "upgrade"],
    ["expire", "32.500000", "late_upgrade"],
  ]);
});
test("zero increment never invents an adjustment journal", () => {
  const r = project(period(), "0.000000", now);
  expect(r.entries).toHaveLength(0);
  expect(r.periodChanges.available_amount).toBe("12.000000");
});
test("zero late increment still expires old spending balance", () => {
  const p = period();
  p.expires_at = now;
  const r = project(p, "0.000000", now);
  expect(r.entries).toHaveLength(1);
  expect(r.entries[0]!.kind).toBe("expire");
  expect(r.periodChanges.available_amount).toBe("0.000000");
});
test("existing expired and closed buckets remain closed to spending", () => {
  for (const state of ["expired", "closed"] as const) {
    const p = period();
    Object.assign(p, {
      state,
      available_amount: "0.000000",
      reserved_amount: "0.000000",
      expired_amount: "17.000000",
    });
    const r = project(p, "1.000000", now);
    expect(r.periodChanges.state).toBe(state);
    expect(r.periodChanges.available_amount).toBe("0.000000");
    expect(r.periodChanges.expired_amount).toBe("18.000000");
  }
});
test("previous adjustments are retained with exact micro-unit accounting", () => {
  const p = period();
  p.adjustment_amount = "0.000001";
  p.available_amount = "12.000001";
  const r = project(p, "0.000001", now);
  expect(r.periodChanges.adjustment_amount).toBe("0.000002");
  expect(r.periodChanges.available_amount).toBe("12.000002");
});
test("unconserved or invalid terminal input is rejected", () => {
  const p = period();
  p.available_amount = "11.000000";
  expect(() => project(p, "1.000000", now)).toThrow();
  const closed = period();
  closed.state = "closed";
  expect(() => project(closed, "1.000000", now)).toThrow();
});
test("invalid time and overflow cannot produce a posting", () => {
  expect(() => project(period(), "1.000000", new Date(NaN))).toThrow();
  expect(() => project(period(), "9999999999.999999", now)).toThrow();
});
