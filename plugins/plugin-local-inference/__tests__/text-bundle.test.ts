/**
 * Per-tier text + embedding bundle resolution.
 *
 * For every Eliza-1 tier, asserts that:
 *   - the catalog entry resolves (and is visible/not hidden),
 *   - the bundle's text GGUF path is declared (per-tier `textFile`),
 *   - the bundle's embedding GGUF path is declared on tiers that have a
 *     dedicated 1024-dim Matryoshka region (2b/4b/9b/27b/27b-256k/27b-1m),
 *   - the bundle's drafter GGUF path is declared (DFlash speculative
 *     decoding companion),
 *   - the HuggingFace resolve URL for the text and embedding components
 *     resolves to `elizaos/eliza-1` and includes the expected
 *     per-tier prefix.
 *
 * Why this matters: the publish pipeline stages a bundle per tier; if a
 * tier loses its embedding region (or its drafter is renamed), the
 * runtime's `useModel(TEXT_EMBEDDING, ...)` falls through to a non-local
 * provider on the desktop path and silently regresses to no DFlash on
 * every backend. This test pins the per-tier components catalogue as a
 * single source of truth.
 *
 * On 0_8b the embedding model is the text backbone pooled with
 * `--pooling last` (see `services/voice/embedding.ts`), so the catalog
 * does NOT declare a `components.embedding`. The test mirrors that
 * exception explicitly.
 */
import { describe, expect, it } from "vitest";
import {
	buildHuggingFaceResolveUrlForPath,
	ELIZA_1_HF_REPO,
	ELIZA_1_TIER_IDS,
	findCatalogModel,
} from "../src/services/catalog.ts";

const TIERS_WITHOUT_DEDICATED_EMBEDDING: ReadonlySet<string> = new Set([
	"eliza-1-0_8b",
]);

describe("per-tier text + embedding bundle resolution", () => {
	for (const tierId of ELIZA_1_TIER_IDS) {
		describe(tierId, () => {
			const model = findCatalogModel(tierId);

			it("resolves to a visible catalog entry", () => {
				expect(model, `${tierId} missing from MODEL_CATALOG`).toBeTruthy();
				expect(model?.hiddenFromCatalog).not.toBe(true);
			});

			it("declares a text GGUF component on `sourceModel.components.text`", () => {
				expect(model?.sourceModel?.components.text).toBeTruthy();
				expect(model?.sourceModel?.components.text?.repo).toBe(
					ELIZA_1_HF_REPO,
				);
				expect(model?.sourceModel?.components.text?.file).toMatch(
					/^bundles\/.+\/text\/eliza-1-.+\.gguf$/,
				);
			});

			it("declares a drafter GGUF component (the DFlash companion)", () => {
				expect(model?.sourceModel?.components.drafter).toBeTruthy();
				expect(model?.sourceModel?.components.drafter?.file).toMatch(
					/^bundles\/.+\/dflash\/drafter-.+\.gguf$/,
				);
				expect(model?.runtime?.dflash?.drafterModelId).toBe(
					`${tierId}-drafter`,
				);
			});

			it("declares the embedding GGUF component on tiers that ship a dedicated 1024-dim region", () => {
				const components = model?.sourceModel?.components;
				if (TIERS_WITHOUT_DEDICATED_EMBEDDING.has(tierId)) {
					// 0_8b serves embeddings by pooling the text backbone.
					expect(components?.embedding).toBeUndefined();
				} else {
					expect(components?.embedding).toBeTruthy();
					expect(components?.embedding?.repo).toBe(ELIZA_1_HF_REPO);
					// One canonical embedding file per tier — the catalog uses
					// a single filename for every tier that ships one.
					expect(components?.embedding?.file).toBe(
						`bundles/${tierId.slice("eliza-1-".length)}/embedding/eliza-1-embedding.gguf`,
					);
				}
			});

			it("resolves the text component to a HuggingFace URL on elizaos/eliza-1", () => {
				const file = model?.sourceModel?.components.text?.file;
				expect(file).toBeTruthy();
				if (!model || !file) return;
				const url = buildHuggingFaceResolveUrlForPath(model, file);
				expect(url).toContain(`/${ELIZA_1_HF_REPO}/resolve/main/`);
				expect(url).toContain(`bundles/${tierId.slice("eliza-1-".length)}/`);
				expect(url).toMatch(/\.gguf\?download=true$/);
			});

			it("resolves the embedding component to a HuggingFace URL when a dedicated region is declared", () => {
				if (TIERS_WITHOUT_DEDICATED_EMBEDDING.has(tierId)) return;
				const file = model?.sourceModel?.components.embedding?.file;
				expect(file).toBeTruthy();
				if (!model || !file) return;
				const url = buildHuggingFaceResolveUrlForPath(model, file);
				expect(url).toContain(`/${ELIZA_1_HF_REPO}/resolve/main/`);
				expect(url).toContain("embedding/eliza-1-embedding.gguf");
			});

			it("resolves the drafter component to a HuggingFace URL on the same repo", () => {
				const file = model?.sourceModel?.components.drafter?.file;
				expect(file).toBeTruthy();
				if (!model || !file) return;
				const url = buildHuggingFaceResolveUrlForPath(model, file);
				expect(url).toContain(`/${ELIZA_1_HF_REPO}/resolve/main/`);
				expect(url).toContain(`dflash/drafter-`);
			});

			it("sets `preferredBackend = llama-server` (DFlash + KV-cache kernels live in the fork)", () => {
				expect(model?.runtime?.preferredBackend).toBe("llama-server");
			});

			it("includes the dflash kernel in `requiresKernel`", () => {
				expect(
					model?.runtime?.optimizations?.requiresKernel,
				).toContain("dflash");
			});

			it("declares a kvCache profile (TurboQuant / QJL / PolarQuant types) — these are wired into llama-server args at boot", () => {
				expect(model?.runtime?.kvCache).toBeTruthy();
				expect(model?.runtime?.kvCache?.typeK).toBe("qjl1_256");
				expect(model?.runtime?.kvCache?.typeV).toBe("q4_polar");
				expect(model?.runtime?.kvCache?.requiresFork).toBe("buun-llama-cpp");
			});
		});
	}
});
