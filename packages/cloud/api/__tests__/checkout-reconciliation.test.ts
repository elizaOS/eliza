import { expect, test } from "bun:test";
import type Stripe from "stripe";
import { findCheckoutSessionForOrder } from "../src/checkout-reconciliation";

const order = {
  id: "order-1",
  stripe_customer_id: "cus-1",
  updated_at: new Date("2026-01-01T00:00:00Z"),
};
function client(
  list: (input: Stripe.Checkout.SessionListParams) => Promise<unknown>,
): Stripe {
  return { checkout: { sessions: { list } } } as unknown as Stripe;
}

test("follows complete pages and requires both original order identities", async () => {
  const calls: Stripe.Checkout.SessionListParams[] = [];
  const match = {
    id: "session-2",
    client_reference_id: order.id,
    metadata: { checkout_order_id: order.id },
  };
  const stripe = client(async (input) => {
    calls.push(input);
    return calls.length === 1
      ? {
          data: [
            {
              id: "session-1",
              client_reference_id: order.id,
              metadata: { checkout_order_id: "other" },
            },
          ],
          has_more: true,
        }
      : { data: [match], has_more: false };
  });
  expect(await findCheckoutSessionForOrder(stripe, order, () => 0)).toBe(match);
  expect(calls.map((input) => [input.customer, input.starting_after])).toEqual([
    ["cus-1", undefined],
    ["cus-1", "session-1"],
  ]);
});

test("rejects missing pinned customers before reading the provider", async () => {
  let called = false;
  const stripe = client(async () => {
    called = true;
    return {};
  });
  await expect(
    findCheckoutSessionForOrder(stripe, { ...order, stripe_customer_id: null }),
  ).rejects.toThrow("pinned Stripe customer");
  expect(called).toBe(false);
});

test("rejects incomplete or cycling provider histories rather than reporting no match", async () => {
  for (const data of [[], [{ id: "repeat" }], [{}]]) {
    await expect(
      findCheckoutSessionForOrder(
        client(async () => ({ data, has_more: true })),
        order,
        () => 0,
      ),
    ).rejects.toThrow(/continuation page|invalid pagination/);
  }
});

test("returns null only for a completed search and preserves the operation deadline", async () => {
  expect(
    await findCheckoutSessionForOrder(
      client(async () => ({ data: [], has_more: false })),
      order,
      () => 0,
    ),
  ).toBeNull();
  let now = 0;
  const stripe = client(async () => {
    now = 10_000;
    return { data: [], has_more: false };
  });
  await expect(
    findCheckoutSessionForOrder(stripe, order, () => now),
  ).rejects.toThrow("operation deadline");
});
