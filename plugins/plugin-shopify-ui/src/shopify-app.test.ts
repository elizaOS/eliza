import { describe, expect, it, vi } from "vitest";

const registerOverlayApp = vi.hoisted(() => vi.fn());

vi.mock("@elizaos/ui", () => ({
  registerOverlayApp,
}));

describe("shopify overlay registration", () => {
  it("registers the overlay descriptor when imported", async () => {
    const { SHOPIFY_APP_NAME, shopifyApp } = await import("./shopify-app");

    expect(shopifyApp).toMatchObject({
      name: SHOPIFY_APP_NAME,
      displayName: "Shopify",
      description:
        "Manage your Shopify store — products, orders, inventory, customers",
      category: "utility",
    });
    expect(shopifyApp.loader).toEqual(expect.any(Function));
    expect(registerOverlayApp).toHaveBeenCalledTimes(1);
    expect(registerOverlayApp).toHaveBeenCalledWith(shopifyApp);
  });
});
