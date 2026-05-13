// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

/**
 * usbeliza local-inference model catalog.
 *
 * Source of truth for which local LLMs the boot-time calibration model
 * picker offers and which the agent can load at runtime. Every entry is
 * **publicly resolvable** on HuggingFace via the unauthenticated
 * `https://huggingface.co/<repo>/resolve/main/<file>` endpoint — verified
 * to return HTTP 200 to anonymous requests.
 *
 * **Why we do not use milady's `elizaos/eliza-1-*` catalog:**
 * the entire `elizaos/eliza-1-{lite,mobile,desktop,pro,server}` family is
 * gated on HuggingFace and returns HTTP 401 to anonymous downloads. The
 * milady codepath supports them but a fresh usbeliza USB booter cannot
 * actually fetch one. We pick public-equivalents that match each tier's
 * RAM target and tokenizer family so the DFlash drafter/target pairing
 * still works.
 *
 * Tier scoring is "minRamGb + 4 GB headroom" — the model picker hides any
 * tier whose minRamGb + 4 would exceed `/proc/meminfo` MemTotal at boot,
 * so users never see a tier they cannot fit.
 *
 * Adapted from milady's
 * `eliza/packages/ui/src/services/local-inference/catalog.ts`. Same shape,
 * different IDs — milady's `Eliza1TierId` is gated, ours is public.
 */

export type ModelTierId =
    | "tiny-1b"
    | "drafter-0_6b"
    | "mid-7b"
    | "dflash-9b"
    | "heavy-32b";

export type ModelCategory = "chat" | "drafter" | "embedding";
export type ModelBucket = "small" | "mid" | "large";

export interface CatalogModel {
    /** Stable identifier used in calibration.toml and the runtime store. */
    readonly id: ModelTierId | "embedding-bge-small";
    /** Human-readable label for the picker. */
    readonly displayName: string;
    /** HuggingFace `<owner>/<repo>` (e.g. `bartowski/Qwen3.5-9B-DFlash-FP16-GGUF`). */
    readonly hfRepo: string;
    /** Exact GGUF filename inside the repo. We construct the resolve URL from this. */
    readonly ggufFile: string;
    /** Approximate parameter count, for the picker UX. */
    readonly params: string;
    /** Approximate Q4_K_M GGUF size in GB (used to estimate disk + download time). */
    readonly sizeGb: number;
    /** Minimum host RAM the picker requires to surface this tier. */
    readonly minRamGb: number;
    /** Architectural role. */
    readonly category: ModelCategory;
    /** Coarse size bucket — drives UX grouping in the picker. */
    readonly bucket: ModelBucket;
    /** Tokenizer family — DFlash drafter+target MUST share family. */
    readonly tokenizerFamily: "llama3" | "qwen2" | "qwen3" | "bert";
    /** Picker copy. One sentence, present-tense. */
    readonly blurb: string;
    /**
     * DFlash drafter pairing. Only set on tiers that have a verified-
     * compatible drafter in this catalog. The drafter's tokenizer family
     * MUST match this tier's.
     */
    readonly dflashDrafter?: ModelTierId;
}

/**
 * The single canonical first-boot baseline. **Bundled into the base ISO**
 * so a freshly-booted live USB can chat with no network. Sized to fit
 * any reasonable laptop (<2 GB resident).
 */
export const BASELINE_MODEL_ID: ModelTierId = "tiny-1b";

/**
 * The default embedding model. Tiny and always bundled.
 */
export const BASELINE_EMBEDDING_ID = "embedding-bge-small" as const;

