import type { IAgentRuntime } from "@elizaos/core";
import { generatePrivateKey } from "viem/accounts";
import { describe, expect, it } from "vitest";
import registryEntry from "../../../../registry-entry.json";
import { initWalletProvider } from "./wallet";

const PRIVATE_KEY = generatePrivateKey();

function runtimeWith(settings: Record<string, string>): IAgentRuntime {
  return {
    agentId: "00000000-0000-0000-0000-000000000001",
    character: { name: "Eliza", bio: [], settings: { chains: { evm: ["mainnet", "base"] } } },
    getSetting: (key: string) => (key === "EVM_PRIVATE_KEY" ? PRIVATE_KEY : settings[key]),
  } as unknown as IAgentRuntime;
}

describe("custom RPC URLs from the plugin settings form", () => {
  it("uses the Ethereum mainnet URL the form saves", async () => {
    // The form saves the field names the registry entry declares.
    const fieldNames = Object.keys(
      (registryEntry as { config?: Record<string, unknown> }).config ?? {}
    );
    expect(fieldNames).toContain("ETHEREUM_PROVIDER_ETHEREUM");

    const wallet = await initWalletProvider(
      runtimeWith({
        ETHEREUM_PROVIDER_ETHEREUM: "https://custom-eth.example/rpc",
        ETHEREUM_PROVIDER_BASE: "https://custom-base.example/rpc",
      })
    );

    expect(wallet.chains.mainnet?.rpcUrls.custom?.http[0]).toBe("https://custom-eth.example/rpc");
    expect(wallet.chains.base?.rpcUrls.custom?.http[0]).toBe("https://custom-base.example/rpc");
  });
});
