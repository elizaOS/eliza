/**
 * Exercises the EVM wallet provider's local, cache, chain, initialization, and
 * prompt-context behavior without network access. A real AgentRuntime supplies
 * settings and service lookup while its cache boundary is observed with spies.
 */
import { AgentRuntime, type Memory, type State } from "@elizaos/core";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { mainnet, optimism } from "viem/chains";
import { describe, expect, it, vi } from "vitest";
import { EVM_SERVICE_NAME } from "../../constants";
import { evmWalletProvider, initWalletProvider, WalletProvider } from "../../providers/wallet";
import { EVMService } from "../../service";

const message = {} as Memory;
const state = { agentName: "Wallet Agent" } as State;

function runtime(): AgentRuntime {
  return new AgentRuntime({
    character: {
      name: "WalletTest",
      settings: { chains: { evm: ["mainnet"] } },
    },
    logLevel: "fatal",
  });
}

describe("WalletProvider local chain and cache behavior", () => {
  it("accepts private keys and accounts, exposes chains, and rejects unknown chains", () => {
    const key = generatePrivateKey();
    const rt = runtime();
    const fromKey = new WalletProvider(key, rt, { mainnet });
    const fromAccount = new WalletProvider(privateKeyToAccount(key), rt, {
      mainnet,
    });

    expect(fromKey.getAddress()).toBe(fromAccount.getAddress());
    expect(fromKey.account.address).toBe(fromKey.getAddress());
    expect(fromKey.chains.mainnet).toBe(mainnet);
    expect(fromKey.getSupportedChains()).toEqual(["mainnet"]);
    expect(fromKey.getChainConfigs("mainnet")).toBe(mainnet);
    expect(() => fromKey.getChainConfigs("missing" as never)).toThrow("Invalid chain name");

    fromKey.addChain({ optimism });
    expect(fromKey.getSupportedChains()).toEqual(["mainnet", "optimism"]);
  });

  it("validates private keys and builds custom chain configurations", () => {
    const rt = runtime();

    expect(() => new WalletProvider("0x1234", rt, { mainnet })).toThrow(
      "Invalid private key format"
    );
    expect(() => WalletProvider.genChainFromName("missing-chain")).toThrow("Invalid chain name");

    const custom = WalletProvider.genChainFromName("mainnet", "http://127.0.0.1:8545");
    expect(custom.rpcUrls.custom?.http).toEqual(["http://127.0.0.1:8545"]);
  });

  it("constructs public, wallet, and test clients without opening the transport", () => {
    const provider = new WalletProvider(generatePrivateKey(), runtime(), {
      mainnet,
    });

    expect(provider.getPublicClient("mainnet").chain?.id).toBe(mainnet.id);
    expect(provider.getWalletClient("mainnet").chain?.id).toBe(mainnet.id);
    expect(provider.getTestClient().mode).toBe("hardhat");
  });

  it("returns a warm balance cache without opening an RPC client", async () => {
    const rt = runtime();
    const getCache = vi.spyOn(rt, "getCache").mockResolvedValue({ mainnet: "2.5" });
    const setCache = vi.spyOn(rt, "setCache").mockResolvedValue(true);
    const provider = new WalletProvider(generatePrivateKey(), rt, { mainnet });
    const getPublicClient = vi.spyOn(provider, "getPublicClient");

    await expect(provider.getWalletBalances()).resolves.toEqual({
      mainnet: "2.5",
    });
    expect(getCache).toHaveBeenCalledOnce();
    expect(getPublicClient).not.toHaveBeenCalled();
    expect(setCache).not.toHaveBeenCalled();
  });

  it("force-refreshes every chain in parallel and caches a complete snapshot", async () => {
    const rt = runtime();
    const getCache = vi.spyOn(rt, "getCache");
    const setCache = vi.spyOn(rt, "setCache").mockResolvedValue(true);
    const provider = new WalletProvider(generatePrivateKey(), rt, {
      mainnet,
      optimism,
    });
    const getBalance = vi
      .spyOn(provider, "getWalletBalanceForChain")
      .mockImplementation(async (chain) => (chain === "mainnet" ? "1.25" : "0.5"));

    await expect(provider.getWalletBalances(true)).resolves.toEqual({
      mainnet: "1.25",
      optimism: "0.5",
    });
    expect(getCache).not.toHaveBeenCalled();
    expect(getBalance).toHaveBeenCalledTimes(2);
    expect(setCache).toHaveBeenCalledWith("evm/wallet/walletBalances", {
      mainnet: "1.25",
      optimism: "0.5",
    });
  });

  it("refuses a cached map that is missing a configured chain and refreshes from RPC (#31111)", async () => {
    const rt = runtime();
    // The poisoned map from #31111: written while optimism's RPC was down.
    vi.spyOn(rt, "getCache").mockResolvedValue({ mainnet: "5" });
    const deleteCache = vi.spyOn(rt, "deleteCache").mockResolvedValue(true);
    const setCache = vi.spyOn(rt, "setCache").mockResolvedValue(true);
    const provider = new WalletProvider(generatePrivateKey(), rt, {
      mainnet,
      optimism,
    });
    const getBalance = vi
      .spyOn(provider, "getWalletBalanceForChain")
      .mockImplementation(async (chain) => (chain === "mainnet" ? "5" : "0.5"));

    // Default (non-forced) read: the truncated entry must not be served.
    await expect(provider.getChainBalanceStates()).resolves.toEqual({
      mainnet: { status: "ok", balance: "5" },
      optimism: { status: "ok", balance: "0.5" },
    });
    expect(deleteCache).toHaveBeenCalledWith("evm/wallet/walletBalances");
    expect(getBalance).toHaveBeenCalledTimes(2);
    expect(setCache).toHaveBeenCalledWith("evm/wallet/walletBalances", {
      mainnet: "5",
      optimism: "0.5",
    });
  });

  it("clears an older snapshot when a live refresh has an unavailable chain", async () => {
    const rt = runtime();
    vi.spyOn(rt, "getCache").mockResolvedValue({ mainnet: "4", optimism: "0.4" });
    const deleteCache = vi.spyOn(rt, "deleteCache").mockResolvedValue(true);
    const setCache = vi.spyOn(rt, "setCache").mockResolvedValue(true);
    const provider = new WalletProvider(generatePrivateKey(), rt, {
      mainnet,
      optimism,
    });
    vi.spyOn(provider, "getWalletBalanceForChain").mockImplementation(async (chain) => {
      if (chain === "optimism") throw new Error("503 Service Unavailable");
      return "5";
    });

    const states = await provider.getChainBalanceStates(true);
    expect(states.optimism).toEqual({ status: "unavailable", error: "503 Service Unavailable" });
    expect(deleteCache).toHaveBeenCalledWith("evm/wallet/walletBalances");
    expect(setCache).not.toHaveBeenCalled();
  });

  it("reports an unreachable chain as unavailable and never caches the partial snapshot (#31111)", async () => {
    const rt = runtime();
    const setCache = vi.spyOn(rt, "setCache").mockResolvedValue(true);
    vi.spyOn(rt, "getCache").mockResolvedValue(undefined);
    vi.spyOn(rt, "deleteCache").mockResolvedValue(true);
    const provider = new WalletProvider(generatePrivateKey(), rt, {
      mainnet,
      optimism,
    });
    let optimismDown = true;
    vi.spyOn(provider, "getWalletBalanceForChain").mockImplementation(async (chain) => {
      if (chain === "optimism" && optimismDown) {
        throw new Error("HTTP request failed: 503 Service Unavailable");
      }
      return chain === "mainnet" ? "5" : "0.5";
    });

    await expect(provider.getChainBalanceStates()).resolves.toEqual({
      mainnet: { status: "ok", balance: "5" },
      optimism: {
        status: "unavailable",
        error: "HTTP request failed: 503 Service Unavailable",
      },
    });
    // The balances view omits the chain but a partial map is never cached.
    await expect(provider.getWalletBalances()).resolves.toEqual({ mainnet: "5" });
    expect(setCache).not.toHaveBeenCalled();

    // Once the RPC answers again the next read sees it (no stale "absent").
    optimismDown = false;
    await expect(provider.getWalletBalances()).resolves.toEqual({
      mainnet: "5",
      optimism: "0.5",
    });
    expect(setCache).toHaveBeenCalledWith("evm/wallet/walletBalances", {
      mainnet: "5",
      optimism: "0.5",
    });
  });

  it("creates a configured local provider from runtime settings", async () => {
    const rt = runtime();
    const key = generatePrivateKey();
    rt.character.settings = {
      ...rt.character.settings,
      secrets: { EVM_PRIVATE_KEY: key },
    };

    const provider = await initWalletProvider(rt);

    expect(provider).toBeInstanceOf(WalletProvider);
    expect(provider.getAddress()).toBe(privateKeyToAccount(key).address);
    expect(provider.getSupportedChains()).toEqual(["mainnet"]);
  });

  it("rejects TEE mode without the required wallet salt", async () => {
    const rt = runtime();
    vi.spyOn(rt, "getSetting").mockImplementation((key) => (key === "TEE_MODE" ? "ON" : undefined));

    await expect(initWalletProvider(rt)).rejects.toThrow("WALLET_SECRET_SALT required");
  });

  it("initializes a TEE wallet once and reuses the derived account", async () => {
    const rt = runtime();
    rt.character.settings = {
      ...rt.character.settings,
      chains: { evm: ["not-a-chain"] },
    };
    const key = generatePrivateKey();
    const deriveEcdsaKeypair = vi.fn().mockResolvedValue({ keypair: key, attestation: {} });
    vi.spyOn(rt, "getSetting").mockImplementation((name) => {
      if (name === "TEE_MODE") return "ON";
      if (name === "WALLET_SECRET_SALT") return "wallet-test";
      return undefined;
    });
    vi.spyOn(rt, "getService").mockReturnValue({
      deriveEcdsaKeypair,
    } as never);
    vi.spyOn(rt, "getCache").mockResolvedValue(undefined);
    vi.spyOn(rt, "setCache").mockResolvedValue(true);

    const provider = await initWalletProvider(rt);
    expect(() => provider.getAddress()).toThrow("TEE wallet not initialized");
    await expect(provider.getWalletBalances()).resolves.toEqual({});
    await expect(provider.getWalletBalances()).resolves.toEqual({});
    expect(provider.getAddress()).toBe(privateKeyToAccount(key).address);
    expect(deriveEcdsaKeypair).toHaveBeenCalledOnce();
  });

  it("surfaces a missing TEE service at the first async wallet operation", async () => {
    const rt = runtime();
    vi.spyOn(rt, "getSetting").mockImplementation((name) => {
      if (name === "TEE_MODE") return "ON";
      if (name === "WALLET_SECRET_SALT") return "wallet-test";
      return undefined;
    });

    const provider = await initWalletProvider(rt);
    await expect(provider.getWalletBalances()).rejects.toThrow("TEE service not found");
  });
});

