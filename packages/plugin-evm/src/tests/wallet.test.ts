import { describe, it, expect, beforeAll, beforeEach, vi, afterEach } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { mainnet, iotex, arbitrum, Chain } from "viem/chains";

import { WalletProvider } from "../providers/wallet";

const customRpcUrls = {
    mainnet: "custom-rpc.mainnet.io",
    arbitrum: "custom-rpc.base.io",
    iotex: "custom-rpc.iotex.io",
};

// Mock the ICacheManager
const mockCacheManager = {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn(),
};


describe("Wallet provider", () => {
    let walletProvider: WalletProvider;
    let pk: `0x${string}`;
    const customChains: Record<string, Chain> = {};

    beforeAll(() => {
        pk = generatePrivateKey();

        const chainNames = ["iotex", "arbitrum"];
        chainNames.forEach(
            (chain) =>
                (customChains[chain] = WalletProvider.genChainFromName(chain))
        );
    });

    afterEach(() => {
        vi.clearAllTimers();
    });

    beforeEach(() => {
        vi.clearAllMocks();
        mockCacheManager.get.mockResolvedValue(null);
    });

    describe("Constructor", () => {
        it("sets address", () => {
            const account = privateKeyToAccount(pk);
            const expectedAddress = account.address;

            walletProvider = new WalletProvider(pk, mockCacheManager as any);

            expect(walletProvider.getAddress()).toEqual(expectedAddress);
        });
        it("sets default chain to ethereum mainnet", () => {
            walletProvider = new WalletProvider(pk, mockCacheManager as any);

            expect(walletProvider.chains.mainnet.id).toEqual(mainnet.id);
            expect(walletProvider.getCurrentChain().id).toEqual(mainnet.id);
        });
        it("sets custom chains", () => {
            walletProvider = new WalletProvider(pk, mockCacheManager as any, customChains);

            expect(walletProvider.chains.iotex.id).toEqual(iotex.id);
            expect(walletProvider.chains.arbitrum.id).toEqual(arbitrum.id);
        });
        it("sets the first provided custom chain as current chain", () => {
            walletProvider = new WalletProvider(pk, mockCacheManager as any, customChains);

            expect(walletProvider.getCurrentChain().id).toEqual(iotex.id);
        });
    });
    describe("Clients", () => {
        beforeEach(() => {
            walletProvider = new WalletProvider(pk, mockCacheManager as any);
        });
        it("generates public client", () => {
            const client = walletProvider.getPublicClient("mainnet");
            expect(client.chain.id).toEqual(mainnet.id);
            expect(client.transport.url).toEqual(
                mainnet.rpcUrls.default.http[0]
            );
        });
        it("generates public client with custom rpcurl", () => {
            const chain = WalletProvider.genChainFromName(
                "mainnet",
                customRpcUrls.mainnet
            );
            const wp = new WalletProvider(pk, mockCacheManager as any, { ["mainnet"]: chain });

            const client = wp.getPublicClient("mainnet");
            expect(client.chain.id).toEqual(mainnet.id);
            expect(client.chain.rpcUrls.default.http[0]).toEqual(
                mainnet.rpcUrls.default.http[0]
            );
            expect(client.chain.rpcUrls.custom.http[0]).toEqual(
                customRpcUrls.mainnet
            );
            expect(client.transport.url).toEqual(customRpcUrls.mainnet);
        });
        it("generates wallet client", () => {
            const account = privateKeyToAccount(pk);
            const expectedAddress = account.address;

            const client = walletProvider.getWalletClient("mainnet");

            expect(client.account.address).toEqual(expectedAddress);
            expect(client.transport.url).toEqual(
                mainnet.rpcUrls.default.http[0]
            );
        });
        it("generates wallet client with custom rpcurl", () => {
            const account = privateKeyToAccount(pk);
            const expectedAddress = account.address;
            const chain = WalletProvider.genChainFromName(
                "mainnet",
                customRpcUrls.mainnet
            );
            const wp = new WalletProvider(pk, mockCacheManager as any, { ["mainnet"]: chain });

            const client = wp.getWalletClient("mainnet");

            expect(client.account.address).toEqual(expectedAddress);
            expect(client.chain.id).toEqual(mainnet.id);
            expect(client.chain.rpcUrls.default.http[0]).toEqual(
                mainnet.rpcUrls.default.http[0]
            );
            expect(client.chain.rpcUrls.custom.http[0]).toEqual(
                customRpcUrls.mainnet
            );
            expect(client.transport.url).toEqual(customRpcUrls.mainnet);
        });
    });
    describe("Balance", () => {
        beforeEach(() => {
            walletProvider = new WalletProvider(pk, mockCacheManager as any, customChains);
        });
        it("should fetch balance", async () => {
            const bal = await walletProvider.getWalletBalance();

            expect(bal).toEqual("0");
        });
        it("should fetch balance for a specific added chain", async () => {
            const bal = await walletProvider.getWalletBalanceForChain("iotex");

            expect(bal).toEqual("0");
        });
        it("should return null if chain is not added", async () => {
            const bal = await walletProvider.getWalletBalanceForChain("base");
            expect(bal).toBeNull();
        });
    });
    describe("Chain", () => {
        beforeEach(() => {
            walletProvider = new WalletProvider(pk, mockCacheManager as any, customChains);
        });
        it("generates chains from chain name", () => {
            const chainName = "iotex";
            const chain: Chain = WalletProvider.genChainFromName(chainName);

            expect(chain.rpcUrls.default.http[0]).toEqual(
                iotex.rpcUrls.default.http[0]
            );
        });
        it("generates chains from chain name with custom rpc url", () => {
            const chainName = "iotex";
            const customRpcUrl = "custom.url.io";
            const chain: Chain = WalletProvider.genChainFromName(
                chainName,
                customRpcUrl
            );

            expect(chain.rpcUrls.default.http[0]).toEqual(
                iotex.rpcUrls.default.http[0]
            );
            expect(chain.rpcUrls.custom.http[0]).toEqual(customRpcUrl);
        });
        it("switches chain", () => {
            const initialChain = walletProvider.getCurrentChain().id;
            expect(initialChain).toEqual(iotex.id);

            walletProvider.switchChain("mainnet");

            const newChain = walletProvider.getCurrentChain().id;
            expect(newChain).toEqual(mainnet.id);
        });
        it("switches chain (by adding new chain)", () => {
            const initialChain = walletProvider.getCurrentChain().id;
            expect(initialChain).toEqual(iotex.id);

            walletProvider.switchChain("arbitrum");

            const newChain = walletProvider.getCurrentChain().id;
            expect(newChain).toEqual(arbitrum.id);
        });
        it("adds chain", () => {
            const initialChains = walletProvider.chains;
            expect(initialChains.base).toBeUndefined();

            const base = WalletProvider.genChainFromName("base");
            walletProvider.addChain({ base });
            const newChains = walletProvider.chains;
            expect(newChains.arbitrum.id).toEqual(arbitrum.id);
        });
        it("gets chain configs", () => {
            const chain = walletProvider.getChainConfigs("iotex");

            expect(chain.id).toEqual(iotex.id);
        });
        it("throws if tries to switch to an invalid chain", () => {
            const initialChain = walletProvider.getCurrentChain().id;
            expect(initialChain).toEqual(iotex.id);

            // intentionally set incorrect chain, ts will complain
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-ignore
            expect(() => walletProvider.switchChain("eth")).toThrow();
        });
        it("throws if unsupported chain name", () => {
            // intentionally set incorrect chain, ts will complain
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-ignore
            expect(() => WalletProvider.genChainFromName("ethereum")).toThrow();
        });
        it("throws if invalid chain name", () => {
            // intentionally set incorrect chain, ts will complain
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-ignore
            expect(() => WalletProvider.genChainFromName("eth")).toThrow();
        });
    });
});
