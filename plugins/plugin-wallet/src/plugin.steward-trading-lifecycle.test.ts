/**
 * Regression coverage for the wallet plugin's Steward trading service wiring.
 * The runtime starts service classes from the plugin manifest and later calls
 * plugin disposal, so this test pins both halves without booting an agent.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/core", async () => {
  return await import("./__tests__/core-vitest-mock.js");
});

// Backend selection is unrelated to plugin composition and requires the built
// @elizaos/shared entrypoint, which the changed-file CI lane does not provide.
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
vi.mock("./wallet/select-backend.js", () => ({
  resolveWalletBackend: vi.fn(),
}));

import { walletPlugin } from "./plugin.js";
import { StewardTradingService } from "./services/steward-trading-service.js";
import { WALLET_BACKEND_SERVICE_TYPE } from "./services/wallet-backend-service.js";

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
      if (serviceType === WALLET_BACKEND_SERVICE_TYPE) return undefined;
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

describe("walletPlugin Steward trading lifecycle", () => {
  beforeEach(() => {
    vi.stubEnv("ELIZA_CLOUD_PROVISIONED", "0");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("registers StewardTradingService as a startable wallet service", async () => {
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
});
