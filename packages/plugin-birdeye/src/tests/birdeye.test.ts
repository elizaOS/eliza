import NodeCache from "node-cache";
import { ICacheManager } from "@elizaos/core";
import { BirdeyeProvider } from "../providers/birdeye";

import { describe, it, expect, beforeEach, afterEach, vi, Mock } from "vitest";


describe("BirdeyeProvider", () => {
    describe("basic fetching", () => {
        let cacheManager: ICacheManager;
        let provider: BirdeyeProvider;

        beforeEach(() => {
            cacheManager = {
                get: vi.fn(),
                set: vi.fn(),
            } as unknown as ICacheManager;
            provider = new BirdeyeProvider(cacheManager);
            global.fetch = vi.fn();
        });

        afterEach(() => {
            vi.clearAllMocks();
        });

        it("should fetch price by symbol", async () => {
            const mockResponse = { price: 100 };
            (fetch as Mock).mockResolvedValue({
                ok: true,
                json: async () => mockResponse,
            });

            const result = await provider.fetchPriceBySymbol("SOL");

            expect(result).toEqual(mockResponse);
            expect(fetch).toHaveBeenCalledWith(
                "https://public-api.birdeye.so/defi/price?address=So11111111111111111111111111111111111111112",
                expect.any(Object)
            );
        });

        it("should fetch token security by symbol", async () => {
            const mockResponse = { security: "secure" };
            (fetch as Mock).mockResolvedValue({
                ok: true,
                json: async () => mockResponse,
            });

            const result = await provider.fetchTokenSecurityBySymbol("SOL");

            expect(result).toEqual(mockResponse);
            expect(fetch).toHaveBeenCalledWith(
                "https://public-api.birdeye.so/defi/token_security?address=So11111111111111111111111111111111111111112",
                expect.any(Object)
            );
        });

        it("should fetch token trade data by symbol", async () => {
            const mockResponse = { volume: 1000 };
            (fetch as Mock).mockResolvedValue({
                ok: true,
                json: async () => mockResponse,
            });

            const result = await provider.fetchTokenTradeDataBySymbol("SOL");

            expect(result).toEqual(mockResponse);
            expect(fetch).toHaveBeenCalledWith(
                "https://public-api.birdeye.so/defi/v3/token/trade-data/single?address=So11111111111111111111111111111111111111112",
                expect.any(Object)
            );
        });

        it("should fetch wallet portfolio", async () => {
            const mockResponse = { portfolio: [] };
            (fetch as Mock).mockResolvedValue({
                ok: true,
                json: async () => mockResponse,
            });

            const result = await provider.fetchWalletPortfolio(
                "some-wallet-address"
            );

            expect(result).toEqual(mockResponse);
            expect(fetch).toHaveBeenCalledWith(
                "https://public-api.birdeye.so/v1/wallet/token_list?wallet=some-wallet-address",
                expect.any(Object)
            );
        });
    });

    describe("retries options", () => {
        let cacheManager: ICacheManager;
        let provider: BirdeyeProvider;

        beforeEach(() => {
            cacheManager = {
                get: vi.fn(),
                set: vi.fn(),
            } as unknown as ICacheManager;
            provider = new BirdeyeProvider(cacheManager);
            global.fetch = vi.fn();
        });

        afterEach(() => {
            vi.clearAllMocks();
        });

        it("should retry fetch on failure and succeed", async () => {
            const mockResponse = { price: 100 };
            (fetch as Mock)
                .mockRejectedValueOnce(new Error("Network error")) // First attempt fails
                .mockResolvedValueOnce({
                    ok: true,
                    json: async () => mockResponse,
                }); // Second attempt succeeds

            const result = await provider.fetchPriceBySymbol("SOL");

            expect(result).toEqual(mockResponse);
            expect(fetch).toHaveBeenCalledTimes(2); // Ensure it retried
        });

        it("should fail after max retries", async () => {
            const error = new Error("Network error");
            (fetch as Mock)
                .mockRejectedValueOnce(error)
                .mockRejectedValueOnce(error) // Second attempt fails
                .mockRejectedValueOnce(error); // Third attempt also fails

            await expect(provider.fetchPriceBySymbol("SOL")).rejects.toThrow(
                "Network error"
            );

            expect(fetch).toHaveBeenCalledTimes(3); // Ensure it retried
        });
    });

    describe("with custom symbols", () => {
        let cacheManager: ICacheManager;
        let provider: BirdeyeProvider;

        beforeEach(() => {
            cacheManager = {
                get: vi.fn(),
                set: vi.fn(),
            } as unknown as ICacheManager;
            provider = new BirdeyeProvider(cacheManager, {
                WETH: "0x32323232323232",
            });
            global.fetch = vi.fn();
        });

        it("should fetch price for a custom symbol WETH", async () => {
            const mockResponse = { price: 2000 };
            (fetch as Mock).mockResolvedValue({
                ok: true,
                json: async () => mockResponse,
            });

            const result = await provider.fetchPriceBySymbol("WETH");

            expect(result).toEqual(mockResponse);
            expect(fetch).toHaveBeenCalledWith(
                "https://public-api.birdeye.so/defi/price?address=0x32323232323232",
                expect.any(Object)
            );
        });

        it("should fetch token security for a custom symbol WETH", async () => {
            const mockResponse = { security: "secure" };
            (fetch as Mock).mockResolvedValue({
                ok: true,
                json: async () => mockResponse,
            });

            const result = await provider.fetchTokenSecurityBySymbol("WETH");

            expect(result).toEqual(mockResponse);
            expect(fetch).toHaveBeenCalledWith(
                "https://public-api.birdeye.so/defi/token_security?address=0x32323232323232",
                expect.any(Object)
            );
        });

        it("should fetch token trade data for a custom symbol WETH", async () => {
            const mockResponse = { volume: 500 };
            (fetch as Mock).mockResolvedValue({
                ok: true,
                json: async () => mockResponse,
            });

            const result = await provider.fetchTokenTradeDataBySymbol("WETH");

            expect(result).toEqual(mockResponse);
            expect(fetch).toHaveBeenCalledWith(
                "https://public-api.birdeye.so/defi/v3/token/trade-data/single?address=0x32323232323232",
                expect.any(Object)
            );
        });
    });

    describe("with cache", () => {
        let cacheManager: ICacheManager;
        let provider: BirdeyeProvider;
        let nodeCache: NodeCache;

        beforeEach(() => {
            nodeCache = new NodeCache();
            cacheManager = {
                get: vi.fn(),
                set: vi.fn(),
            } as unknown as ICacheManager;

            provider = new BirdeyeProvider(cacheManager);
            provider["cache"] = nodeCache; // Directly set the node cache
            global.fetch = vi.fn();
        });

        afterEach(() => {
            vi.clearAllMocks();
            nodeCache.flushAll();
        });

        it("should use memory cache when fetching price by symbol", async () => {
            const mockResponse = { price: 100 };
            nodeCache.set(
                "price/So11111111111111111111111111111111111111112",
                mockResponse
            ); // Pre-fill cache

            const result = await provider.fetchPriceBySymbol("SOL");

            expect(result).toEqual(mockResponse);
            expect(fetch).not.toHaveBeenCalled();
        });

        it("should fetch and cache price by symbol", async () => {
            const mockResponse = { price: 100 };
            (fetch as Mock).mockResolvedValue({
                ok: true,
                json: async () => mockResponse,
            });

            // First call - should fetch and cache the result
            const result1 = await provider.fetchPriceBySymbol("SOL");
            expect(result1).toEqual(mockResponse);
            expect(fetch).toHaveBeenCalledTimes(1);

            // Second call - should use cache
            const result2 = await provider.fetchPriceBySymbol("SOL");
            expect(result2).toEqual(mockResponse);
            expect(fetch).toHaveBeenCalledTimes(1); // No additional fetch call
        });

        it("should use file system cache when fetching price by symbol", async () => {
            const mockResponse = { price: 100 };
            (cacheManager.get as Mock).mockResolvedValue(mockResponse);

            // Memory cache miss, should use file system cache
            const result = await provider.fetchPriceBySymbol("SOL");
            expect(result).toEqual(mockResponse);
            expect(fetch).not.toHaveBeenCalled();
        });

        it("should fetch and cache price by symbol using file system cache", async () => {
            const mockResponse = { price: 100 };
            (fetch as Mock).mockResolvedValue({
                ok: true,
                json: async () => mockResponse,
            });
            (cacheManager.get as Mock).mockResolvedValue(null); // File system cache miss

            // First call - should fetch and cache the result
            const result1 = await provider.fetchPriceBySymbol("SOL");
            expect(result1).toEqual(mockResponse);
            expect(fetch).toHaveBeenCalledTimes(1);
            expect(cacheManager.set).toHaveBeenCalledWith(
                expect.stringContaining(
                    "birdeye/data/price/So11111111111111111111111111111111111111112"
                ),
                mockResponse,
                expect.any(Object)
            );

            // Second call - should use cache
            const result2 = await provider.fetchPriceBySymbol("SOL");
            expect(result2).toEqual(mockResponse);
            expect(fetch).toHaveBeenCalledTimes(1); // No additional fetch call
        });
    });
});
