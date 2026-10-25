/** Covers `createImageDescriptionRuntime` resolving the bundle's vision file and dispatching a describe pass, with the engine mocked. Real fs temp bundles. */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	load: vi.fn(async () => undefined),
	describeImage: vi.fn(async () => ({ text: "ok" })),
	unload: vi.fn(async () => undefined),
}));

vi.mock("./engine", () => ({
	localInferenceEngine: {
		load: mocks.load,
		describeImage: mocks.describeImage,
		unload: mocks.unload,
	},
}));

import { createImageDescriptionRuntime } from "./image-description-runtime";

afterEach(() => {
	vi.clearAllMocks();
});

describe("createImageDescriptionRuntime", () => {
	it("passes the manifest catalog id for direct bundle loads", async () => {
		const bundleRoot = mkdtempSync(path.join(tmpdir(), "eliza-vision-"));
		mkdirSync(path.join(bundleRoot, "text"), { recursive: true });
		mkdirSync(path.join(bundleRoot, "vision"), { recursive: true });
		const textPath = path.join(bundleRoot, "text", "eliza-1-9b-128k.gguf");
		const mmprojPath = path.join(bundleRoot, "vision", "mmproj-9b.gguf");
		writeFileSync(textPath, "GGUF", "utf8");
		writeFileSync(mmprojPath, "GGUF", "utf8");
		writeFileSync(
			path.join(bundleRoot, "eliza-1.manifest.json"),
			JSON.stringify({
				id: "eliza-1-9b",
				files: {
					text: [{ path: "text/eliza-1-9b-128k.gguf", ctx: 131072 }],
					vision: [{ path: "vision/mmproj-9b.gguf" }],
				},
			}),
			"utf8",
		);

		const runtime = await createImageDescriptionRuntime({
			tier: "eliza-1-9b",
			modelPath: bundleRoot,
		});

		expect(mocks.load).toHaveBeenCalledWith(textPath, {
			modelPath: textPath,
			modelId: "eliza-1-9b",
			mmprojPath,
			contextSize: 4096,
		});
		await runtime.cleanup?.();
		expect(mocks.unload).toHaveBeenCalled();
	});
});
