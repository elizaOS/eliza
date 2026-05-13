// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

import { describe, expect, test } from "bun:test";

import {
    formatPickResultForChat,
    recommendModelTierFor,
} from "../../src/local-inference/picker.ts";

describe("recommendModelTierFor", () => {
    test("32 GB Lunar Lake gets the Qwen3.5-9B DFlash recommendation", () => {
        const result = recommendModelTierFor(32);
        expect(result.recommended.id).toBe("dflash-9b");
        expect(result.drafter).toBeDefined();
        expect(result.drafter?.id).toBe("drafter-0_6b");
        expect(result.hostRamGb).toBe(32);
    });

    test("16 GB host also gets dflash-9b (exactly fits at minRam+headroom)", () => {
        const result = recommendModelTierFor(16);
        expect(result.recommended.id).toBe("dflash-9b");
    });

    test("12 GB host falls to mid-7b (dflash-9b minRam+headroom=16 too high)", () => {
        const result = recommendModelTierFor(12);
        expect(result.recommended.id).toBe("mid-7b");
        // mid-7b is not a DFlash tier → no drafter
        expect(result.drafter).toBeUndefined();
    });

    test("8 GB host falls to tiny-1b baseline", () => {
        const result = recommendModelTierFor(8);
        expect(result.recommended.id).toBe("tiny-1b");
    });

    test("4 GB low-end laptop still gets the baseline (drafter alone needs 2)", () => {
        const result = recommendModelTierFor(4);
        expect(result.recommended.id).toBe("tiny-1b");
        expect(result.alternatives).toEqual([]);
    });

    test("64 GB workstation gets heavy-32b as top pick", () => {
        const result = recommendModelTierFor(64);
        expect(result.recommended.id).toBe("heavy-32b");
        // alternatives include dflash-9b, mid-7b, tiny-1b
        const altIds = result.alternatives.map((a) => a.id);
        expect(altIds).toContain("dflash-9b");
        expect(altIds).toContain("mid-7b");
        expect(altIds).toContain("tiny-1b");
    });
});

describe("formatPickResultForChat", () => {
    test("renders a complete pick result with drafter + alternatives", () => {
        const result = recommendModelTierFor(32);
        const text = formatPickResultForChat(result);
        expect(text).toContain("32 GB of RAM");
        expect(text).toContain("Qwen3.5 9B DFlash");
        expect(text).toContain("Qwen3 0.6B");
        expect(text).toContain("speculative-decoding drafter");
        expect(text).toContain("Alternatives:");
    });

    test("renders a baseline-only result (no alternatives, no drafter)", () => {
        const result = recommendModelTierFor(4);
        const text = formatPickResultForChat(result);
        expect(text).toContain("4 GB of RAM");
        expect(text).toContain("Llama-3.2 1B");
        expect(text).not.toContain("speculative-decoding drafter");
        expect(text).not.toContain("Alternatives:");
    });
});
