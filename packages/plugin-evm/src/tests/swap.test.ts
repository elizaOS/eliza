import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Account, Chain } from "viem";

import { WalletProvider } from "../providers/wallet";
import { SwapAction } from "../actions/swap";

// Mock the ICacheManager
const mockCacheManager = {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn(),
};

describe("Swap Action", () => {
    let wp: WalletProvider;

    beforeEach(async () => {
        vi.clearAllMocks();
        mockCacheManager.get.mockResolvedValue(null);

        const pk = generatePrivateKey();
        const customChains = prepareChains();
        wp = new WalletProvider(pk, mockCacheManager as any, customChains);
    });

    afterEach(() => {
        vi.clearAllTimers();
    });

    describe("Constructor", () => {
        it("should initialize with wallet provider", () => {
            const ta = new SwapAction(wp);

            expect(ta).toBeDefined();
        });
    });
    describe("Swap", () => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        let ta: SwapAction;
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        let receiver: Account;

        beforeEach(() => {
            ta = new SwapAction(wp);
            receiver = privateKeyToAccount(generatePrivateKey());
        });

        it("swap throws if not enough gas/tokens", async () => {
            const ta = new SwapAction(wp);
            await expect(
                ta.swap({
                    chain: "base",
                    fromToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
                    toToken: "0x4200000000000000000000000000000000000006",
                    amount: "100",
                    slippage: 0.5,
                })
            ).rejects.toThrow("Execution failed");
        });
    });
});

const prepareChains = () => {
    const customChains: Record<string, Chain> = {};
    const chainNames = ["base"];
    chainNames.forEach(
        (chain) =>
            (customChains[chain] = WalletProvider.genChainFromName(chain))
    );

    return customChains;
};
