import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Account, Chain } from "viem";

import { TransferAction } from "../actions/transfer";
import { WalletProvider } from "../providers/wallet";
import { seiDevnet } from "viem/chains";

// Mock the ICacheManager
const mockCacheManager = {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn(),
};

describe("Transfer Action", () => {
    let wp: WalletProvider;

    beforeEach(async () => {
        vi.clearAllMocks();
        mockCacheManager.get.mockResolvedValue(null);

        const pk = generatePrivateKey();
        const chain = seiDevnet
        const chainWithName = {name: "devnet", chain: chain}
        wp = new WalletProvider(pk, mockCacheManager as any, chainWithName);
    });

    afterEach(() => {
        vi.clearAllTimers();
    });

    describe("Constructor", () => {
        it("should initialize with wallet provider", () => {
            const ta = new TransferAction(wp);

            expect(ta).toBeDefined();
        });
    });
    describe("Transfer", () => {
        let ta: TransferAction;
        let receiver: Account;

        beforeEach(() => {
            ta = new TransferAction(wp);
            receiver = privateKeyToAccount(generatePrivateKey());
        });

        it("throws if not enough gas", async () => {
            await expect(
                ta.transfer({
                    toAddress: receiver.address,
                    amount: "1",
                })
            ).rejects.toThrow(
                "Transfer failed: The total cost (gas * gas fee + value) of executing this transaction exceeds the balance of the account."
            );
        });
    });
});
