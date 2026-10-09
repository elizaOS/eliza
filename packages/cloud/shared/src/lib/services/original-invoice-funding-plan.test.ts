/** Pure calculation fixtures; authenticated receipt selection and provider transport have their own integration suites. */

import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { ElizaError } from "@elizaos/core";
import { traceOriginalInvoiceDebt } from "./original-invoice-debt-trace";
import { planOriginalInvoiceFunding as plan } from "./original-invoice-funding-plan";
import { settlementDigest } from "./settlement-digest";
import { validateInvoiceCapture } from "./stripe-invoice-capture";
import { invoiceBalanceHistorySchema } from "./stripe-invoice-settlement";
import { resolveSubscriptionPlanDefinition } from "./subscription-catalog";
import { createSubscriptionInvoiceEventEvidence as retain } from "./subscription-invoice-event-evidence";
import { invoiceDebtFixture } from "./test-support/invoice-debt-fixture";

type Input = Parameters<typeof plan>[0];
function signed<T extends object>(value: T) {
  return { ...value, digest: settlementDigest(value) };
}
function rehash(value: { digest: string }) {
  const { digest: _, ...body } = value;
  value.digest = settlementDigest(body);
}
function fixture(
  options: { zeroCollector?: boolean; duplicatePeriod?: boolean | "provider" } = {},
): Input {
  const sharedSource = randomUUID();
  const raw = invoiceDebtFixture();
  const all = [...raw.originals, raw.collector].map((original, index) => {
    const event = structuredClone(original.event),
      invoice = event.data.object;
    const definition = resolveSubscriptionPlanDefinition(
      index === 2 ? "pro_monthly" : "plus_monthly",
      "v1",
    );
    if (options.zeroCollector && index === 2) {
      invoice.total = 0;
      invoice.amount_due = invoice.starting_balance;
      invoice.amount_paid = invoice.amount_due;
    }
    let scope = { ...original.scope, subscriptionId: randomUUID() };
    if (options.duplicatePeriod) {
      scope = {
        ...scope,
        ...(options.duplicatePeriod === true ? { subscriptionId: sharedSource } : {}),
        providerSubscriptionId: "sub_same",
      };
      invoice.subscription = "sub_same";
      invoice.lines.data[0]!.subscription = "sub_same";
      invoice.lines.data[0]!.subscription_item = "si_same";
      invoice.lines.data[0]!.period = { start: 9, end: 110 };
    }
    const discount = { discount: `di_${index}`, amount: definition.amountCents - invoice.total };
    invoice.subtotal = definition.amountCents;
    invoice.discount = discount.discount;
    invoice.discounts = [discount.discount];
    invoice.total_discount_amounts = [discount];
    invoice.lines.data[0]!.amount = definition.amountCents;
    invoice.lines.data[0]!.discount_amounts = [discount];
    return retain(event, scope);
  });
  const collector = all[2]!,
    originals = all.slice(0, 2),
    scope = collector.scope;
  const common = {
    organizationId: scope.organizationId,
    subscriptionId: scope.subscriptionId,
    providerAccountId: scope.providerAccountId,
    customerId: scope.customerId,
    invoiceId: scope.invoiceId,
    livemode: scope.livemode,
    currency: "usd" as const,
    originalEvidenceDigest: collector.digest,
  };
  const balance = signed({
    kind: "retained_invoice_balance_observation" as const,
    version: 1 as const,
    ...common,
    invoice: structuredClone(collector.event.data.object),
    history: invoiceBalanceHistorySchema.parse(raw.history),
  });
  const owner = {
    customer: scope.customerId,
    invoice: scope.invoiceId,
    livemode: false,
    currency: "usd",
    application: null,
    application_fee_amount: null,
    on_behalf_of: null,
    transfer_data: null,
  };
  const verified = validateInvoiceCapture({
    invoice: collector.event.data.object,
    paymentIntent: {
      ...owner,
      id: "pi_collect",
      object: "payment_intent",
      status: "succeeded",
      latest_charge: "ch_collect",
      amount: collector.event.data.object.amount_due,
      amount_received: collector.event.data.object.amount_due,
      amount_capturable: 0,
    },
    charge: {
      ...owner,
      id: "ch_collect",
      object: "charge",
      status: "succeeded",
      payment_intent: "pi_collect",
      amount: collector.event.data.object.amount_due,
      amount_captured: collector.event.data.object.amount_due,
      amount_refunded: 0,
      captured: true,
      paid: true,
      refunded: false,
      disputed: false,
      refunds: { has_more: false, data: [] },
      application_fee: null,
    },
  });
  const capture = signed({
    kind: "retained_collecting_invoice_capture" as const,
    version: 1 as const,
    ...common,
    balance,
    ...verified,
  });
  const trace = traceOriginalInvoiceDebt({ collector, originals, history: balance.history });
  const observation = signed({
    kind: "observed_original_invoice_debt" as const,
    version: 1 as const,
    ...common,
    collectorOriginalEvidenceDigest: collector.digest,
    capture,
    trace,
    originals: trace.components.map((component) => ({
      invoiceId: component.invoiceId,
      originalEvidenceDigests: component.originalEvidenceDigests,
      invoice: structuredClone(
        originals.find((original) => original.scope.invoiceId === component.invoiceId)!.event.data
          .object,
      ),
    })),
  });
  const selections = all.map((original, index) => {
    const definition = resolveSubscriptionPlanDefinition(
      index === 2 ? "pro_monthly" : "plus_monthly",
      "v1",
    );
    const line = original.event.data.object.lines.data[0]!;
    const terms = {
      planKey: definition.key,
      catalogVersion: definition.catalogVersion,
      priceId: line.price.id,
      productId: line.price.product,
      currency: definition.currency,
      baseAmountCents: definition.amountCents,
      allowanceAmountUsd: definition.allowance.amountUsd,
      subscriptionItemId: line.subscription_item,
      periodStart: line.period.start,
      periodEnd: line.period.end,
    };
    const origin = signed({
      kind: "original_invoice_commercial_origin" as const,
      version: 1 as const,
      originalEvidenceDigest: original.digest,
      scope: structuredClone(original.scope),
      commandId: randomUUID(),
      originKind: "checkout" as const,
      checkoutContractDigest: "a".repeat(64),
      originDigest: "b".repeat(64),
      effectiveAt: 0,
      ...terms,
    });
    return signed({
      kind: "original_invoice_commercial_selection" as const,
      version: 1 as const,
      organizationId: original.scope.organizationId,
      receiptId: randomUUID(),
      originalEvidenceDigest: original.digest,
      scope: structuredClone(original.scope),
      fence: null,
      terms,
      origins: [origin],
    });
  });
  return { collector, originals, observation, selections };
}

