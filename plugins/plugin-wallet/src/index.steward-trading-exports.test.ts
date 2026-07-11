/**
 * Package-barrel regression coverage for the Steward trading surface. The
 * published entrypoint must expose the plugin object, service class, helper,
 * and TypeScript trade envelopes that downstream agents compile against.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/core", async () => {
  return await import("./__tests__/core-vitest-mock.js");
});

// Keep package-barrel evaluation hermetic: these unrelated registration and
// backend-selection modules depend on the built @elizaos/shared package, which
// is intentionally unavailable in the changed-file test lane.
vi.mock("./api/wallet-routes.js", () => ({}));
vi.mock("./analytics/lpinfo/index.js", () => ({
  kaminoPlugin: { name: "kamino" },
  lpinfoPlugin: { name: "lpinfo" },
  steerPlugin: { name: "steer" },
}));
vi.mock("./automation-node-contributor.js", () => ({
  registerWalletAutomationNodeContributor: vi.fn(),
}));
vi.mock("./chains/evm/bridge-router.js", () => ({
  validateWalletBridgeParams: vi.fn(() => null),
}));
vi.mock("./chains/evm/index.js", () => ({
  default: {
    name: "evm",
    services: [],
    providers: [],
    actions: [],
    routes: [],
  },
}));
vi.mock("./chains/registry.js", () => ({
  registerDefaultWalletChainHandlers: vi.fn(),
}));
vi.mock("./chains/solana/index.js", () => ({
  default: {
    name: "solana",
    services: [],
    providers: [],
    actions: [],
    routes: [],
  },
}));
vi.mock("./lp/lp-manager-entry.js", () => ({
  AerodromeLpService: class AerodromeLpService {},
  aerodromePlugin: { name: "aerodrome" },
  ConcentratedLiquidityService: class ConcentratedLiquidityService {},
  DexInteractionService: class DexInteractionService {},
  default: { name: "lp-manager" },
  LP_MANAGER_PLUGIN_NAME: "@elizaos/plugin-lp-manager",
  orcaPlugin: { name: "orca" },
  PancakeSwapV3LpService: class PancakeSwapV3LpService {},
  pancakeswapPlugin: { name: "pancakeswap" },
  raydiumPlugin: { name: "raydium" },
  UniswapV3LpService: class UniswapV3LpService {},
  uniswapPlugin: { name: "uniswap" },
  UserLpProfileService: class UserLpProfileService {},
  VaultService: class VaultService {},
  YieldOptimizationService: class YieldOptimizationService {},
}));
vi.mock("./wallet/select-backend.js", () => ({
  resolveWalletBackend: vi.fn(),
}));
vi.mock("./wallet/index.js", () => ({}));
vi.mock("./lib/server-wallet-trade.js", () => ({}));
vi.mock("./lib/wallet-export-guard.js", () => ({}));
vi.mock("./routes/plugin.js", () => ({}));
vi.mock("./sdk/index.js", () => ({}));
vi.mock("./wallet-action.js", () => ({}));

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
