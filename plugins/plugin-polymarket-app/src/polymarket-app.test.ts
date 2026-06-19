import { describe, expect, it, vi } from "vitest";

const registerOverlayApp = vi.hoisted(() => vi.fn());

vi.mock("@elizaos/app-core", () => ({
  registerOverlayApp,
}));

describe("polymarket overlay registration", () => {
  it("registers the overlay descriptor when imported", async () => {
    const { POLYMARKET_APP_NAME, polymarketApp } = await import(
      "./polymarket-app"
    );

    expect(polymarketApp).toMatchObject({
      name: POLYMARKET_APP_NAME,
      displayName: "Polymarket",
      description:
        "Browse Polymarket markets and inspect native trading readiness",
      category: "trading",
    });
    expect(polymarketApp.loader).toEqual(expect.any(Function));
    expect(registerOverlayApp).toHaveBeenCalledTimes(1);
    expect(registerOverlayApp).toHaveBeenCalledWith(polymarketApp);
  });
});
