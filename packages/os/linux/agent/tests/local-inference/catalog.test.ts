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

    test("default local entries resolve from the Eliza Labs repo", () => {
        for (const model of MODEL_CATALOG) {
            expect(model.hfRepo).toBe("elizalabs/eliza-1");
        }
    });
});

describe("buildHuggingFaceResolveUrl", () => {
    test("returns a public huggingface.co resolve URL by default", () => {
        const model = findCatalogModel("eliza-1-0_8b");
        if (model === undefined) throw new Error("eliza-1-0_8b missing");
        const url = buildHuggingFaceResolveUrl(model);
        expect(url).toContain("https://huggingface.co/");
        expect(url).toContain("/elizalabs/eliza-1/resolve/main/");
        expect(url).toContain("bundles/0_8b/text/eliza-1-0_8b-32k.gguf");
        expect(url).toContain("?download=true");
    });

    test("USBELIZA_HF_BASE_URL overrides the host", () => {
        const original = process.env.USBELIZA_HF_BASE_URL;
        process.env.USBELIZA_HF_BASE_URL = "http://localhost:8080/hf";
        const m = findCatalogModel("eliza-1-2b");
        if (m === undefined) throw new Error("eliza-1-2b missing");
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
    test("8 GB host gets eliza-1-2b plus the baseline", () => {
        const tiers = pickEligibleTiers(8);
        const ids = tiers.map((t) => t.id);
        expect(ids).toContain("eliza-1-0_8b");
        expect(ids).toContain("eliza-1-2b");
        expect(ids).not.toContain("eliza-1-4b");
        expect(ids).not.toContain("eliza-1-9b");
    });

    test("16 GB host gets eliza-1-9b and smaller tiers", () => {
        const tiers = pickEligibleTiers(16);
        const ids = tiers.map((t) => t.id);
        expect(ids).toContain("eliza-1-9b");
        expect(ids).toContain("eliza-1-4b");
        expect(ids).toContain("eliza-1-2b");
        expect(ids).toContain("eliza-1-0_8b");
        expect(ids).not.toContain("eliza-1-27b");
    });

    test("32 GB host gets everything but eliza-1-27b filtered", () => {
        const tiers = pickEligibleTiers(32);
        const ids = tiers.map((t) => t.id);
        expect(ids).toContain("eliza-1-9b");
        expect(ids).toContain("eliza-1-4b");
        expect(ids).not.toContain("eliza-1-27b");
    });

    test("64 GB workstation gets every chat tier including 27b", () => {
        const tiers = pickEligibleTiers(64);
        const ids = tiers.map((t) => t.id);
        expect(ids).toContain("eliza-1-27b");
        expect(ids).toContain("eliza-1-9b");
        expect(ids).toContain("eliza-1-4b");
        expect(ids).toContain("eliza-1-2b");
        expect(ids).toContain("eliza-1-0_8b");
    });

    test("filters out embedding tier (not a chat model)", () => {
        const tiers = pickEligibleTiers(32);
        for (const t of tiers) {
            expect(t.category).toBe("chat");
        }
    });

    test("always includes the baseline even on very-low-RAM hosts (2 GB)", () => {
        // eliza-1-0_8b minRam=2; 2+4=6 > 2 so strict filter would drop it.
        // The catalog injects baseline as a fallback.
        const tiers = pickEligibleTiers(2);
        const ids = tiers.map((t) => t.id);
        expect(ids).toContain("eliza-1-0_8b");
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
    test("eliza-1-9b returns its drafter sidecar", () => {
        const target = findCatalogModel("eliza-1-9b");
        if (target === undefined) throw new Error("eliza-1-9b missing");
        const drafter = findDflashDrafter(target);
        expect(drafter?.id).toBe("eliza-1-9b-drafter");
    });

    test("non-DFlash tier returns undefined", () => {
        const target = findCatalogModel("eliza-1-0_8b");
        if (target === undefined) throw new Error("eliza-1-0_8b missing");
        expect(findDflashDrafter(target)).toBeUndefined();
    });

    test("dflash drafter+target share the same tokenizer family", () => {
        const target = findCatalogModel("eliza-1-9b");
        const drafter = findCatalogModel("eliza-1-9b-drafter");
        expect(target?.tokenizerFamily).toBe("qwen35");
        expect(drafter?.tokenizerFamily).toBe("qwen35");
    });
});
