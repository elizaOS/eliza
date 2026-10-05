import { expect, test } from "bun:test";
import { assertOrganizationScheduleAttachedTermsCurrent } from "./organization-schedule-attached-terms";
import { originalScheduleTestInput as input } from "./organization-schedule-provider-test-fixture";

test("original attachment is the only ignored subscription difference", () => {
  const f = input();
  expect(assertOrganizationScheduleAttachedTermsCurrent(f).terms).toEqual(f.originalTerms);
  expect(f.rawSubscription.schedule).toBe("sub_sched_owned");
});
test("missing, expanded or foreign schedule pointers cannot normalize away", () => {
  for (const schedule of [null, "sub_sched_foreign", { id: "sub_sched_owned" }]) {
    const f = input();
    expect(() =>
      assertOrganizationScheduleAttachedTermsCurrent({
        ...f,
        rawSubscription: { ...f.rawSubscription, schedule },
      }),
    ).toThrow();
  }
});
test("attachment cannot hide changed subscription or inherited customer terms", () => {
  for (const change of [
    { metadata: { organization: "another" } },
    { default_payment_method: "pm_changed" },
    { billing_cycle_anchor: 99 },
    { discounts: ["di_changed"] },
    { customer: "cus_another" },
    { id: "sub_another" },
    { livemode: true },
    { current_period_end: 201 },
    { schedule: null },
  ]) {
    const f = input();
    expect(() =>
      assertOrganizationScheduleAttachedTermsCurrent({
        ...f,
        rawSubscription: { ...f.rawSubscription, ...change },
      }),
    ).toThrow();
  }
  for (const change of [
    { balance: -100 },
    { discount: { id: "di_changed" } },
    { tax_exempt: "exempt" },
    { invoice_settings: { default_payment_method: "pm_customer" } },
  ]) {
    const f = input();
    expect(() =>
      assertOrganizationScheduleAttachedTermsCurrent({
        ...f,
        rawCustomer: { ...f.rawCustomer, ...change },
      }),
    ).toThrow();
  }
});
