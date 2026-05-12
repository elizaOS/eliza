import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

function installMocks(): void {
  mock.module("@/lib/runtime/cloud-bindings", () => ({
    getCloudAwareEnv: () => ({
      FACILITATOR_PRIVATE_KEY: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
      X402_NETWORKS: "base",
      X402_BASE_RPC_URL: "https://base-rpc.example",
    }),
  }));

  mock.module("@/lib/services/secrets", () => ({
    secretsService: {
      get: async () => null,
    },
  }));

  mock.module("@/lib/utils/logger", () => ({
    logger: { debug: () => {}, error: () => {}, info: () => {}, warn: () => {} },
  }));
}

async function loadService() {
  const mod = await import(
    new URL(
      `../../../lib/services/x402-facilitator.ts?test=${Date.now()}-${Math.random()}`,
      import.meta.url,
    ).href
  );
  return mod.x402FacilitatorService as {
    initialize: () => Promise<void>;
    networks: Record<string, { usdcDomainName: string }>;
  };
}

describe("x402 facilitator domains", () => {
  beforeEach(() => mock.restore());
  afterEach(() => mock.restore());

  test("uses Circle's Base mainnet USDC EIP-712 domain name", async () => {
    installMocks();
    const service = await loadService();

    await service.initialize();

    expect(service.networks["eip155:8453"]).toMatchObject({
      usdcDomainName: "USD Coin",
      rpcUrl: "https://base-rpc.example",
    });
  });
});
