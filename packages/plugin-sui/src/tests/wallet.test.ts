import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { WalletProvider } from "../providers/wallet.ts";

import { defaultCharacter } from "@elizaos/core";
import BigNumber from "bignumber.js";
import { SUI_DECIMALS } from "@mysten/sui/utils";
import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
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
    let walletProvider;
    let mockedRuntime;

    beforeEach(() => {
        vi.clearAllMocks();
        mockCacheManager.get.mockResolvedValue(null);

        const suiClient = new SuiClient({
            url: getFullnodeUrl("testnet"),
        });

        const suiAccount = Ed25519Keypair.deriveKeypair(
            // 0x69c67de128b241be288d6f3f7d898f0ffb6c1976879b721e68e7b156dd419e3f
            "gaze throw also reveal kite load tennis tone club cloth chaos picture"
        );

        const suiAccountx = Ed25519Keypair.fromSecretKey(
            "suiprivkey1qzuw2uvhqz330pwl94rv39jvk93kuvfd4pvdkw9vl922kum80prqvxtlntr"
        );

        console.log(suiAccountx.toSuiAddress());

        // Create new instance of TokenProvider with mocked dependencies
        walletProvider = new WalletProvider(
            suiClient,
            suiAccount.toSuiAddress(),
            mockCacheManager
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
            const mistAmountOnChain = await walletProvider.suiClient.getBalance(
                {
                    owner: walletProvider.address,
                }
            );

            const suiAmount = new BigNumber(mistAmountOnChain.totalBalance)
                .div(new BigNumber(10).pow(SUI_DECIMALS))
                .toFixed(4);
            const totalUsd = new BigNumber(suiAmount)
                .times(prices.sui.usd)
                .toFixed(2);

            expect(result).toEqual(
                `Eliza\nWallet Address: ${walletProvider.address}\n` +
                    `Total Value: $${totalUsd} (${suiAmount} SUI)\n`
            );
        });
    });
});
