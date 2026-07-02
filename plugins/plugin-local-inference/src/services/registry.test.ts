import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registryPath } from "./paths";
import {
	listInstalledModels,
	removeElizaModel,
	upsertElizaModel,
} from "./registry";
import type { InstalledModel } from "./types";

const originalEnv = { ...process.env };
const tempDirs: string[] = [];

afterEach(() => {
	process.env = { ...originalEnv };
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

function useTempStateDir(): string {
	const stateDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "eliza-local-inference-registry-"),
	);
	tempDirs.push(stateDir);
	process.env.ELIZA_STATE_DIR = stateDir;
	return stateDir;
}

function installedModel(
	id: string,
	modelPath: string,
	overrides: Partial<InstalledModel> = {},
): InstalledModel {
	return {
		id,
		displayName: id,
		path: modelPath,
		sizeBytes: 1024,
		installedAt: "2026-06-28T00:00:00.000Z",
		lastUsedAt: null,
		source: "eliza-download",
		...overrides,
	};
}

function readRawRegistry(): { models?: InstalledModel[] } {
	return JSON.parse(fs.readFileSync(registryPath(), "utf8")) as {
		models?: InstalledModel[];
	};
}

describe("local inference registry removal", () => {
	it("persists Eliza-owned artifact paths relative to the local-inference root", async () => {
		const stateDir = useTempStateDir();
		const bundleRoot = path.join(
			stateDir,
			"local-inference",
			"models",
			"eliza-1-2b",
		);
		const modelPath = path.join(bundleRoot, "text", "model.gguf");
		const manifestPath = path.join(bundleRoot, "eliza-1.manifest.json");
		fs.mkdirSync(path.dirname(modelPath), { recursive: true });
		fs.writeFileSync(modelPath, "fake-model");
		fs.writeFileSync(manifestPath, "{}");

		await upsertElizaModel(
			installedModel("eliza-1-2b", modelPath, { bundleRoot, manifestPath }),
		);

		const rawModel = readRawRegistry().models?.[0];
		expect(rawModel?.path).toBe("models/eliza-1-2b/text/model.gguf");
		expect(rawModel?.bundleRoot).toBe("models/eliza-1-2b");
		expect(rawModel?.manifestPath).toBe(
			"models/eliza-1-2b/eliza-1.manifest.json",
		);

		const listed = await listInstalledModels();
		expect(listed[0]?.path).toBe(modelPath);
		expect(listed[0]?.bundleRoot).toBe(bundleRoot);
		expect(listed[0]?.manifestPath).toBe(manifestPath);
	});

	it("reanchors legacy absolute registry paths when the state root changes", async () => {
		const currentStateDir = useTempStateDir();
		const previousStateDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "eliza-local-inference-old-state-"),
		);
		tempDirs.push(previousStateDir);

		const currentBundleRoot = path.join(
			currentStateDir,
			"local-inference",
			"models",
			"eliza-1-2b",
		);
		const currentModelPath = path.join(currentBundleRoot, "text", "model.gguf");
		const currentManifestPath = path.join(
			currentBundleRoot,
			"eliza-1.manifest.json",
		);
		fs.mkdirSync(path.dirname(currentModelPath), { recursive: true });
		fs.writeFileSync(currentModelPath, "fake-model");
		fs.writeFileSync(currentManifestPath, "{}");

		const legacyBundleRoot = path.join(
			previousStateDir,
			"local-inference",
			"models",
			"eliza-1-2b",
		);
		const legacyModelPath = path.join(legacyBundleRoot, "text", "model.gguf");
		const legacyManifestPath = path.join(
			legacyBundleRoot,
			"eliza-1.manifest.json",
		);
		fs.mkdirSync(path.dirname(registryPath()), { recursive: true });
		fs.writeFileSync(
			registryPath(),
			JSON.stringify(
				{
					version: 1,
					models: [
						installedModel("eliza-1-2b", legacyModelPath, {
							bundleRoot: legacyBundleRoot,
							manifestPath: legacyManifestPath,
						}),
					],
				},
				null,
				2,
			),
		);

		const listed = await listInstalledModels();
		expect(listed[0]?.path).toBe(currentModelPath);
		expect(listed[0]?.bundleRoot).toBe(currentBundleRoot);
		expect(listed[0]?.manifestPath).toBe(currentManifestPath);
		expect(fs.existsSync(listed[0]?.path ?? "")).toBe(true);
	});

	it("removes an Eliza-owned bundle directory and clears the registry entry", async () => {
		const stateDir = useTempStateDir();
		const bundleRoot = path.join(
			stateDir,
			"local-inference",
			"models",
			"eliza-1-2b",
		);
		const modelPath = path.join(bundleRoot, "text", "model.gguf");
		fs.mkdirSync(path.dirname(modelPath), { recursive: true });
		fs.writeFileSync(modelPath, "fake-model");

		await upsertElizaModel(
			installedModel("eliza-1-2b", modelPath, { bundleRoot }),
		);

		await expect(removeElizaModel("eliza-1-2b")).resolves.toEqual({
			removed: true,
		});
		expect(fs.existsSync(bundleRoot)).toBe(false);
		expect(await listInstalledModels()).toEqual([]);
	});

	it("clears stale registry entries when the model path is already missing", async () => {
		const stateDir = useTempStateDir();
		const modelPath = path.join(
			stateDir,
			"local-inference",
			"models",
			"missing.gguf",
		);

		await upsertElizaModel(installedModel("missing-model", modelPath));

		await expect(removeElizaModel("missing-model")).resolves.toEqual({
			removed: true,
		});
		expect(await listInstalledModels()).toEqual([]);
	});

	it.skipIf(process.platform === "win32")(
		"refuses a registry path that escapes through a symlinked parent",
		async () => {
			const stateDir = useTempStateDir();
			const outsideDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "eliza-local-inference-outside-"),
			);
			tempDirs.push(outsideDir);
			const modelsDir = path.join(stateDir, "local-inference", "models");
			const linkPath = path.join(modelsDir, "linked-outside");
			fs.mkdirSync(modelsDir, { recursive: true });
			fs.writeFileSync(path.join(outsideDir, "model.gguf"), "outside-model");
			fs.symlinkSync(outsideDir, linkPath, "dir");

			const modelPath = path.join(linkPath, "model.gguf");
			await upsertElizaModel(
				installedModel("escaped-model", modelPath, { bundleRoot: linkPath }),
			);

			await expect(removeElizaModel("escaped-model")).resolves.toEqual({
				removed: false,
				reason: "external",
			});
			expect(fs.existsSync(path.join(outsideDir, "model.gguf"))).toBe(true);
			expect((await listInstalledModels()).map((model) => model.id)).toEqual([
				"escaped-model",
			]);
		},
	);
});
