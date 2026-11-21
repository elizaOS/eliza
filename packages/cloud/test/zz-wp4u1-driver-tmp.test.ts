// spec/cloud/billing/subscriptions.md, "Story: Keep my plan as the provider says it is"
import { expect, it } from "vitest";
import { enabled, initial, step, type Event } from "../gen/cloud__billing__subscriptions.ts";
import { driver } from "./drivers/cloud__billing__subscriptions.ts";

const day = 86_400_000;
const events: Event[] = [
  { type: "pinCustomer", customerId: "cus1" },
  { type: "claimCommand", kind: "CheckoutCommand", commandId: "cmd1", expectedRevision: 0 },
  { type: "checkoutPaid", commandId: "cmd1", subscriptionId: "sub1", planKey: "ProMonthly", customerId: "cus1" },
  { type: "reconcile", subscriptionId: "sub1", providerStatus: "ProviderActive", latestInvoice: "PeriodInvoicePaid", invoiceId: "in_1", planKey: "ProMonthly", periodStart: 0, periodEnd: 600000, cancelAtPeriodEnd: false, now: 0 },
  { type: "reconcile", subscriptionId: "sub1", providerStatus: "ProviderActive", latestInvoice: "PeriodInvoicePaid", invoiceId: "in_1", planKey: "ProMonthly", periodStart: 0, periodEnd: 600000, cancelAtPeriodEnd: false, now: 0 },
  { type: "claimCommand", kind: "DowngradeCommand", commandId: "cmd2", expectedRevision: 2 },
  { type: "claimCommand", kind: "CancelCommand", commandId: "cmd1", expectedRevision: 2 },
  { type: "scheduleDowngrade", commandId: "cmd2", planKey: "PlusMonthly" },
  { type: "releaseCommand", commandId: "cmd2" },
  { type: "reconcile", subscriptionId: "sub1", providerStatus: "ProviderActive", latestInvoice: "PeriodInvoicePaid", invoiceId: "in_2", planKey: "PlusMonthly", periodStart: 600000, periodEnd: 1200000, cancelAtPeriodEnd: false, now: 600000 },
  { type: "reconcile", subscriptionId: "sub1", providerStatus: "ProviderPastDue", latestInvoice: "PeriodInvoiceFailed", invoiceId: "", planKey: "PlusMonthly", periodStart: 600000, periodEnd: 1200000, cancelAtPeriodEnd: false, now: 600000 },
  { type: "expireDunning", now: 600000 },
  { type: "expireDunning", now: 600000 + 3 * day },
  { type: "reconcile", subscriptionId: "sub1", providerStatus: "ProviderCanceled", latestInvoice: "PeriodInvoiceOpen", invoiceId: "", planKey: "PlusMonthly", periodStart: 600000, periodEnd: 1200000, cancelAtPeriodEnd: false, now: 600000 + 3 * day },
  { type: "reconcile", subscriptionId: "sub1", providerStatus: "ProviderActive", latestInvoice: "PeriodInvoicePaid", invoiceId: "in_3", planKey: "PlusMonthly", periodStart: 600000, periodEnd: 1200000, cancelAtPeriodEnd: false, now: 600000 + 3 * day },
  { type: "claimCommand", kind: "CheckoutCommand", commandId: "cmd3", expectedRevision: 7 },
  { type: "checkoutPaid", commandId: "cmd3", subscriptionId: "sub2", planKey: "PlusMonthly", customerId: "cus1" },
];

it("drives the subscription shell as the spec steps it", async () => {
  await driver.reset();
  let model = initial;
  const seen: Array<[string, string, string]> = [];
  for (const event of events) {
    const expected = enabled(model, event) ? "accepted" : "refused";
    if (expected === "accepted") model = step(model, event).state;
    const outcome = await driver.dispatch("a", event);
    seen.push([event.type, expected, outcome]);
    expect(await driver.observe("a")).toEqual(model);
  }
  expect(seen.filter(([, expected, outcome]) => expected !== outcome)).toEqual([]);
  await driver[Symbol.asyncDispose]();
}, 60_000);
