/** Verifies persistent Cloudflare sessions and exact checkout binding safeguards. */

import { describe, expect, test } from "bun:test";
import {
  doorDashPersistentConnectOptions,
  isDoorDashBrowserRunProviderBlock,
} from "./doordash-browser-run-session";
import {
  assertManagedCheckoutBinding,
  managedCheckoutBindingDigest,
} from "./doordash-checkout-binding";

const cart = {
  success: true,
  cartId: "active",
  items: [{ itemId: "item-0", name: "Ramen", quantity: 1, price: 15.99 }],
};
const preview = {
  success: true,
  requiresConfirmation: true,
  summary: {
    total: 23.42,
    deliveryAddress: "123 Main St",
    estimatedDelivery: "25-35 min",
  },
};

describe("managed DoorDash checkout binding", () => {
  test("accepts the exact confirmed cart and checkout independent of key order", () => {
    const digest = managedCheckoutBindingDigest(cart, preview);
    expect(() =>
      assertManagedCheckoutBinding(
        digest,
        {
          items: [{ price: 15.99, quantity: 1, name: "Ramen", itemId: "item-0" }],
          cartId: "active",
          success: true,
        },
        {
          summary: {
            estimatedDelivery: "25-35 min",
            deliveryAddress: "123 Main St",
            total: 23.42,
          },
          requiresConfirmation: true,
          success: true,
        },
      ),
    ).not.toThrow();
  });

  test.each([
    ["cart", { ...cart, items: [{ ...cart.items[0], quantity: 2 }] }, preview],
    ["total", cart, { ...preview, summary: { ...preview.summary, total: 25.01 } }],
    [
      "address",
      cart,
      {
        ...preview,
        summary: { ...preview.summary, deliveryAddress: "999 Other Ave" },
      },
    ],
  ])("rejects a changed %s before the order click", (_kind, currentCart, currentPreview) => {
    const digest = managedCheckoutBindingDigest(cart, preview);
    expect(() => assertManagedCheckoutBinding(digest, currentCart, currentPreview)).toThrow(
      /changed after confirmation/i,
    );
  });
});

describe("managed DoorDash Browser Run lifecycle", () => {
  test("reconnects through Cloudflare persistent mode so Live View tabs survive", () => {
    expect(doorDashPersistentConnectOptions("session-1")).toEqual({
      persistent: true,
      sessionId: "session-1",
    });
  });

  test("distinguishes DoorDash's unsolvable provider block from a user CAPTCHA", () => {
    expect(
      isDoorDashBrowserRunProviderBlock(
        "Just a moment...",
        "Incompatible browser extension or network configuration",
      ),
    ).toBe(true);
    expect(
      isDoorDashBrowserRunProviderBlock("Just a moment...", "Verify you are human to continue"),
    ).toBe(false);
  });
});