export const MODEL_CATALOG: readonly CatalogModel[] = [
    // ─── Always-on embeddings ────────────────────────────────────────
    {
        id: "embedding-bge-small",
        displayName: "BGE-small (embeddings)",
        hfRepo: "ChristianAzinn/bge-small-en-v1.5-gguf",
        ggufFile: "bge-small-en-v1.5.Q4_K_M.gguf",
        params: "33M",
        sizeGb: 0.03,
        minRamGb: 0.5,
        category: "embedding",
        bucket: "small",
        tokenizerFamily: "bert",
        blurb: "Sentence embeddings for retrieval, recall, and search inside generated apps.",
    },

    // ─── tiny-1b — fits anywhere, baseline pre-network chat ──────────
    {
        id: "tiny-1b",
        displayName: "Llama-3.2 1B Instruct",
        hfRepo: "bartowski/Llama-3.2-1B-Instruct-GGUF",
        ggufFile: "Llama-3.2-1B-Instruct-Q4_K_M.gguf",
        params: "1B",
        sizeGb: 0.8,
        minRamGb: 2,
        category: "chat",
        bucket: "small",
        tokenizerFamily: "llama3",
        blurb: "Pre-network baseline. Fits a 4 GB laptop, runs at 80–120 t/s on Lunar Lake CPU.",
    },

    // ─── drafter-0_6b — Qwen3 family, pairs with dflash-9b ───────────
    {
        id: "drafter-0_6b",
        displayName: "Qwen3 0.6B (DFlash drafter)",
        hfRepo: "unsloth/Qwen3-0.6B-GGUF",
        ggufFile: "Qwen3-0.6B-Q4_K_M.gguf",
        params: "0.6B",
        sizeGb: 0.4,
        minRamGb: 2,
        category: "drafter",
        bucket: "small",
        tokenizerFamily: "qwen3",
        blurb:
            "Speculative-decoding drafter. Pairs with Qwen3.5-9B-DFlash for a 2–3× speedup on the laptop tier.",
    },

    // ─── mid-7b — laptop default without DFlash ──────────────────────
    {
        id: "mid-7b",
        displayName: "Qwen2.5 7B Instruct",
        hfRepo: "bartowski/Qwen2.5-7B-Instruct-GGUF",
        ggufFile: "Qwen2.5-7B-Instruct-Q4_K_M.gguf",
        params: "7B",
        sizeGb: 4.7,
        minRamGb: 8,
        category: "chat",
        bucket: "mid",
        tokenizerFamily: "qwen2",
        blurb: "Strong all-rounder for 12 GB+ laptops. Reasonable coding + chat at 20–30 t/s on Lunar Lake.",
    },

    // ─── dflash-9b — recommended tier for Lunar Lake (32 GB) ─────────
    // Paired with drafter-0_6b for speculative decoding (2-3× speedup).
    // Both Qwen3 family → tokenizer compatibility guaranteed.
    {
        id: "dflash-9b",
        displayName: "Qwen3.5 9B DFlash",
        hfRepo: "psychopenguin/Qwen3.5-9B-DFlash-FP16-GGUF",
        ggufFile: "Qwen3.5-9B-DFlash-Q4_K_M.gguf",
        params: "9B",
        sizeGb: 5.8,
        minRamGb: 12,
        category: "chat",
        bucket: "mid",
        tokenizerFamily: "qwen3",
        blurb:
            "Recommended for laptops with 16 GB+. Uses Qwen3 0.6B as a speculative-decoding drafter — 30–60 t/s on Lunar Lake.",
        dflashDrafter: "drafter-0_6b",
    },

    // ─── heavy-32b — workstation tier ────────────────────────────────
    {
        id: "heavy-32b",
        displayName: "Qwen2.5 32B Instruct",
        hfRepo: "bartowski/Qwen2.5-32B-Instruct-GGUF",
        ggufFile: "Qwen2.5-32B-Instruct-Q4_K_M.gguf",
        params: "32B",
        sizeGb: 18,
        minRamGb: 32,
        category: "chat",
        bucket: "large",
        tokenizerFamily: "qwen2",
        blurb:
            "Workstation tier. Needs 32 GB+ RAM; runs at 4–7 t/s on CPU-only Lunar Lake (faster with GPU offload).",
    },
];

export function findCatalogModel(id: string): CatalogModel | undefined {
    return MODEL_CATALOG.find((m) => m.id === id);
}

/**
 * Construct the HuggingFace resolve URL. Respects `USBELIZA_HF_BASE_URL`
 * for self-hosted mirrors and tests; never trims the GGUF file path because
 * some repos use a `text/` or `quantized/` subdir.
 */
export function buildHuggingFaceResolveUrl(model: CatalogModel): string {
    const base =
        process.env.USBELIZA_HF_BASE_URL?.trim().replace(/\/+$/, "") ??
        Bun.env.USBELIZA_HF_BASE_URL?.trim().replace(/\/+$/, "") ??
        "https://huggingface.co";
    const encodedPath = model.ggufFile
        .split("/")
        .map((segment) => encodeURIComponent(segment))
        .join("/");
    return `${base}/${model.hfRepo}/resolve/main/${encodedPath}?download=true`;
}

/**
 * Memory-aware tier filter: returns the chat-eligible tiers a host with
 * `memTotalGb` GiB of RAM can actually run, sorted largest-first so the
 * picker can show the best fit at the top. Always includes the baseline
 * `tiny-1b` even if memTotalGb < 6 — without it the picker can't offer
 * anything and the boot stalls. (We already require minRamGb=2 for
 * tiny-1b, so any usable host trivially clears the gate.)
 */
export function pickEligibleTiers(memTotalGb: number): CatalogModel[] {
    const HEADROOM_GB = 4;
    const chatTiers = MODEL_CATALOG.filter((m) => m.category === "chat");
    const eligible = chatTiers.filter((m) => m.minRamGb + HEADROOM_GB <= memTotalGb);
    if (eligible.find((m) => m.id === "tiny-1b") === undefined) {
        const baseline = findCatalogModel("tiny-1b");
        if (baseline !== undefined) eligible.push(baseline);
    }
    return eligible.sort((a, b) => b.minRamGb - a.minRamGb);
}

/**
 * The drafter model for a given DFlash-enabled target. Returns undefined
 * for non-DFlash tiers, or if the catalog is mis-paired (defensive).
 */
export function findDflashDrafter(target: CatalogModel): CatalogModel | undefined {
    if (target.dflashDrafter === undefined) return undefined;
    const drafter = findCatalogModel(target.dflashDrafter);
    if (drafter === undefined) return undefined;
    if (drafter.tokenizerFamily !== target.tokenizerFamily) {
        throw new Error(
            `catalog inconsistency: drafter ${drafter.id} (${drafter.tokenizerFamily}) cannot draft for ` +
                `target ${target.id} (${target.tokenizerFamily}) — tokenizer families must match`,
        );
    }
    return drafter;
}
