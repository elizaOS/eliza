import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { BackendPlan } from "./backend";
import { LocalInferenceEngine } from "./engine";

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

		const bundleRoot = path.join(root, "eliza-1-0_8b.bundle");
		const modelPath = path.join(bundleRoot, "text", "eliza-1-0_8b-128k.gguf");
		await engine.load(modelPath, {
			modelPath,
			modelId: "eliza-1-0_8b",
		});

		expect(captured).toBeDefined();
		expect(captured?.modelPath).toBe(modelPath);
		expect(captured?.modelId).toBe("eliza-1-0_8b");
		expect(captured?.catalog?.id).toBe("eliza-1-0_8b");
		expect(captured?.overrides?.bundleRoot).toBe(bundleRoot);
		expect(captured?.overrides?.manifestPath).toBe(
			path.join(bundleRoot, "eliza-1.manifest.json"),
		);
		expect(
			(
				engine as unknown as {
					activeEliza1Bundle: { root?: string; tierId?: string } | null;
				}
			).activeEliza1Bundle,
		).toEqual(
			expect.objectContaining({
				root: bundleRoot,
				tierId: "eliza-1-0_8b",
			}),
		);
	});
});
