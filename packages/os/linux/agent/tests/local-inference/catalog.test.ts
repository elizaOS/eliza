// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

import { describe, expect, test } from "bun:test";

import {
    BASELINE_EMBEDDING_ID,
    BASELINE_MODEL_ID,
    MODEL_CATALOG,
    buildHuggingFaceResolveUrl,
    findCatalogModel,
    findDflashDrafter,
    pickEligibleTiers,
} from "../../src/local-inference/catalog.ts";

describe("catalog invariants", () => {
    test("every entry has a publicly resolvable HF repo (shape check)", () => {
        for (const model of MODEL_CATALOG) {
            expect(model.hfRepo).toMatch(/^[^/]+\/[^/]+$/);
            expect(model.ggufFile.length).toBeGreaterThan(0);
            expect(model.sizeGb).toBeGreaterThan(0);
            expect(model.minRamGb).toBeGreaterThanOrEqual(0.5);
        }
    });

    test("the baseline tier exists", () => {
        const baseline = findCatalogModel(BASELINE_MODEL_ID);
        expect(baseline).toBeDefined();
        expect(baseline?.category).toBe("chat");
        expect(baseline?.bucket).toBe("small");
    });

    test("the baseline embedding exists", () => {
        const emb = findCatalogModel(BASELINE_EMBEDDING_ID);
        expect(emb).toBeDefined();
        expect(emb?.category).toBe("embedding");
    });

    test("ids are unique", () => {
        const ids = new Set(MODEL_CATALOG.map((m) => m.id));
        expect(ids.size).toBe(MODEL_CATALOG.length);
    });

    test("no entry uses the gated elizaos/eliza-1-* repos", () => {
        for (const model of MODEL_CATALOG) {
            expect(model.hfRepo).not.toMatch(/^elizaos\/eliza-1-/);
        }
    });
});

describe("buildHuggingFaceResolveUrl", () => {
    test("returns a public huggingface.co resolve URL by default", () => {
        const llama = findCatalogModel("tiny-1b");
        if (llama === undefined) throw new Error("tiny-1b missing");
        const url = buildHuggingFaceResolveUrl(llama);
        expect(url).toContain("https://huggingface.co/");
        expect(url).toContain("/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/");
        expect(url).toContain("Llama-3.2-1B-Instruct-Q4_K_M.gguf");
        expect(url).toContain("?download=true");
    });

    test("USBELIZA_HF_BASE_URL overrides the host", () => {
        const original = process.env.USBELIZA_HF_BASE_URL;
        process.env.USBELIZA_HF_BASE_URL = "http://localhost:8080/hf";
        const m = findCatalogModel("drafter-0_6b");
        if (m === undefined) throw new Error("drafter-0_6b missing");
        const url = buildHuggingFaceResolveUrl(m);
        expect(url.startsWith("http://localhost:8080/hf/")).toBe(true);
        if (original !== undefined) {
            process.env.USBELIZA_HF_BASE_URL = original;
        } else {
            delete process.env.USBELIZA_HF_BASE_URL;
        }
    });
});

describe("pickEligibleTiers", () => {
    test("8 GB host gets baseline + drafter + mid-7b (mid-7b minRam=8, +4 headroom > 8 → hidden)", () => {
        // Actually 8 GB host: 8 < (8+4) so mid-7b filtered out. Only tiny-1b survives.
        const tiers = pickEligibleTiers(8);
        const ids = tiers.map((t) => t.id);
        expect(ids).toContain("tiny-1b");
        expect(ids).not.toContain("mid-7b"); // needs 12 GB total
        expect(ids).not.toContain("dflash-9b");
    });

    test("16 GB host gets mid-7b + dflash-9b + tiny-1b", () => {
        const tiers = pickEligibleTiers(16);
        const ids = tiers.map((t) => t.id);
        expect(ids).toContain("dflash-9b"); // needs 12+4=16 — exactly fits
        expect(ids).toContain("mid-7b");
        expect(ids).toContain("tiny-1b");
        expect(ids).not.toContain("heavy-32b"); // needs 32+4=36
    });

    test("32 GB Lunar Lake host gets everything but heavy-32b filtered", () => {
        // heavy-32b minRam=32, +4 = 36 → host needs ≥36 to surface it.
        const tiers = pickEligibleTiers(32);
        const ids = tiers.map((t) => t.id);
        expect(ids).toContain("dflash-9b");
        expect(ids).toContain("mid-7b");
        expect(ids).not.toContain("heavy-32b");
    });

    test("64 GB workstation gets every chat tier including heavy", () => {
        const tiers = pickEligibleTiers(64);
        const ids = tiers.map((t) => t.id);
        expect(ids).toContain("heavy-32b");
        expect(ids).toContain("dflash-9b");
        expect(ids).toContain("mid-7b");
        expect(ids).toContain("tiny-1b");
    });

    test("filters out embedding tier (not a chat model)", () => {
        const tiers = pickEligibleTiers(32);
        for (const t of tiers) {
            expect(t.category).toBe("chat");
        }
    });

    test("always includes baseline tiny-1b even on very-low-RAM hosts (2 GB)", () => {
        // tiny-1b minRam=2; 2+4=6 > 2 so strict filter would drop it.
        // The catalog injects baseline as a fallback.
        const tiers = pickEligibleTiers(2);
        const ids = tiers.map((t) => t.id);
        expect(ids).toContain("tiny-1b");
    });

    test("returns tiers sorted largest-first", () => {
        const tiers = pickEligibleTiers(64);
        for (let i = 1; i < tiers.length; i++) {
            const prev = tiers[i - 1];
            const cur = tiers[i];
            if (prev === undefined || cur === undefined) continue;
            expect(prev.minRamGb).toBeGreaterThanOrEqual(cur.minRamGb);
        }
    });
});

describe("findDflashDrafter", () => {
    test("dflash-9b returns drafter-0_6b", () => {
        const target = findCatalogModel("dflash-9b");
        if (target === undefined) throw new Error("dflash-9b missing");
        const drafter = findDflashDrafter(target);
        expect(drafter?.id).toBe("drafter-0_6b");
    });

    test("non-DFlash tier returns undefined", () => {
        const target = findCatalogModel("mid-7b");
        if (target === undefined) throw new Error("mid-7b missing");
        expect(findDflashDrafter(target)).toBeUndefined();
    });

    test("dflash drafter+target share the same tokenizer family", () => {
        const target = findCatalogModel("dflash-9b");
        const drafter = findCatalogModel("drafter-0_6b");
        expect(target?.tokenizerFamily).toBe("qwen3");
        expect(drafter?.tokenizerFamily).toBe("qwen3");
    });
});
