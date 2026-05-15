/**
 * WS3 tier → default image-gen model routing tests.
 *
 * Each tier in the catalog has exactly one default image-gen GGUF. The
 * map lives in two places (intentional, see provider.ts comment for
 * why):
 *
 *   1. `services/imagegen/backend-selector.ts#TIER_TO_DEFAULT_IMAGE_MODEL`
 *   2. `eliza/docs/ELIZA_1_BUNDLE_EXTRAS.json#imagegen.perTier`
 *
 * This test asserts they agree, plus that the small/desktop split lands
 * where the bundle plan expects (sd-1.5 for 0_8b/2b/4b; z-image-turbo
 * for 9b/27b/27b-256k).
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
	TIER_TO_DEFAULT_IMAGE_MODEL,
	resolveDefaultImageGenModel,
} from "../src/services/imagegen/backend-selector";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXTRAS_PATH = resolve(__dirname, "../../../docs/ELIZA_1_BUNDLE_EXTRAS.json");

interface ExtrasShape {
	imagegen?: {
		perTier?: Record<string, {
			default?: { id?: string; file?: string };
		}>;
	};
}

describe("WS3 routing — tier → default image-gen model", () => {
	it("mobile tiers default to sd-1.5 Q5_0", () => {
		for (const tier of ["eliza-1-0_8b", "eliza-1-2b", "eliza-1-4b"]) {
			const entry = TIER_TO_DEFAULT_IMAGE_MODEL[tier];
			expect(entry?.modelId).toBe("imagegen-sd-1_5-q5_0");
			expect(entry?.file).toBe("imagegen/sd-1.5-Q5_0.gguf");
		}
	});

	it("desktop tiers default to z-image-turbo Q4_K_M", () => {
		for (const tier of [
			"eliza-1-9b",
			"eliza-1-27b",
			"eliza-1-27b-256k",
		]) {
			const entry = TIER_TO_DEFAULT_IMAGE_MODEL[tier];
			expect(entry?.modelId).toBe("imagegen-z-image-turbo-q4_k_m");
			expect(entry?.file).toBe("imagegen/z-image-turbo-Q4_K_M.gguf");
		}
	});

	it("resolveDefaultImageGenModel(tier) returns the default", () => {
		expect(resolveDefaultImageGenModel("eliza-1-2b")?.modelId).toBe(
			"imagegen-sd-1_5-q5_0",
		);
		expect(resolveDefaultImageGenModel("eliza-1-9b")?.modelId).toBe(
			"imagegen-z-image-turbo-q4_k_m",
		);
	});

	it("resolveDefaultImageGenModel(modelId) round-trips", () => {
		expect(resolveDefaultImageGenModel("imagegen-sd-1_5-q5_0")?.modelId).toBe(
			"imagegen-sd-1_5-q5_0",
		);
		expect(
			resolveDefaultImageGenModel("imagegen-z-image-turbo-q4_k_m")?.modelId,
		).toBe("imagegen-z-image-turbo-q4_k_m");
	});

	it("resolveDefaultImageGenModel returns null on unknown input", () => {
		expect(resolveDefaultImageGenModel("eliza-1-unknown")).toBeNull();
		expect(resolveDefaultImageGenModel("imagegen-not-real")).toBeNull();
	});

	it("agrees with ELIZA_1_BUNDLE_EXTRAS.json#imagegen.perTier", () => {
		const extras = JSON.parse(readFileSync(EXTRAS_PATH, "utf8")) as ExtrasShape;
		const perTier = extras.imagegen?.perTier ?? {};
		for (const [tier, entry] of Object.entries(TIER_TO_DEFAULT_IMAGE_MODEL)) {
			const planned = perTier[tier]?.default;
			expect(planned?.id).toBe(entry.modelId);
			expect(planned?.file).toBe(entry.file);
		}
		// And every tier in the extras file is represented in the
		// in-code map (no drift the other way).
		for (const tier of Object.keys(perTier)) {
			expect(TIER_TO_DEFAULT_IMAGE_MODEL[tier]).toBeTruthy();
		}
	});
});