test("conserves full collection once across original intervals and retains their own catalog allowances", () => {
  const input = fixture(),
    before = JSON.stringify(input),
    result = plan(input);
  expect(result.collectedAmountCents).toBe(140);
  expect(
    result.allocations.map((row) => [
      row.invoiceId,
      row.role,
      row.collectedAmountCents,
      row.allowanceAmountUsd,
      row.expiresAt,
    ]),
  ).toEqual([
    ["in_a", "deferred", 20, "25.000000", 110],
    ["in_b", "deferred", 20, "25.000000", 120],
    ["in_c", "collector", 100, "90.000000", 130],
  ]);
  expect(result.allocations.every((row) => row.expiresAt === row.periodEnd)).toBe(true);
  expect(JSON.stringify(input)).toBe(before);
  expect(
    plan({
      ...input,
      selections: [...input.selections].reverse(),
      originals: [...input.originals].reverse(),
    }),
  ).toEqual(result);
  expect(JSON.stringify(result)).not.toContain("subscriptionRevision");
  expect(result.policyVersion).toBe("full_original_recurring_allowance_v1");
});

test("does not retain mutable caller-owned objects", () => {
  const input = fixture(),
    result = plan(input),
    before = JSON.stringify(result);
  input.selections[0]!.terms.periodEnd = 999;
  input.observation.trace.components[0]!.amount = 999;
  expect(JSON.stringify(result)).toBe(before);
});

