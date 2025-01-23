import { describe, it, expect, vi } from "vitest";

import { prepareAmbiguityErrorMessage } from "../actions/ibc-swap/services/ibc-swap-utils.ts";

vi.mock("chain-registry", () => ({
    assets: [
        {
            chain_name: "test-chain",
            assets: [
                {
                    symbol: "ATOM",
                    description: "Cosmos Hub token",
                    base: "atom-base",
                },
                {
                    symbol: "ATOM",
                    description: "Wrapped Cosmos token",
                    base: "wrapped-atom-base",
                },
            ],
        },
    ],
}));

describe("Utility Functions Tests", () => {
    describe("prepareAmbiguityErrorMessage", () => {
        it("should return an error message for ambiguous assets", () => {
            const result = prepareAmbiguityErrorMessage("ATOM", "test-chain");

            expect(result).toContain("Error occured. Swap was not performed.");
            expect(result).toContain("ATOM");
            expect(result).toContain("test-chain");
            expect(result).toContain(
                "Symbol: ATOM Desc: Cosmos Hub token Denom: atom-base"
            );
            expect(result).toContain(
                "Symbol: ATOM Desc: Wrapped Cosmos token Denom: wrapped-atom-base"
            );
        });
    });
});
