import { describe, expect, it, vi } from "vitest";

const registerOverlayApp = vi.hoisted(() => vi.fn());

vi.mock("@elizaos/ui", () => ({
  registerOverlayApp,
}));

describe("vincent overlay registration", () => {
  it("registers the overlay descriptor when imported", async () => {
    const { VINCENT_APP_NAME, vincentApp } = await import("./vincent-app");

    expect(vincentApp).toMatchObject({
      name: VINCENT_APP_NAME,
      displayName: "Vincent",
      description: "Connect Vincent to trade on Hyperliquid and Polymarket",
      category: "trading",
    });
    expect(vincentApp.loader).toEqual(expect.any(Function));
    expect(registerOverlayApp).toHaveBeenCalledTimes(1);
    expect(registerOverlayApp).toHaveBeenCalledWith(vincentApp);
  });
});