const faults: Array<[string, (input: Input) => void]> = [
  [
    "missing selection",
    (input) => {
      input.selections = input.selections.slice(1);
    },
  ],
  [
    "extra selection",
    (input) => {
      input.selections = [...input.selections, input.selections[0]!];
    },
  ],
  [
    "duplicate invoice selection",
    (input) => {
      input.selections = [input.selections[0]!, input.selections[0]!, input.selections[2]!];
    },
  ],
  [
    "duplicate receipt",
    (input) => {
      input.selections[1]!.receiptId = input.selections[0]!.receiptId;
      rehash(input.selections[1]!);
    },
  ],
  [
    "selection digest",
    (input) => {
      input.selections[0]!.digest = "a".repeat(64);
    },
  ],
  [
    "observation digest",
    (input) => {
      input.observation.digest = "a".repeat(64);
    },
  ],
  [
    "capture digest",
    (input) => {
      input.observation.capture.digest = "a".repeat(64);
      rehash(input.observation);
    },
  ],
  [
    "balance digest",
    (input) => {
      input.observation.capture.balance.digest = "a".repeat(64);
      rehash(input.observation.capture);
      rehash(input.observation);
    },
  ],
  [
    "foreign organization",
    (input) => {
      input.selections[0]!.organizationId = randomUUID();
      rehash(input.selections[0]!);
    },
  ],
  [
    "foreign original",
    (input) => {
      input.selections[0]!.originalEvidenceDigest = input.collector.digest;
      rehash(input.selections[0]!);
    },
  ],
  [
    "wrong price",
    (input) => {
      input.selections[0]!.terms.priceId = "price_other";
      rehash(input.selections[0]!);
    },
  ],
  [
    "wrong allowance",
    (input) => {
      input.selections[0]!.terms.allowanceAmountUsd = "90.000000";
      rehash(input.selections[0]!);
    },
  ],
  [
    "extended original interval",
    (input) => {
      input.selections[0]!.terms.periodEnd += 1;
      rehash(input.selections[0]!);
    },
  ],
  [
    "absent commercial origins",
    (input) => {
      input.selections[0]!.origins = [];
      rehash(input.selections[0]!);
    },
  ],
  [
    "conflicting commercial origin",
    (input) => {
      const s = input.selections[0]!;
      s.origins[0]!.allowanceAmountUsd = "90.000000";
      rehash(s.origins[0]!);
      rehash(s);
    },
  ],
  [
    "origin digest",
    (input) => {
      const s = input.selections[0]!;
      s.origins[0]!.digest = "a".repeat(64);
      rehash(s);
    },
  ],
  [
    "missing current original",
    (input) => {
      input.observation.originals.pop();
      rehash(input.observation);
    },
  ],
  [
    "duplicate current original",
    (input) => {
      input.observation.originals[1] = input.observation.originals[0]!;
      rehash(input.observation);
    },
  ],
  [
    "changed current original",
    (input) => {
      input.observation.originals[0]!.invoice.total++;
      rehash(input.observation);
    },
  ],
  [
    "double-counted carry",
    (input) => {
      input.observation.trace.components[1]!.amount += 20;
      rehash(input.observation.trace);
      rehash(input.observation);
    },
  ],
  [
    "partial capture",
    (input) => {
      input.observation.capture.payment.amount_received--;
      rehash(input.observation.capture);
      rehash(input.observation);
    },
  ],
  [
    "already refunded capture",
    (input) => {
      Object.assign(input.observation.capture.charge, { amount_refunded: 1 });
      rehash(input.observation.capture);
      rehash(input.observation);
    },
  ],
];
for (const [name, mutate] of faults)
  test(`rejects ${name}`, () => {
    const input = fixture();
    mutate(input);
    expect(() => plan(input)).toThrow();
  });

