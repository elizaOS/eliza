/**
 * Integration tests for the Polymarket plugin.
 */

import { beforeAll, describe, expect, it } from "vitest";

let polymarketPlugin: {
  name: string;
  description: string;
  services?: unknown;
  providers?: unknown;
  actions?: unknown;
  config?: unknown;
  init?: unknown;
};

describe("Polymarket Plugin Integration Tests", () => {
  beforeAll(async () => {
    const mod = await import("../index");
    polymarketPlugin = mod.polymarketPlugin;
  }, 20_000);

  describe("Plugin Structure", () => {
    it("should export polymarketPlugin", async () => {
      expect(polymarketPlugin).toBeDefined();
      expect(polymarketPlugin.name).toBe("polymarket");
    });

    it("should have correct description", async () => {
      expect(polymarketPlugin.description).toContain("Polymarket");
    });

    it("should have services defined", async () => {
      expect(polymarketPlugin.services).toBeDefined();
      expect(Array.isArray(polymarketPlugin.services)).toBe(true);
    });

    it("should have providers defined", async () => {
      expect(polymarketPlugin.providers).toBeDefined();
      expect(Array.isArray(polymarketPlugin.providers)).toBe(true);
    });

    it("should have init function", async () => {
      expect(typeof polymarketPlugin.init).toBe("function");
    });
  });

  describe("Configuration", () => {
    it("should have all config keys", async () => {
      const config = polymarketPlugin.config as { [k: string]: unknown };
      expect(config).toHaveProperty("CLOB_API_URL");
      expect(config).toHaveProperty("POLYMARKET_PRIVATE_KEY");
    });
  });

  describe("Actions", () => {
    it("should export market actions", async () => {
      const actions = await import("../actions");
      expect(actions.retrieveAllMarketsAction).toBeDefined();
      expect(actions.getMarketDetailsAction).toBeDefined();
    });

    it("should export order book actions", async () => {
      const actions = await import("../actions");
      expect(actions.getOrderBookSummaryAction).toBeDefined();
      expect(actions.getOrderBookDepthAction).toBeDefined();
    });

    it("should export trading actions", async () => {
      const actions = await import("../actions");
      expect(actions.placeOrderAction).toBeDefined();
      expect(actions.getOrderDetailsAction).toBeDefined();
    });
  });

  describe("Provider", () => {
    it("should export polymarketProvider", async () => {
      const { polymarketProvider } = await import("../providers");
      expect(polymarketProvider).toBeDefined();
    });
  });

  describe("Service", () => {
    it("should export PolymarketService", async () => {
      const { PolymarketService } = await import("../services");
      expect(PolymarketService).toBeDefined();
    });
  });

  describe("Public API Tests (no auth required)", () => {
    it("should be able to fetch public markets", async () => {
      if (process.env.POLYMARKET_LIVE_TESTS !== "1") return;
      const response = await fetch("https://clob.polymarket.com/markets?limit=1");
      expect(response.ok).toBe(true);
    });
  });
});
