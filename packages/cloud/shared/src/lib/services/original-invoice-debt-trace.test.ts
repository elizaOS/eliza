import { expect, test } from "bun:test";
import { traceOriginalInvoiceDebt as trace } from "./original-invoice-debt-trace";
import {
  createSubscriptionInvoiceEventEvidence as retain,
  type SubscriptionInvoiceEventEvidence,
} from "./subscription-invoice-event-evidence";
import {
  invoiceDebtFixture as fixture,
  originalDebtInvoice as original,
} from "./test-support/invoice-debt-fixture";

function revise(
  value: SubscriptionInvoiceEventEvidence,
  edit: (invoice: SubscriptionInvoiceEventEvidence["event"]["data"]["object"]) => void,
) {
  const event = structuredClone(value.event);
  edit(event.data.object);
  return retain(event, value.scope);
}
function rejects(f: ReturnType<typeof fixture>) {
  expect(() => trace(f)).toThrow();
}
test("traces repeated carry-forward without counting the carried balance as new debt", () => {
  const f = fixture();
  const before = JSON.stringify(f);
  const result = trace(f);
  expect(result.components.map(({ invoiceId, amount }) => ({ invoiceId, amount }))).toEqual([
    { invoiceId: "in_a", amount: 20 },
    { invoiceId: "in_b", amount: 20 },
  ]);
  expect(result.carriedDebit).toBe(40);
  expect(result.collectorInvoiceTotal).toBe(100);
  expect(result.expectedAmountDue).toBe(140);
  expect(result.transfers.map((t) => t.applicationId)).toEqual(["cbtxn_bapply", "cbtxn_capply"]);
  expect(result.components[0]!.period).toEqual({ start: 9, end: 110 });
  expect(JSON.stringify(f)).toBe(before);
  expect(trace(f)).toEqual(result);
});
test("keeps original subscription ownership across customer-scoped carry-forward", () => {
  const f = fixture(),
    b = f.originals[1]!;
  f.originals[1] = retain(b.event, {
    ...b.scope,
    subscriptionId: "33333333-3333-4333-8333-333333333333",
  });
  const result = trace(f);
  expect(result.components.map((c) => c.subscriptionId)).toEqual([
    f.originals[0]!.scope.subscriptionId,
    f.originals[1]!.scope.subscriptionId,
  ]);
  expect(result.components.map((c) => c.providerSubscriptionId)).toEqual(["sub_a", "sub_b"]);
});
test("identical repeated events preserve provenance without duplicate debt", () => {
  const f = fixture(),
    a = f.originals[0]!;
  const repeated = retain(
    { ...a.event, id: "evt_arepeated" },
    { ...a.scope, providerEventId: "evt_arepeated" },
  );
  f.originals.push(repeated, a);
  const result = trace(f);
  expect(result.components).toHaveLength(2);
  expect(result.components[0]!.originalEvidenceDigests).toEqual([a.digest, repeated.digest].sort());
  expect(result.carriedDebit).toBe(40);
});
test("one deferred original and too-large carry use the same conservation rules", () => {
  const f = fixture();
  f.collector = original("c", 20, 100, 30, true);
  f.history.data = [
    { ...f.history.data[0]!, amount: -20 },
    { ...f.history.data[3]!, type: "invoice_too_large" },
  ];
  expect(trace(f).components).toHaveLength(1);
  expect(trace(f).expectedAmountDue).toBe(120);
});
for (const fault of [
  "missing original",
  "conflicting repeated event",
  "wrong tenant",
  "wrong merchant",
  "wrong customer",
  "wrong mode",
  "partial history",
  "duplicate movement",
  "currency",
  "chronology",
  "discontinuity",
  "manual credit",
  "credit note",
  "reversed application",
  "wrong collector amount",
  "original debt amount",
  "original paid debt",
  "original payment",
  "credit-adjusted original",
  "wrong line arithmetic",
  "cycle",
  "future posting",
] as const) {
  test(`rejects ${fault} rather than returning an allocation`, () => {
    const f = fixture();
    const a = f.originals[0]!;
    switch (fault) {
      case "missing original":
        f.originals.shift();
        break;
      case "conflicting repeated event":
        f.originals.push(
          revise(a, (i) => {
            i.lines.data[0]!.period.end++;
          }),
        );
        break;
      case "wrong tenant":
        f.originals[0] = retain(a.event, {
          ...a.scope,
          organizationId: "33333333-3333-4333-8333-333333333333",
        });
        break;
      case "wrong merchant":
        f.originals[0] = retain(a.event, { ...a.scope, providerAccountId: "acct_other" });
        break;
      case "wrong customer":
        f.history.data[3]!.customer = "cus_other";
        break;
      case "wrong mode":
        f.history.data[3]!.livemode = true;
        break;
      case "partial history":
        f.history.has_more = true;
        break;
      case "duplicate movement":
        f.history.data[3]!.id = f.history.data[2]!.id;
        break;
      case "currency":
        f.history.data[3]!.currency = "eur";
        break;
      case "chronology":
        f.history.data[3]!.created = 21;
        break;
      case "discontinuity":
        f.history.data[3]!.ending_balance++;
        break;
      case "manual credit":
        f.history.data[3]!.type = "adjustment";
        break;
      case "credit note":
        f.history.data[3]!.credit_note = "cn_other";
        break;
      case "reversed application":
        f.history.data.unshift({
          ...f.history.data[0]!,
          id: "cbtxn_reversal",
          type: "unapplied_from_invoice",
          amount: 40,
          ending_balance: 40,
        });
        break;
      case "wrong collector amount":
        f.collector = revise(f.collector, (i) => {
          i.amount_due++;
          i.amount_paid++;
        });
        break;
      case "original debt amount":
        f.originals[0] = revise(a, (i) => {
          i.ending_balance++;
        });
        break;
      case "original paid debt":
        f.originals[0] = revise(a, (i) => {
          i.amount_paid = 20;
        });
        break;
      case "original payment":
        f.originals[0] = revise(a, (i) => {
          i.payment_intent = "pi_other";
        });
        break;
      case "credit-adjusted original":
        f.originals[0] = revise(a, (i) => {
          i.post_payment_credit_notes_amount = 1;
        });
        break;
      case "wrong line arithmetic":
        f.originals[0] = revise(a, (i) => {
          i.lines.data[0]!.amount++;
        });
        break;
      case "cycle":
        f.history.data[3]!.invoice = "in_c";
        break;
      case "future posting":
        f.originals[0] = revise(a, (i) => {
          i.status_transitions.paid_at = 9;
        });
        break;
    }
    rejects(f);
  });
}
test("later linked debt mutation rejects even when the collecting capture is unchanged", () => {
  const f = fixture();
  f.history.data.unshift({
    ...f.history.data[3]!,
    id: "cbtxn_later",
    type: "credit_note",
    amount: -20,
    ending_balance: -20,
    created: 31,
    credit_note: "cn_later",
  });
  rejects(f);
});
test("unsafe integer amounts and truncated roots cannot establish provenance", () => {
  const f = fixture();
  f.history.data[3]!.amount = Number.MAX_SAFE_INTEGER + 1;
  rejects(f);
  const partial = fixture();
  partial.history.data.pop();
  rejects(partial);
});