test("a fully discounted collector receives no allocated cash but retains its original catalog interval", () => {
  const result = plan(fixture({ zeroCollector: true }));
  expect(result.collectedAmountCents).toBe(40);
  expect(result.allocations.find((row) => row.role === "collector")).toMatchObject({
    collectedAmountCents: 0,
    allowanceAmountUsd: "90.000000",
    expiresAt: 130,
  });
});
test("different invoice IDs cannot fund the same subscription interval twice", () => {
  expect(() => plan(fixture({ duplicatePeriod: true }))).toThrow(
    "Original invoice funding allocation is unavailable",
  );
});
test("distinct local subscription ids cannot fund one provider interval twice", () => {
  let reason = "";
  try {
    plan(fixture({ duplicatePeriod: "provider" }));
  } catch (error) {
    reason =
      error instanceof ElizaError &&
      typeof error.context === "object" &&
      error.context !== null &&
      "reason" in error.context
        ? String(error.context.reason)
        : "";
  }
  expect(reason).toBe("subscription_identity_conflict");
});
for (const level of ["capture", "balance"] as const)
  for (const field of [
    "organizationId",
    "subscriptionId",
    "providerAccountId",
    "customerId",
    "invoiceId",
    "livemode",
    "currency",
    "originalEvidenceDigest",
  ] as const)
    test(`rejects a rehashed ${level} with foreign ${field}`, () => {
      const input = fixture();
      const row =
        level === "capture" ? input.observation.capture : input.observation.capture.balance;
      Object.assign(row, { [field]: field === "livemode" ? !row.livemode : "foreign" });
      rehash(input.observation.capture.balance);
      rehash(input.observation.capture);
      rehash(input.observation);
      expect(() => plan(input)).toThrow("Original invoice funding allocation is unavailable");
    });
test("duplicate and future commercial origins cannot extend original applicability", () => {
  const duplicate = fixture(),
    selection = duplicate.selections[0]!;
  selection.origins.push(structuredClone(selection.origins[0]!));
  rehash(selection);
  expect(() => plan(duplicate)).toThrow();
  const future = fixture(),
    other = future.selections[0]!;
  other.origins[0]!.effectiveAt = other.terms.periodEnd;
  rehash(other.origins[0]!);
  rehash(other);
  expect(() => plan(future)).toThrow();
});

for (const level of ["observation", "capture", "balance"] as const)
  test(`rejects unsupported ${level} versions even with recomputed digests`, () => {
    const input = fixture();
    const row =
      level === "observation"
        ? input.observation
        : level === "capture"
          ? input.observation.capture
          : input.observation.capture.balance;
    Object.assign(row, { version: 2 });
    rehash(input.observation.capture.balance);
    rehash(input.observation.capture);
    rehash(input.observation);
    expect(() => plan(input)).toThrow();
  });
test("a repeated collecting event cannot replace the original collector receipt", () => {
  const input = fixture();
  const repeated = retain(
    { ...input.collector.event, id: "evt_repeat" },
    { ...input.collector.scope, providerEventId: "evt_repeat" },
  );
  input.originals = [...input.originals, repeated];
  const selected = input.selections.find(
    (row) => row.scope.invoiceId === input.collector.scope.invoiceId,
  )!;
  selected.originalEvidenceDigest = repeated.digest;
  selected.scope = structuredClone(repeated.scope);
  selected.origins[0]!.originalEvidenceDigest = repeated.digest;
  selected.origins[0]!.scope = structuredClone(repeated.scope);
  rehash(selected.origins[0]!);
  rehash(selected);
  expect(() => plan(input)).toThrow();
});
