import { describe, expect, it } from "vitest";
import { Chain, verifyAndAttestOnChain } from "../dcap";
import { DEFAULT_QUOTE } from "../quote";

const privateKey =
    "0xc4389080437072a09215803a6b540f1e054797eeda2eec6d49076760d48e7589";
const chain = Chain.Testnet.AUTOMATA;

describe("Verify rawQuote", () => {
    it("should verify rawQuote", async () => {
        const tx = await verifyAndAttestOnChain(
            privateKey,
            DEFAULT_QUOTE,
            chain
        );
        expect(tx).toBeDefined();
    });
});

describe("Verify random hex will fail", () => {
    it("should not verify random hex", async () => {
        await expect(
            verifyAndAttestOnChain(privateKey, "0x1234", chain)
        ).rejects.toThrow();
    });
});
