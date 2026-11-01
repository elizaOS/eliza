import { type IAgentRuntime, ServiceType } from "@elizaos/core";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { initWalletProvider } from "./wallet";

const TEE_KEY = generatePrivateKey();
const TEE_ADDRESS = privateKeyToAccount(TEE_KEY).address;

function teeRuntime(): IAgentRuntime {
  const teeService = {
    deriveEcdsaKeypair: async () => ({ keypair: TEE_KEY, attestation: null }),
  };
  return {
    agentId: "00000000-0000-0000-0000-000000000001",
    character: { name: "Eliza", bio: [], settings: { chains: { evm: ["mainnet", "base"] } } },
    getSetting: (key: string) =>
      key === "TEE_MODE" ? "ON" : key === "WALLET_SECRET_SALT" ? "test-salt" : undefined,
    getService: (serviceType: string) => (serviceType === ServiceType.TEE ? teeService : null),
  } as unknown as IAgentRuntime;
}

describe("TEE wallet initialization", () => {
  it("returns a provider whose address is available immediately after init", async () => {
    const wallet = await initWalletProvider(teeRuntime());

    // getAddress() is synchronous and throws WALLET_NOT_INITIALIZED when the
    // TEE wallet has not been initialized yet; initWalletProvider must have
    // awaited initialization before returning.
    expect(wallet.getAddress()).toBe(TEE_ADDRESS);
    expect(() => wallet.getWalletClient("mainnet")).not.toThrow();
  });
});
