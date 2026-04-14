import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  MockStewardApiError,
  MockStewardClient,
  fetchEvmNativeBalanceViaRpcMock,
  fetchSolanaBalancesMock,
  fetchSolanaNativeBalanceViaRpcMock,
  getAgentMock,
  getBalanceMock,
  loadElizaConfigMock,
  resolveWalletRpcReadinessMock,
  listAgentsMock,
  resolveEffectiveStewardConfigMock,
  saveStewardCredentialsMock,
  stewardClientCtorMock,
} = vi.hoisted(() => {
  const getAgentMock = vi.fn();
  const listAgentsMock = vi.fn();
  const getBalanceMock = vi.fn();
  const fetchSolanaBalancesMock = vi.fn();
  const fetchSolanaNativeBalanceViaRpcMock = vi.fn();
  const fetchEvmNativeBalanceViaRpcMock = vi.fn();
  const resolveWalletRpcReadinessMock = vi.fn();
  const loadElizaConfigMock = vi.fn();
  const resolveEffectiveStewardConfigMock = vi.fn();
  const saveStewardCredentialsMock = vi.fn();
  const stewardClientCtorMock = vi.fn();

  class MockStewardClient {
    constructor(config: unknown) {
      stewardClientCtorMock(config);
    }

    getAgent = getAgentMock;
    listAgents = listAgentsMock;
    getBalance = getBalanceMock;
  }

  class MockStewardApiError extends Error {
    status: number;

    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  }

  return {
    MockStewardApiError,
    MockStewardClient,
    fetchEvmNativeBalanceViaRpcMock,
    fetchSolanaBalancesMock,
    fetchSolanaNativeBalanceViaRpcMock,
    getAgentMock,
    getBalanceMock,
    loadElizaConfigMock,
    resolveWalletRpcReadinessMock,
    listAgentsMock,
    resolveEffectiveStewardConfigMock,
    saveStewardCredentialsMock,
    stewardClientCtorMock,
  };
});

vi.mock("@stwd/sdk", () => ({
  StewardApiError: MockStewardApiError,
  StewardClient: MockStewardClient,
}));

vi.mock(
  "../../../../apps/app-steward/src/services/steward-credentials.ts",
  () => ({
    loadStewardCredentials: vi.fn(() => null),
    resolveEffectiveStewardConfig: resolveEffectiveStewardConfigMock,
    saveStewardCredentials: saveStewardCredentialsMock,
  }),
);

vi.mock("../../../../apps/app-steward/src/api/wallet.ts", () => ({
  fetchSolanaBalances: fetchSolanaBalancesMock,
  fetchSolanaNativeBalanceViaRpc: fetchSolanaNativeBalanceViaRpcMock,
}));

vi.mock("../../../../apps/app-steward/src/api/wallet-evm-balance.ts", () => ({
  fetchEvmNativeBalanceViaRpc: fetchEvmNativeBalanceViaRpcMock,
}));

vi.mock("../../../../apps/app-steward/src/api/wallet-rpc.ts", () => ({
  resolveWalletRpcReadiness: resolveWalletRpcReadinessMock,
}));

vi.mock("@elizaos/agent/config/config", () => ({
  loadElizaConfig: loadElizaConfigMock,
}));

import {
  buildStewardHeaders,
  createStewardClient,
  getStewardBalance,
  getStewardBridgeStatus,
  getStewardTokenBalances,
  isStewardConfigured,
} from "../../../../apps/app-steward/src/routes/steward-bridge";

