import { describe, expect, it, vi } from "vitest";

const registerOverlayApp = vi.hoisted(() => vi.fn());

vi.mock("@elizaos/app-core", () => ({
  registerOverlayApp,
}));

describe("hyperliquid overlay registration", () => {
  it("registers the overlay descriptor when imported", async () => {
    const { HYPERLIQUID_APP_NAME, hyperliquidApp } = await import(
      "./hyperliquid-app"
    );

    expect(hyperliquidApp).toMatchObject({
      name: HYPERLIQUID_APP_NAME,
      displayName: "Hyperliquid",
      description: "Native Hyperliquid market, position, and order status",
      category: "trading",
    });
    expect(hyperliquidApp.loader).toEqual(expect.any(Function));
    expect(registerOverlayApp).toHaveBeenCalledTimes(1);
    expect(registerOverlayApp).toHaveBeenCalledWith(hyperliquidApp);
  });
});
