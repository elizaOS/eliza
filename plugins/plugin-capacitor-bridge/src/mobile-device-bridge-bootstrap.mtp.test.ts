import { describe, expect, it } from "vitest";
import { buildLoadArgsFromRegistryModel } from "./mobile-device-bridge-bootstrap";

describe("buildLoadArgsFromRegistryModel — same-file MTP", () => {
	it("enables the draft window for the shipped 4B default", () => {
		const args = buildLoadArgsFromRegistryModel({
			id: "eliza-1-4b",
			path: "/models/eliza-1-4b-128k.gguf",
		});
		expect(args.modelPath).toBe("/models/eliza-1-4b-128k.gguf");
		// 4B runs a 64k context on mobile.
		expect(args.contextSize).toBe(65536);
		// Same-file MTP: draft window on, no separate drafter download.
		expect(args.draftMin).toBe(1);
		expect(args.draftMax).toBe(2);
		expect(args.draftModelPath).toBeUndefined();
		expect(args.mobileSpeculative).toBe(true);
	});

	it("enables MTP for every Eliza-1 MTP tier (2B+ carry an embedded NextN head)", () => {
		for (const id of [
			"eliza-1-2b",
			"eliza-1-4b",
			"eliza-1-9b",
			"eliza-1-27b",
			"eliza-1-27b-256k",
		]) {
			const args = buildLoadArgsFromRegistryModel({
				id,
				path: `/models/${id}.gguf`,
			});
			expect(args.draftMin, `${id} draftMin`).toBe(1);
			expect(args.draftMax, `${id} draftMax`).toBe(2);
		}
	});

	it("keeps QJL/TBQ KV-cache hints off by default for shipped qwen35 tiers", () => {
		const previous = process.env.ELIZA_BIONIC_KV_QUANT;
		delete process.env.ELIZA_BIONIC_KV_QUANT;
		try {
			const args = buildLoadArgsFromRegistryModel({
				id: "eliza-1-4b",
				path: "/models/eliza-1-4b.gguf",
			});
			expect(args.cacheTypeK).toBeUndefined();
			expect(args.cacheTypeV).toBeUndefined();
		} finally {
			if (previous === undefined) {
				delete process.env.ELIZA_BIONIC_KV_QUANT;
			} else {
				process.env.ELIZA_BIONIC_KV_QUANT = previous;
			}
		}
	});
	it("leaves MTP unset for an unknown (non-Eliza-1) model id", () => {
		const args = buildLoadArgsFromRegistryModel({
			id: "some-custom-model",
			path: "/models/custom.gguf",
		});
		expect(args.contextSize).toBeUndefined();
		expect(args.draftMin).toBeUndefined();
		expect(args.draftMax).toBeUndefined();
		expect(args.mobileSpeculative).toBeUndefined();
	});
});
