/**
 * Package-barrel regression coverage for the Steward trading surface. The
 * published entrypoint must expose the plugin object, service class, helper,
 * and TypeScript trade envelopes that downstream agents compile against.
 */
import { describe, expect, it, vi } from "vitest";

// Keep package-barrel evaluation hermetic: these unrelated registration and
// backend-selection modules depend on the built @elizaos/shared package, which
// is intentionally unavailable in the changed-file test lane.
vi.mock("./api/wallet-routes.js", () => ({}));
vi.mock("./automation-node-contributor.js", () => ({
  registerWalletAutomationNodeContributor: vi.fn(),
}));
vi.mock("./wallet/select-backend.js", () => ({
  resolveWalletBackend: vi.fn(),
}));
vi.mock("./lib/server-wallet-trade.js", () => ({}));
vi.mock("./lib/wallet-export-guard.js", () => ({}));
vi.mock("./routes/plugin.js", () => ({}));

import walletPluginDefault, {
  createTradeIdempotencyKey,
  STEWARD_TRADING_SERVICE_TYPE,
  StewardTradingService,
  type TradeEnvelope,
  type Venue,
  walletPlugin,
} from "./index.js";

function acceptsTradingEnvelope(
  envelope: TradeEnvelope<{ venue: Venue }>,
): string {
  return envelope.ok ? envelope.data.venue : envelope.error;
}

describe("plugin-wallet package barrel Steward trading exports", () => {
  it("exports the aggregate wallet plugin and Steward service runtime contracts", () => {
    expect(walletPluginDefault).toBe(walletPlugin);
    expect(walletPlugin.services).toContain(StewardTradingService);
    expect(StewardTradingService.serviceType).toBe(
      STEWARD_TRADING_SERVICE_TYPE,
    );
  });

  it("exports idempotency and trade-envelope types through the entrypoint", () => {
    const firstKey = createTradeIdempotencyKey();
    const secondKey = createTradeIdempotencyKey();

    expect(firstKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(secondKey).not.toBe(firstKey);
    expect(
      acceptsTradingEnvelope({
        ok: false,
        outcome: "not_attempted",
        error: "SESSION_REQUIRED",
        detail: "No governed session is configured.",
        retryable: false,
        policy: { reason: "session-not-active" },
      }),
    ).toBe("SESSION_REQUIRED");
    expect(
      acceptsTradingEnvelope({
        ok: true,
        data: { venue: "hyperliquid" },
        audit: { sessionId: "session-fixture" },
      }),
    ).toBe("hyperliquid");
  });
});
