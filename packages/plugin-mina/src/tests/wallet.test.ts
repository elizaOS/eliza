import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { WalletProvider } from "../providers/wallet.ts";

import { defaultCharacter } from "@elizaos/core";
import { PublicKey } from "o1js";
import { MINA_UNIT, USD_UNIT } from "../constants.ts";
import BigNumber from "bignumber.js";

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
        ...actual,
        join: vi.fn().mockImplementation((...args) => args.join("/")),
    };
});

// Mock the ICacheManager
const mockCacheManager = {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn(),
    delete: vi.fn(),
};

describe("WalletProvider", () => {
    let walletProvider: WalletProvider;
    let mockedRuntime;

    beforeEach(() => {
        vi.clearAllMocks();
        mockCacheManager.get.mockResolvedValue(null);

        const minaAccount = PublicKey.fromBase58(
            "B62qqLnFfhYvMkFD2nUeLX1bCHtDQH3edRVtvENtwAfn2KTCFxYRjtM",
        );

        // Create new instance of TokenProvider with mocked dependencies
        walletProvider = new WalletProvider(
            "devnet",
            minaAccount,
            mockCacheManager,
        );

        mockedRuntime = {
            character: defaultCharacter,
        };
    });

    afterEach(() => {
        vi.clearAllTimers();
    });

    describe("Wallet Integration", () => {
        it("should check wallet address", async () => {
            const result =
                await walletProvider.getFormattedPortfolio(mockedRuntime);

            const prices = await walletProvider.fetchPrices();
            const balance = await walletProvider.getBalance();

            const minaAmount = balance.div(MINA_UNIT);
            const usdPrice = Math.round(prices.mina.usd * USD_UNIT);
            const totalUsd = minaAmount.mul(usdPrice).div(USD_UNIT);

            expect(result).toEqual(
                `Eliza\nWallet Address: ${walletProvider.address}\n` +
                    `Total Value: $${new BigNumber(totalUsd.toString()).toFixed(2)} (${new BigNumber(minaAmount.toString()).toFixed(2)} MINA)\n`,
            );
        });
    });
});
