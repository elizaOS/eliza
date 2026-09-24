/**
 * Exercises Steward service startup and disposal through the wallet entrypoint.
 * The service and plugin are real; unrelated wallet backends and runtime
 * collaborators are mocked, so this does not submit live trades.
 */

import { type IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/core", async () => {
  return await import("./__tests__/core-vitest-mock.js");
});
// Keep package-barrel evaluation hermetic: these unrelated registration and
// backend-selection modules depend on the built @elizaos/core package, which
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
  walletPlugin,
} from "./index.js";

function runtimeWithService(service?: StewardTradingService): IAgentRuntime {
  const settings: Record<string, string> = {
    STEWARD_API_URL: "https://steward.local",
    STEWARD_AGENT_ID: "agent-fixture",
    STEWARD_AGENT_TOKEN: "token-fixture",
  };
  return {
    getSetting: (key: string) => settings[key],
    getService: (serviceType: string) => {
      if (serviceType === StewardTradingService.serviceType) return service;
      return undefined;
    },
    logger: {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      log: vi.fn(),
      warn: vi.fn(),
    },
  } as unknown as IAgentRuntime;
}
describe("wallet entrypoint Steward trading lifecycle", () => {
  beforeEach(() => {
    vi.stubEnv("ELIZA_CLOUD_PROVISIONED", "0");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  it("registers StewardTradingService as a startable wallet service", async () => {
    expect(walletPluginDefault).toBe(walletPlugin);
    expect(StewardTradingService.serviceType).toBe(
      STEWARD_TRADING_SERVICE_TYPE,
    );
    const serviceClasses = walletPlugin.services ?? [];
    expect(serviceClasses).toContain(StewardTradingService);
    expect(
      serviceClasses.filter(
        (serviceClass) =>
          serviceClass.serviceType === StewardTradingService.serviceType,
      ),
    ).toHaveLength(1);
    const serviceClass = serviceClasses.find(
      (candidate) => candidate === StewardTradingService,
    ) as typeof StewardTradingService | undefined;
    const service = await serviceClass?.start?.(runtimeWithService());
    expect(service).toBeInstanceOf(StewardTradingService);
    expect(service?.capability()).toMatchObject({
      kind: "steward-self",
      canTrade: true,
      agentId: "agent-fixture",
      apiUrl: "https://steward.local",
    });
  });
  it("tears down the registered Steward trading service during wallet plugin disposal", async () => {
    const service = new StewardTradingService(runtimeWithService());
    const stop = vi.spyOn(service, "stop").mockResolvedValue(undefined);
    await walletPlugin.dispose?.(runtimeWithService(service));
    expect(stop).toHaveBeenCalledTimes(1);
  });
  it("creates distinct idempotency keys through the entrypoint", () => {
    const firstKey = createTradeIdempotencyKey();
    expect(firstKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(createTradeIdempotencyKey()).not.toBe(firstKey);
  });
});
