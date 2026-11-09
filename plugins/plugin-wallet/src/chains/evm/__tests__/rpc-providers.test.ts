import { type AgentRuntime, createCharacter } from "@elizaos/core";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import * as viemChains from "viem/chains";
import { afterEach, describe, expect, it } from "vitest";
import { initWalletProvider } from "../providers/wallet";
import { initRPCProviderManager } from "../rpc-providers";

const HARDHAT_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const runtimes: AgentRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) {
    await runtime.stop();
    await runtime.close();
  }
});

async function runtimeWith(chains: string[], secrets: Record<string, string>) {
  const runtime = createSQLiteTestRuntime({
    character: createCharacter({
      name: "RpcProviderAgent",
      settings: {
        chains: { evm: chains },
        secrets: { EVM_PRIVATE_KEY: HARDHAT_KEY, ...secrets },
      },
    }),
    logLevel: "fatal",
    enableAutonomy: false,
  });
  runtimes.push(runtime);
  await runtime.initialize({ skipMigrations: true });
  return runtime;
}

function customRpc(
  wallet: Awaited<ReturnType<typeof initWalletProvider>>,
  chain: string
): string | undefined {
  return wallet.chains[chain]?.rpcUrls.custom?.http[0];
}

describe("managed RPC providers for configured chains", () => {
  it("serves ZKsync and Mantle Sepolia from Infura when only INFURA_API_KEY is set", async () => {
    const runtime = await runtimeWith(
      ["base", "zksync", "zksyncSepoliaTestnet", "mantleSepoliaTestnet"],
      {
        INFURA_API_KEY: "infura-key",
      }
    );
    const wallet = await initWalletProvider(runtime);

    expect(customRpc(wallet, "base")).toBe("https://base-mainnet.infura.io/v3/infura-key");
    expect(customRpc(wallet, "zksync")).toBe("https://zksync-mainnet.infura.io/v3/infura-key");
    expect(customRpc(wallet, "zksyncSepoliaTestnet")).toBe(
      "https://zksync-sepolia.infura.io/v3/infura-key"
    );
    expect(customRpc(wallet, "mantleSepoliaTestnet")).toBe(
      "https://mantle-sepolia.infura.io/v3/infura-key"
    );
  });

  it("serves ZKsync Sepolia from Alchemy when only ALCHEMY_API_KEY is set", async () => {
    const runtime = await runtimeWith(["zksyncSepoliaTestnet"], {
      ALCHEMY_API_KEY: "alchemy-key",
    });
    const wallet = await initWalletProvider(runtime);

    expect(customRpc(wallet, "zksyncSepoliaTestnet")).toBe(
      "https://zksync-sepolia.g.alchemy.com/v2/alchemy-key"
    );
  });

  it("keys every Alchemy and Infura chain by its viem chain name", async () => {
    const runtime = await runtimeWith(["base"], {
      ALCHEMY_API_KEY: "alchemy-key",
      INFURA_API_KEY: "infura-key",
    });
    const covered = initRPCProviderManager(runtime).getCoveredChains();

    expect(covered.filter((chain) => !(chain in viemChains))).toEqual([]);
  });
});
