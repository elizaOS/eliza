import { createSubscriptionInvoiceEventEvidence as retain } from "../subscription-invoice-event-evidence";
import { invoiceEventFixture } from "./subscription-invoice-event-fixture";

export function originalDebtInvoice(
  name: string,
  start: number,
  total: number,
  time: number,
  collecting = false,
) {
  const f = invoiceEventFixture();
  const scope = {
    ...f.scope,
    invoiceId: `in_${name}`,
    providerEventId: `evt_${name}`,
    providerSubscriptionId: `sub_${name}`,
  };
  const invoice = {
    ...f.invoice,
    id: scope.invoiceId,
    subscription: scope.providerSubscriptionId,
    starting_balance: start,
    ending_balance: collecting ? 0 : start + total,
    total,
    subtotal: total,
    amount_due: collecting ? start + total : 0,
    amount_paid: collecting ? start + total : 0,
    payment_intent: collecting ? "pi_collect" : null,
    charge: collecting ? "ch_collect" : null,
    status_transitions: { paid_at: time },
    lines: {
      ...f.invoice.lines,
      data: [
        {
          ...f.invoice.lines.data[0]!,
          id: `il_${name}`,
          subscription: scope.providerSubscriptionId,
          subscription_item: `si_${name}`,
          amount: total,
          period: { start: time - 1, end: time + 100 },
        },
      ],
    },
  };
  return retain(
    { ...f.event, id: scope.providerEventId, created: time, data: { object: invoice } },
    scope,
  );
}
export function invoiceDebtFixture() {
  const a = originalDebtInvoice("a", 0, 20, 10),
    b = originalDebtInvoice("b", 20, 20, 20),
    collector = originalDebtInvoice("c", 40, 100, 30, true);
  const row = {
    object: "customer_balance_transaction",
    customer: "cus_owner",
    livemode: false,
    currency: "usd",
    credit_note: null as string | null,
  };
  return {
    collector,
    originals: [a, b],
    history: {
      object: "list",
      has_more: false,
      data: [
        {
          ...row,
          id: "cbtxn_capply",
          invoice: "in_c",
          amount: -40,
          ending_balance: 0,
          created: 30,
          type: "applied_to_invoice",
        },
        {
          ...row,
          id: "cbtxn_bdefer",
          invoice: "in_b",
          amount: 40,
          ending_balance: 40,
          created: 20,
          type: "invoice_too_small",
        },
        {
          ...row,
          id: "cbtxn_bapply",
          invoice: "in_b",
          amount: -20,
          ending_balance: 0,
          created: 20,
          type: "applied_to_invoice",
        },
        {
          ...row,
          id: "cbtxn_adefer",
          invoice: "in_a",
          amount: 20,
          ending_balance: 20,
          created: 10,
          type: "invoice_too_small",
        },
      ],
    },
  };
}
