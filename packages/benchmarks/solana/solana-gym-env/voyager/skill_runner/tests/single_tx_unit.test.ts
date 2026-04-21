import { describe, test, expect, beforeEach } from "bun:test";

// Mock the surfpoolEnv to test transaction counting
describe("Single Transaction Unit Tests", () => {
    let transactionCount: number;
    let mockEnv: any;

    beforeEach(() => {
        transactionCount = 0;
        mockEnv = {
            simulateTransaction: async () => {
                transactionCount++;
                if (transactionCount > 1) {
                    throw new Error(
                        "SINGLE_TRANSACTION_LIMIT: Skills can only execute ONE transaction. " +
                        "To perform multiple operations, create separate skills and chain them. " +
                        "This transaction attempt was blocked."
                    );
                }
                return JSON.stringify({
                    transaction: { message: { accountKeys: [], instructions: [] } },
                    meta: { err: null, logMessages: ["Simulated transaction log"] }
                });
            },
            getWallet: () => ({ balances: [2.5, 100.0, 0.0, 0.0, 0.0], publicKey: "mock-wallet" })
        };
    });

    test("single transaction succeeds", async () => {
        const skill = async (env: any) => {
            const receipt = await env.simulateTransaction();
            return [1.0, "success", receipt];
        };

        const [reward, reason, receipt] = await skill(mockEnv);
        expect(reward).toBe(1.0);
        expect(reason).toBe("success");
        expect(receipt).toBeTruthy();
    });

    test("multiple transactions throw error", async () => {
        const skill = async (env: any) => {
            const receipt1 = await env.simulateTransaction();
            const receipt2 = await env.simulateTransaction(); // Should throw
            return [1.0, "success", receipt2];
        };

        try {
            await skill(mockEnv);
            expect(true).toBe(false); // Should not reach here
        } catch (error: any) {
            expect(error.message).toContain("SINGLE_TRANSACTION_LIMIT");
            expect(error.message).toContain("create separate skills");
        }
    });

    test("transaction counter resets between executions", async () => {
        const skill = async (env: any) => {
            const receipt = await env.simulateTransaction();
            return [1.0, "success", receipt];
        };

        // First execution
        transactionCount = 0; // Reset counter
        const result1 = await skill(mockEnv);
        expect(result1[0]).toBe(1.0);

        // Second execution
        transactionCount = 0; // Reset counter
        const result2 = await skill(mockEnv);
        expect(result2[0]).toBe(1.0);
    });
});