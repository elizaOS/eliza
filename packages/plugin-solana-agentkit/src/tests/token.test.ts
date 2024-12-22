import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { TokenProvider } from "../providers/token.ts";

// Mock NodeCache
vi.mock("node-cache", () => {
    return {
        default: vi.fn().mockImplementation(() => ({
            set: vi.fn(),
            get: vi.fn().mockReturnValue(null),
        })),
    };
});

// Mock path module
vi.mock("path", async () => {
    const actual = await vi.importActual("path");
    return {
        ...(actual as any),
        join: vi.fn().mockImplementation((...args) => args.join("/")),
    };
});

// Mock the WalletProvider
const mockWalletProvider = {
    fetchPortfolioValue: vi.fn(),
};

// Mock the ICacheManager
const mockCacheManager = {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn(),
};

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe("TokenProvider", () => {
    let tokenProvider: TokenProvider;
    const TEST_TOKEN_ADDRESS = "2weMjPLLybRMMva1fM3U31goWWrCpF59CHWNhnCJ9Vyh";

    beforeEach(() => {
        vi.clearAllMocks();
        mockCacheManager.get.mockResolvedValue(null);

        // Create new instance of TokenProvider with mocked dependencies
        tokenProvider = new TokenProvider(
            TEST_TOKEN_ADDRESS,
            mockWalletProvider as any,
            mockCacheManager as any
        );
    });

    afterEach(() => {
        vi.clearAllTimers();
    });

    describe("Cache Management", () => {
        it("should use cached data when available", async () => {
            const mockData = { test: "data" };
            mockCacheManager.get.mockResolvedValueOnce(mockData);

            const result = await (tokenProvider as any).getCachedData(
                "test-key"
            );

            expect(result).toEqual(mockData);
            expect(mockCacheManager.get).toHaveBeenCalledTimes(1);
        });

        it("should write data to both caches", async () => {
            const testData = { test: "data" };

            await (tokenProvider as any).setCachedData("test-key", testData);

            expect(mockCacheManager.set).toHaveBeenCalledWith(
                expect.stringContaining("test-key"),
                testData,
                expect.any(Object)
            );
        });
    });

    describe("Wallet Integration", () => {
        it("should fetch tokens in wallet", async () => {
            const mockItems = [
                { symbol: "SOL", address: "address1" },
                { symbol: "BTC", address: "address2" },
            ];

            mockWalletProvider.fetchPortfolioValue.mockResolvedValueOnce({
                items: mockItems,
            });

            const result = await tokenProvider.getTokensInWallet({} as any);

            expect(result).toEqual(mockItems);
            expect(
                mockWalletProvider.fetchPortfolioValue
            ).toHaveBeenCalledTimes(1);
        });

        it("should find token in wallet by symbol", async () => {
            const mockItems = [
                { symbol: "SOL", address: "address1" },
                { symbol: "BTC", address: "address2" },
            ];

            mockWalletProvider.fetchPortfolioValue.mockResolvedValueOnce({
                items: mockItems,
            });

            const result = await tokenProvider.getTokenFromWallet(
                {} as any,
                "SOL"
            );

            expect(result).toBe("address1");
        });

        it("should return null for token not in wallet", async () => {
            mockWalletProvider.fetchPortfolioValue.mockResolvedValueOnce({
                items: [],
            });

            const result = await tokenProvider.getTokenFromWallet(
                {} as any,
                "NONEXISTENT"
            );

            expect(result).toBeNull();
        });
    });
});
