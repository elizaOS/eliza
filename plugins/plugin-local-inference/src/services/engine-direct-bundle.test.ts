/** Covers `LocalInferenceEngine` loading a direct Eliza-1 bundle from disk (manifest resolution, backend plan). Real fs temp bundles; no live model forward pass. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { BackendPlan } from "./backend";
import { LocalInferenceEngine } from "./engine";
import type { VoiceStartupError } from "./voice/engine-bridge";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
	process.env = { ...ORIGINAL_ENV };
});

describe("LocalInferenceEngine direct Eliza-1 bundle loads", () => {
	it("projects modelId into catalog and bundle overrides before registry install", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-engine-test-"));
		process.env.ELIZA_STATE_DIR = root;
		const engine = new LocalInferenceEngine();
		const internals = engine as unknown as {
			dispatcher: {
				load(plan: BackendPlan): Promise<void>;
			};
		};
		let captured: BackendPlan | undefined;
		internals.dispatcher.load = async (plan) => {
			captured = plan;
		};

		const bundleRoot = path.join(root, "eliza-1-2b.bundle");
		const litertPath = path.join(bundleRoot, "text", "eliza-1-2b.litertlm");
		fs.mkdirSync(path.dirname(litertPath), { recursive: true });
		fs.writeFileSync(litertPath, "fake litert bundle");
		const modelPath = path.join(bundleRoot, "text", "eliza-1-2b-128k.gguf");
		await engine.load(modelPath, {
			modelPath,
			modelId: "eliza-1-2b",
		});

		expect(captured).toBeDefined();
		expect(captured?.modelPath).toBe(modelPath);
		expect(captured?.modelId).toBe("eliza-1-2b");
		expect(captured?.catalog?.id).toBe("eliza-1-2b");
		expect(captured?.overrides?.bundleRoot).toBe(bundleRoot);
		expect(captured?.overrides?.manifestPath).toBe(
			path.join(bundleRoot, "eliza-1.manifest.json"),
		);
		expect(captured?.overrides?.litertModelPath).toBe(litertPath);
		expect(
			(
				engine as unknown as {
					activeEliza1Bundle: { root?: string; tierId?: string } | null;
				}
			).activeEliza1Bundle,
		).toEqual(
			expect.objectContaining({
				root: bundleRoot,
				tierId: "eliza-1-2b",
			}),
		);
	});

	it("rejects Qwen ASR provenance before starting the fused voice bridge", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-engine-test-"));
		process.env.ELIZA_STATE_DIR = root;
		const bundleRoot = path.join(root, "eliza-1-2b.bundle");
		fs.mkdirSync(path.join(bundleRoot, "asr"), { recursive: true });
		fs.writeFileSync(path.join(bundleRoot, "asr", "model.gguf"), "asr");
		fs.writeFileSync(
			path.join(bundleRoot, "eliza-1.manifest.json"),
			JSON.stringify({ lineage: { asr: { base: "Qwen3-ASR" } } }),
		);

		const engine = new LocalInferenceEngine();
		(
			engine as unknown as {
				activeEliza1Bundle: { root: string; tierId: "eliza-1-2b" };
			}
		).activeEliza1Bundle = { root: bundleRoot, tierId: "eliza-1-2b" };
		(
			engine as unknown as { dispatcher: { hasLoadedModel(): boolean } }
		).dispatcher.hasLoadedModel = () => true;

		await expect(engine.ensureActiveBundleAsrReady()).rejects.toMatchObject({
			name: "VoiceStartupError",
			code: "blocked-asr-provenance",
		} satisfies Partial<VoiceStartupError>);
	});
});
