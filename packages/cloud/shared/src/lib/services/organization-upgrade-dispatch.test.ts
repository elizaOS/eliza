import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import type { OrganizationUpgradeClaim } from "../../db/repositories/organization-upgrade-execution";

const order: string[] = [];
let failAt = "";
async function step(name: string) {
  order.push(name);
  if (failAt === name) throw new Error(name);
}
const identity = { organizationId: "org", actorId: "actor", commandId: "command" };
const claim = {
  canDispatch: true,
  command: {
    lease_token: "lease",
    execution_generation: 3,
    provider_idempotency_key: "original-key",
  },
} as OrganizationUpgradeClaim;
const captured = {
  source: { stripe_subscription_id: "sub_original", stripe_subscription_item_id: "si_original" },
  review: { targetPlanKey: "pro_monthly", prorationDate: 1700000000 },
  providerBinding: { apiVersion: "2024-11-20.acacia", targetPriceId: "price_target" },
};
const original = { id: "sub_original" };
Object.defineProperty(original, "lastResponse", {
  value: { requestId: "req_original" },
  enumerable: false,
});
const update = mock(async (_id: string, _params: unknown, _options: unknown) => {
  await step("update");
  return original;
});
const record = mock(async (_input: unknown) => {
  await step("receipt");
  return { receipt: { invoice_id: "in_original", subscription_id: "sub_original" } };
});
const invoice = mock(async (_id: string, _params: unknown, _options: unknown) => {
  await step("invoice");
  return { id: "in_original" };
});
const final = mock(async (_input: unknown) => {
  await step("finalize");
  return { replayed: false };
});
mock.module("../../db/repositories/organization-upgrade-execution", () => ({
  readOrganizationUpgradeDispatchSource: async () => {
    await step("source");
    return captured;
  },
  markOrganizationUpgradeDispatch: async () => step("mark"),
}));
mock.module("../../db/repositories/organization-upgrade-invoice-origins", () => ({
  recordOrganizationUpgradeInvoiceOrigin: record,
}));
mock.module("../../db/repositories/organization-upgrade-finalization", () => ({
  finalizePaidOrganizationUpgrade: final,
}));
mock.module("../stripe", () => ({
  requireStripe: () => ({
    subscriptions: {
      update,
      retrieve: async () => {
        await step("subscription");
        return { id: "sub_original" };
      },
    },
    invoices: { retrieve: invoice },
  }),
}));
mock.module("../runtime/cloud-bindings", () => ({ getCloudAwareEnv: () => ({}) }));
mock.module("./organization-upgrade-provider-binding", () => ({
  assertOrganizationUpgradeProviderBindingCurrent: () => {
    order.push("binding");
  },
}));
mock.module("./organization-upgrade-repreview", () => ({
  repreviewOrganizationUpgrade: async () => step("preview"),
}));
const { dispatchOrganizationUpgrade } = await import("./organization-upgrade-dispatch");
beforeEach(() => {
  order.length = 0;
  failAt = "";
  update.mockClear();
  record.mockClear();
  invoice.mockClear();
  final.mockClear();
});
afterAll(() => mock.restore());
const session = async () => step("session");
test("review and durable marker precede one original-key update; original receipt precedes exact invoice retrieval", async () => {
  await dispatchOrganizationUpgrade(identity, claim, session);
  expect(order).toEqual([
    "session",
    "source",
    "preview",
    "session",
    "binding",
    "mark",
    "update",
    "receipt",
    "invoice",
    "subscription",
    "finalize",
  ]);
  expect(update).toHaveBeenCalledTimes(1);
  expect(update.mock.calls[0]).toEqual([
    "sub_original",
    {
      items: [{ id: "si_original", price: "price_target", quantity: 1 }],
      payment_behavior: "pending_if_incomplete",
      proration_behavior: "always_invoice",
      proration_date: 1700000000,
      expand: ["latest_invoice"],
    },
    { apiVersion: "2024-11-20.acacia", idempotencyKey: "original-key", maxNetworkRetries: 0 },
  ]);
  expect(record.mock.calls[0]![0]).toEqual({
    organizationId: "org",
    commandId: "command",
    evidence: { kind: "update_response", raw: original },
  });
  expect(invoice.mock.calls[0]![0]).toBe("in_original");
});
for (const point of ["source", "preview", "mark"])
  test(`${point} failure never sends provider mutation`, async () => {
    failAt = point;
    await expect(dispatchOrganizationUpgrade(identity, claim, session)).rejects.toThrow(point);
    expect(update).not.toHaveBeenCalled();
    expect(final).not.toHaveBeenCalled();
  });
test("session loss after preview never marks or writes", async () => {
  let count = 0;
  await expect(
    dispatchOrganizationUpgrade(identity, claim, async () => {
      if (++count === 2) throw new Error("expired");
    }),
  ).rejects.toThrow("expired");
  expect(order).not.toContain("mark");
  expect(update).not.toHaveBeenCalled();
});
for (const point of ["update", "receipt", "invoice", "subscription", "finalize"])
  test(`${point} failure cannot trigger another update`, async () => {
    failAt = point;
    await expect(dispatchOrganizationUpgrade(identity, claim, session)).rejects.toThrow(point);
    expect(update).toHaveBeenCalledTimes(1);
    expect(order.filter((x) => x === "mark")).toHaveLength(1);
  });
test("a recovered started claim is never a second dispatch", async () => {
  await expect(
    dispatchOrganizationUpgrade(identity, { ...claim, canDispatch: false }, session),
  ).rejects.toThrow();
  expect(order).toEqual([]);
  expect(update).not.toHaveBeenCalled();
});