describe("steward-bridge persisted credential fallback", () => {
  const originalFetch = globalThis.fetch;
  const persistedConfig = {
    apiUrl: "http://127.0.0.1:3200",
    tenantId: "milady-desktop",
    agentId: "milady-wallet",
    apiKey: "tenant-key",
    agentToken: "persisted-agent-token",
  };

  beforeEach(() => {
    getAgentMock.mockReset();
    getBalanceMock.mockReset();
    listAgentsMock.mockReset();
    fetchSolanaBalancesMock.mockReset();
    fetchSolanaNativeBalanceViaRpcMock.mockReset();
    fetchEvmNativeBalanceViaRpcMock.mockReset();
    resolveWalletRpcReadinessMock.mockReset();
    loadElizaConfigMock.mockReset();
    resolveEffectiveStewardConfigMock.mockReset();
    saveStewardCredentialsMock.mockReset();
    stewardClientCtorMock.mockReset();
    resolveEffectiveStewardConfigMock.mockReturnValue(persistedConfig);
    resolveWalletRpcReadinessMock.mockReturnValue({
      ethereumRpcUrls: ["https://cloud.example/eth"],
      bscRpcUrls: ["https://cloud.example/bsc"],
      baseRpcUrls: ["https://cloud.example/base"],
      avalancheRpcUrls: ["https://cloud.example/avax"],
      solanaRpcUrls: ["https://cloud.example/solana"],
    });
    loadElizaConfigMock.mockReturnValue({ cloud: { apiKey: "cloud-key" } });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("prefers the persisted tenant key over a stale bearer token", () => {
    const client = createStewardClient({
      env: {
        STEWARD_API_URL: persistedConfig.apiUrl,
        STEWARD_AGENT_TOKEN: "stale-agent-token",
      } as NodeJS.ProcessEnv,
    });

    expect(client).not.toBeNull();
    expect(stewardClientCtorMock).toHaveBeenCalledWith({
      apiKey: "tenant-key",
      baseUrl: persistedConfig.apiUrl,
      bearerToken: undefined,
      tenantId: persistedConfig.tenantId,
    });
  });

  it("builds direct-call headers from persisted credentials in external mode", () => {
    const headers = buildStewardHeaders({
      STEWARD_API_URL: persistedConfig.apiUrl,
      STEWARD_AGENT_TOKEN: "stale-agent-token",
    } as NodeJS.ProcessEnv);

    expect(headers.get("X-Steward-Key")).toBe("tenant-key");
    expect(headers.get("X-Steward-Tenant")).toBe("milady-desktop");
    expect(headers.get("Authorization")).toBeNull();
  });

  it("reports steward connected when only persisted credentials are complete", async () => {
    getAgentMock.mockResolvedValue({
      name: "Milady Wallet",
      walletAddresses: {
        evm: "0x1234567890abcdef1234567890abcdef12345678",
        solana: "8RsmpM7Ztk5H2nesQSjk8okmFTiZFk4kBUcyaygPrVxa",
      },
    });

    const status = await getStewardBridgeStatus({
      env: {
        STEWARD_API_URL: persistedConfig.apiUrl,
        STEWARD_AGENT_TOKEN: "stale-agent-token",
      } as NodeJS.ProcessEnv,
    });

    expect(getAgentMock).toHaveBeenCalledWith("milady-wallet");
    expect(status).toMatchObject({
      agentId: "milady-wallet",
      agentName: "Milady Wallet",
      available: true,
      baseUrl: persistedConfig.apiUrl,
      connected: true,
      configured: true,
      error: null,
      evmAddress: "0x1234567890abcdef1234567890abcdef12345678",
      vaultHealth: "ok",
      walletAddresses: {
        evm: "0x1234567890abcdef1234567890abcdef12345678",
        solana: "8RsmpM7Ztk5H2nesQSjk8okmFTiZFk4kBUcyaygPrVxa",
      },
    });
  });

  it("treats persisted steward config as configured", () => {
    expect(isStewardConfigured({} as NodeJS.ProcessEnv)).toBe(true);
  });

  it("falls back to rpc-native Solana balances when the steward SDK balance call fails", async () => {
    getAgentMock.mockResolvedValue({
      walletAddresses: {
        evm: "0x1234567890abcdef1234567890abcdef12345678",
        solana: "8RsmpM7Ztk5H2nesQSjk8okmFTiZFk4kBUcyaygPrVxa",
      },
    });
    getBalanceMock.mockRejectedValue(new Error("rpc method is unsupported"));
    fetchSolanaNativeBalanceViaRpcMock.mockResolvedValue({
      solBalance: "1.250000000",
      solValueUsd: "0",
      tokens: [],
    });

    const result = await getStewardBalance("milady-wallet", 101);

    expect(fetchSolanaNativeBalanceViaRpcMock).toHaveBeenCalledWith(
      "8RsmpM7Ztk5H2nesQSjk8okmFTiZFk4kBUcyaygPrVxa",
      ["https://cloud.example/solana"],
    );
    expect(result).toEqual({
      balance: "1.250000000",
      formatted: "1.250000000",
      symbol: "SOL",
      chainId: 101,
    });
  });

  it("falls back to rpc-native EVM balances when the steward SDK balance call fails", async () => {
    getAgentMock.mockResolvedValue({
      walletAddresses: {
        evm: "0x1234567890abcdef1234567890abcdef12345678",
        solana: null,
      },
    });
    getBalanceMock.mockRejectedValue(new Error("rate limited"));
    fetchEvmNativeBalanceViaRpcMock.mockResolvedValue("0.420000000000000000");

    const result = await getStewardBalance("milady-wallet", 1);

    expect(fetchEvmNativeBalanceViaRpcMock).toHaveBeenCalledWith(
      "https://cloud.example/eth",
      "0x1234567890abcdef1234567890abcdef12345678",
    );
    expect(result).toEqual({
      balance: "0.420000000000000000",
      formatted: "0.420000000000000000",
      symbol: "ETH",
      chainId: 1,
    });
  });

  it("falls back to a native-only token response when steward token inventory fails", async () => {
    getAgentMock.mockResolvedValue({
      walletAddresses: {
        evm: "0x1234567890abcdef1234567890abcdef12345678",
        solana: null,
      },
    });
    fetchEvmNativeBalanceViaRpcMock.mockResolvedValue("0.1");
    globalThis.fetch = vi.fn(
      async () => new Response("forbidden", { status: 403 }),
    ) as typeof fetch;

    const result = await getStewardTokenBalances("milady-wallet", 1);

    expect(result).toEqual({
      native: {
        balance: "0.1",
        formatted: "0.1",
        symbol: "ETH",
        chainId: 1,
      },
      tokens: [],
    });
  });
});