describe("evmWalletProvider prompt context", () => {
  it("reports an explicit unavailable state when the service is absent", async () => {
    const rt = runtime();

    const result = await evmWalletProvider.get(rt, message, state);

    expect(result.text).toContain("EVM service is not available");
    expect(result.values).toMatchObject({
      walletReady: false,
      walletError: "EVMError",
    });
  });

  it("reports an explicit unavailable state when the service has no cache boundary", async () => {
    const rt = runtime();
    vi.spyOn(rt, "getService").mockReturnValue({} as never);

    const result = await evmWalletProvider.get(rt, message, state);

    expect(result.text).toContain("does not expose its wallet cache");
    expect(result.values).toMatchObject({
      walletReady: false,
      walletError: "EVMError",
    });
  });

  it("returns immediately with loading state while the cache is cold", async () => {
    const rt = runtime();
    const service = new EVMService(rt);
    vi.spyOn(service, "getCachedData").mockResolvedValue(undefined);
    vi.spyOn(rt, "getService").mockReturnValue(service);

    const result = await evmWalletProvider.get(rt, message, state);

    expect(result.data).toEqual({ status: "loading" });
    expect(result.values).toMatchObject({
      walletReady: false,
      walletStatus: "loading",
    });
  });

  it("preserves every rendered balance and reports the complete chain count", async () => {
    const rt = runtime();
    const service = new EVMService(rt);
    const chains = Array.from({ length: 24 }, (_, index) => ({
      name: `Chain ${index}`,
      balance: String(index),
      symbol: `C${index}`,
    }));
    vi.spyOn(service, "getCachedData").mockResolvedValue({
      address: "0x1234",
      chains: chains.map((chain, index) => ({
        ...chain,
        chainName: `chain-${index}`,
        chainId: index,
      })),
      timestamp: Date.now(),
    });
    vi.spyOn(rt, "getService").mockImplementation((name) =>
      name === EVM_SERVICE_NAME ? service : null
    );

    const result = await evmWalletProvider.get(rt, message, state);

    expect(result.data).toMatchObject({
      address: "0x1234",
      chainCount: 24,
      displayedChainCount: 24,
    });
    expect(result.text).toContain("Chain 23: 23 C23");
  });
});
