import {
	existsSync,
	mkdirSync,
	statSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildGemmaBionicPrompt,
	buildLoadArgsFromRegistryModel,
	deriveBionicBundleDir,
} from "./mobile-device-bridge-bootstrap";

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

describe("buildGemmaBionicPrompt", () => {
	it("renders messages with the Gemma chat turn markers", () => {
		expect(
			buildGemmaBionicPrompt({
				system: "Reply tersely.",
				messages: [
					{ role: "user", content: "hi" },
					{ role: "assistant", content: "hello" },
					{ role: "user", content: "next" },
				],
			} as never),
		).toBe(
			[
				"<start_of_turn>system\nReply tersely.<end_of_turn>",
				"<start_of_turn>user\nhi<end_of_turn>",
				"<start_of_turn>model\nhello<end_of_turn>",
				"<start_of_turn>user\nnext<end_of_turn>",
				"<start_of_turn>model\n",
			].join("\n"),
		);
	});

	it("converts legacy ChatML fast-path prompts before sending to Gemma", () => {
		expect(
			buildGemmaBionicPrompt({
				prompt: "<|im_start|>user\nhello<|im_end|>\n<|im_start|>assistant\n",
			} as never),
		).toBe("<start_of_turn>user\nhello<end_of_turn>\n<start_of_turn>model\n");
	});
});

describe("deriveBionicBundleDir — flat-model bundle staging (#11335)", () => {
	it("returns the bundle root for a canonical text/ layout", () => {
		withTempBundle((root) => {
			const textDir = path.join(root, "text");
			mkdirSync(textDir, { recursive: true });
			const model = path.join(textDir, "eliza-1-2b-128k.gguf");
			writeFileSync(model, "gguf");
			expect(deriveBionicBundleDir(model)).toBe(root);
		});
	});

	it("stages a hardlinked text/ view for a flat models/ model (the WebView chat path)", () => {
		withTempBundle((models) => {
			const model = path.join(models, "eliza-1-2b-128k.gguf");
			writeFileSync(model, "gguf-bytes");
			mkdirSync(path.join(models, "asr"), { recursive: true }); // sibling voice dir

			const bundle = deriveBionicBundleDir(model);
			// Bundle root is under .bionic-bundles/<name>/ (matches BionicHostLoader).
			expect(bundle).toBe(
				path.join(models, ".bionic-bundles", "eliza-1-2b-128k"),
			);
			// The host globs <bundle>/text/*.gguf — the alias must exist and be
			// the same file (hardlink → same inode; falls back to a symlink).
			const view = path.join(bundle, "text", "eliza-1-2b-128k.gguf");
			expect(existsSync(view)).toBe(true);
			expect(statSync(view).ino).toBe(statSync(model).ino);
		});
	});

	it("is idempotent and returns empty for a non-eliza-1 or missing model", () => {
		withTempBundle((models) => {
			const model = path.join(models, "eliza-1-4b-128k.gguf");
			writeFileSync(model, "x");
			const first = deriveBionicBundleDir(model);
			expect(deriveBionicBundleDir(model)).toBe(first); // no EEXIST throw
			// Non-eliza-1 flat names and missing paths fall back to host default.
			writeFileSync(path.join(models, "random.gguf"), "x");
			expect(deriveBionicBundleDir(path.join(models, "random.gguf"))).toBe("");
			expect(
				deriveBionicBundleDir(path.join(models, "eliza-1-none.gguf")),
			).toBe("");
		});
	});
});