test("a long carry chain conserves each original contribution without recursion or fresh periods", () => {
  const f = fixture();
  f.originals = [];
  f.history.data = [];
  const template = fixture().history.data[3]!;
  for (let i = 0; i < 200; i++) {
    const name = `debt${i}`,
      time = i + 1;
    f.originals.push(original(name, i, 1, time));
    if (i > 0)
      f.history.data.unshift({
        ...template,
        id: `cbtxn_apply${i}`,
        invoice: `in_${name}`,
        amount: -i,
        ending_balance: 0,
        created: time,
        type: "applied_to_invoice",
      });
    f.history.data.unshift({
      ...template,
      id: `cbtxn_defer${i}`,
      invoice: `in_${name}`,
      amount: i + 1,
      ending_balance: i + 1,
      created: time,
    });
  }
  f.collector = original("c", 200, 100, 300, true);
  f.history.data.unshift({
    ...template,
    id: "cbtxn_capply",
    invoice: "in_c",
    amount: -200,
    ending_balance: 0,
    created: 300,
    type: "applied_to_invoice",
  });
  const result = trace(f);
  expect(result.components).toHaveLength(200);
  expect(result.components.reduce((sum, c) => sum + c.amount, 0)).toBe(200);
  expect(result.expectedAmountDue).toBe(300);
  expect(result.components[0]!.period).toEqual({ start: 0, end: 101 });
  expect(result.components.at(-1)!.period).toEqual({ start: 199, end: 300 });
});
test("documented invoice discounts are reconciled before using net new debt", () => {
  const f = fixture();
  f.originals[0] = revise(f.originals[0]!, (invoice) => {
    invoice.lines.data[0]!.amount = 30;
    invoice.subtotal = 30;
    invoice.discounts = ["di_original"];
    invoice.total_discount_amounts = [{ discount: "di_original", amount: 10 }];
    invoice.lines.data[0]!.discount_amounts = [{ discount: "di_original", amount: 10 }];
  });
  expect(trace(f).components[0]!.amount).toBe(20);
});
test("latest unrelated activity cannot change original traced periods or contributions", () => {
  const f = fixture();
  f.history.data.unshift({
    ...f.history.data[3]!,
    id: "cbtxn_later",
    invoice: "in_unrelated",
    amount: 5,
    ending_balance: 5,
    created: 31,
  });
  expect(trace(f).components.map((c) => c.amount)).toEqual([20, 20]);
});
