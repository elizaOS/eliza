import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildLoadArgsFromRegistryModel } from "./mobile-device-bridge-bootstrap";

function withTempBundle<T>(fn: (root: string) => T): T {
	const root = path.join(
		process.cwd(),
		"tmp",
		`mobile-device-bridge-mtp-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(root, { recursive: true });
	try {
		return fn(root);
	} finally {
		if (existsSync(root)) rmSync(root, { recursive: true, force: true });
	}
}

describe("buildLoadArgsFromRegistryModel — Gemma separate-drafter MTP", () => {
	it("keeps the shipped 4B context but leaves MTP off until a drafter is staged", () => {
		const args = buildLoadArgsFromRegistryModel({
			id: "eliza-1-4b",
			path: "/models/eliza-1-4b-128k.gguf",
		});
		expect(args.modelPath).toBe("/models/eliza-1-4b-128k.gguf");
		// 4B runs a 64k context on mobile.
		expect(args.contextSize).toBe(65536);
		// Gemma 4 uses a separate assistant drafter; no staged file means no MTP.
		expect(args.draftMin).toBeUndefined();
		expect(args.draftMax).toBeUndefined();
		expect(args.draftModelPath).toBeUndefined();
		expect(args.mobileSpeculative).toBeUndefined();
	});

	it("enables Gemma MTP when the bundle-relative drafter GGUF exists", () => {
		withTempBundle((root) => {
			const textDir = path.join(root, "text");
			const mtpDir = path.join(root, "mtp");
			mkdirSync(textDir, { recursive: true });
			mkdirSync(mtpDir, { recursive: true });
			const modelPath = path.join(textDir, "eliza-1-2b-128k.gguf");
			const drafterPath = path.join(mtpDir, "drafter-2b.gguf");
			writeFileSync(modelPath, "");
			writeFileSync(drafterPath, "");
			const args = buildLoadArgsFromRegistryModel({
				id: "eliza-1-2b",
				path: modelPath,
			});
			expect(args.draftModelPath).toBe(drafterPath);
			expect(args.draftMin).toBe(1);
			expect(args.draftMax).toBe(1);
			expect(args.mobileSpeculative).toBe(true);
		});
	});

	it("finds a flat staged Gemma drafter next to the model", () => {
		withTempBundle((root) => {
			const modelPath = path.join(root, "eliza-1-4b-128k.gguf");
			const drafterPath = path.join(root, "drafter-4b.gguf");
			writeFileSync(modelPath, "");
			writeFileSync(drafterPath, "");
			const args = buildLoadArgsFromRegistryModel({
				id: "eliza-1-4b",
				path: modelPath,
			});
			expect(args.draftModelPath).toBe(drafterPath);
			expect(args.draftMin).toBe(1);
			expect(args.draftMax).toBe(1);
		});
	});

	it("keeps QJL/TBQ KV-cache hints off by default for shipped Gemma tiers", () => {
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
