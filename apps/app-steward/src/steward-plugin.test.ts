/**
 * Tests for the Steward plugin route registration shape.
 *
 * These tests validate the plugin object structure and route definitions
 * without invoking actual wallet/steward handlers (which require runtime state).
 */
import { describe, expect, it, vi } from "vitest";

// Stub out all handler modules — they have complex dependencies we don't
// need for shape validation.
vi.mock("./routes/steward-compat-routes", () => ({
  handleStewardCompatRoutes: vi.fn(async () => false),
}));
vi.mock("./routes/wallet-browser-compat-routes", () => ({
  handleWalletBrowserCompatRoutes: vi.fn(async () => false),
}));
vi.mock("./routes/wallet-bsc-core-routes", () => ({
  handleWalletBscCoreRoutes: vi.fn(async () => false),
}));
vi.mock("./routes/wallet-compat-routes", () => ({
  handleWalletCompatRoutes: vi.fn(async () => false),
}));
vi.mock("./routes/wallet-core-routes", () => ({
  handleWalletCoreRoutes: vi.fn(async () => false),
}));
vi.mock("./routes/wallet-trade-compat-routes", () => ({
  handleWalletTradeCompatRoutes: vi.fn(async () => false),
}));
describe("stewardPlugin shape", () => {
  it("exports a valid Plugin with routes", async () => {
    const { stewardPlugin } = await import("./plugin");
    expect(stewardPlugin.name).toBe("@elizaos/app-steward");
    expect(stewardPlugin.routes).toBeDefined();
    expect(stewardPlugin.routes!.length).toBe(34);
  });

  it("all routes have rawPath: true", async () => {
    const { stewardPlugin } = await import("./plugin");
    for (const route of stewardPlugin.routes!) {
      expect((route as Record<string, unknown>).rawPath).toBe(true);
    }
  });

  it("all routes have valid type and handler", async () => {
    const { stewardPlugin } = await import("./plugin");
    const validTypes = new Set(["GET", "POST", "PUT", "DELETE", "PATCH"]);
    for (const route of stewardPlugin.routes!) {
      expect(validTypes.has(route.type)).toBe(true);
      expect(typeof route.handler).toBe("function");
    }
  });

  it("has the expected route paths", async () => {
    const { stewardPlugin } = await import("./plugin");
    const paths = stewardPlugin.routes!.map((r) => r.path);

    // Core wallet routes
    expect(paths).toContain("/api/wallet/addresses");
    expect(paths).toContain("/api/wallet/balances");
    expect(paths).toContain("/api/wallet/import");
    expect(paths).toContain("/api/wallet/generate");
    expect(paths).toContain("/api/wallet/config");
    expect(paths).toContain("/api/wallet/export");

    // BSC trade routes
    expect(paths).toContain("/api/wallet/trade/preflight");
    expect(paths).toContain("/api/wallet/trade/quote");
    expect(paths).toContain("/api/wallet/trade/tx-status");

    // Steward-specific routes
    expect(paths).toContain("/api/wallet/steward-status");
    expect(paths).toContain("/api/wallet/steward-policies");
    expect(paths).toContain("/api/wallet/steward-webhook");

    // Trade execution routes
    expect(paths).toContain("/api/wallet/trade/execute");
    expect(paths).toContain("/api/wallet/transfer/execute");
  });

  it("steward-webhook route is public", async () => {
    const { stewardPlugin } = await import("./plugin");
    const webhook = stewardPlugin.routes!.find(
      (r) => r.path === "/api/wallet/steward-webhook",
    );
    expect(webhook).toBeDefined();
    expect((webhook as Record<string, unknown>).public).toBe(true);
  });

  it("handlers can be invoked without throwing", async () => {
    const { stewardPlugin } = await import("./plugin");
    // Just verify the first handler can be called (will hit mocked handler)
    const firstRoute = stewardPlugin.routes![0];
    const req = { method: "GET", url: "/api/wallet/addresses" };
    const res = { statusCode: 0, setHeader: vi.fn(), end: vi.fn() };
    // Should not throw
    await firstRoute.handler(req, res, null);
  });
});
