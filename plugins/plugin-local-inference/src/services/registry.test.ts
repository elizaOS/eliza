import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findCatalogModel } from "./catalog";
import { listInstalledModels } from "./registry";
import type { InstalledModel } from "./types";

const originalEnv = { ...process.env };

afterEach(() => {
	process.env = { ...originalEnv };
});

function sha256(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

function writeJson(filePath: string, value: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

describe("local inference plugin registry", () => {
	it("self-heals missing DFlash companion entries from a validated bundle manifest", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-registry-test-"));
		process.env.ELIZA_STATE_DIR = root;

		const model = findCatalogModel("eliza-1-2b");
		const companion = findCatalogModel("eliza-1-2b-drafter");
		expect(model).toBeDefined();
		expect(companion).toBeDefined();
		if (!model || !companion) throw new Error("missing catalog fixture");

		const bundleRoot = path.join(
			root,
			"local-inference",
			"models",
			"eliza-1-2b.bundle",
		);
		const manifestPath = path.join(bundleRoot, "eliza-1.manifest.json");
		const targetPath = path.join(bundleRoot, model.ggufFile);
		const drafterPath = path.join(bundleRoot, companion.ggufFile);
		const targetContent = "target model";
		const drafterContent = "drafter model";
		fs.mkdirSync(path.dirname(targetPath), { recursive: true });
		fs.mkdirSync(path.dirname(drafterPath), { recursive: true });
		fs.writeFileSync(targetPath, targetContent, "utf8");
		fs.writeFileSync(drafterPath, drafterContent, "utf8");

		writeJson(manifestPath, {
			id: model.id,
			version: "1.0.0",
			defaultEligible: false,
			files: {
				dflash: [
					{
						path: companion.ggufFile,
						sha256: sha256(drafterContent),
					},
				],
			},
		});

		const targetInstalled: InstalledModel = {
			id: model.id,
			displayName: model.displayName,
			path: targetPath,
			sizeBytes: Buffer.byteLength(targetContent),
			bundleRoot,
			manifestPath,
			manifestSha256: sha256("manifest"),
			bundleVersion: "1.0.0",
			bundleSizeBytes:
				Buffer.byteLength(targetContent) + Buffer.byteLength(drafterContent),
			hfRepo: model.hfRepo,
			installedAt: "2026-05-16T00:00:00.000Z",
			lastUsedAt: null,
			source: "eliza-download",
			sha256: sha256(targetContent),
			lastVerifiedAt: "2026-05-16T00:00:00.000Z",
			runtimeRole: "chat",
		};
		const registryPath = path.join(root, "local-inference", "registry.json");
		writeJson(registryPath, {
			version: 1,
			models: [targetInstalled],
		});

		const installed = await listInstalledModels();
		const healedCompanion = installed.find(
			(entry) => entry.id === companion.id,
		);
		expect(healedCompanion).toMatchObject({
			id: companion.id,
			displayName: companion.displayName,
			path: drafterPath,
			source: "eliza-download",
			runtimeRole: "dflash-drafter",
			companionFor: model.id,
			bundleRoot,
			manifestPath,
			sha256: sha256(drafterContent),
		});

		const persisted = JSON.parse(fs.readFileSync(registryPath, "utf8")) as {
			models: InstalledModel[];
		};
		expect(persisted.models.some((entry) => entry.id === companion.id)).toBe(
			true,
		);
	});

	it("does not self-heal a DFlash companion when the manifest hash does not match the file", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-registry-test-"));
		process.env.ELIZA_STATE_DIR = root;

		const model = findCatalogModel("eliza-1-2b");
		const companion = findCatalogModel("eliza-1-2b-drafter");
		expect(model).toBeDefined();
		expect(companion).toBeDefined();
		if (!model || !companion) throw new Error("missing catalog fixture");

		const bundleRoot = path.join(
			root,
			"local-inference",
			"models",
			"eliza-1-2b.bundle",
		);
		const manifestPath = path.join(bundleRoot, "eliza-1.manifest.json");
		const targetPath = path.join(bundleRoot, model.ggufFile);
		const drafterPath = path.join(bundleRoot, companion.ggufFile);
		fs.mkdirSync(path.dirname(targetPath), { recursive: true });
		fs.mkdirSync(path.dirname(drafterPath), { recursive: true });
		fs.writeFileSync(targetPath, "target model", "utf8");
		fs.writeFileSync(drafterPath, "actual drafter bytes", "utf8");

		writeJson(manifestPath, {
			id: model.id,
			version: "1.0.0",
			files: {
				dflash: [
					{
						path: companion.ggufFile,
						sha256: sha256("different bytes"),
					},
				],
			},
		});

		writeJson(path.join(root, "local-inference", "registry.json"), {
			version: 1,
			models: [
				{
					id: model.id,
					displayName: model.displayName,
					path: targetPath,
					sizeBytes: 12,
					bundleRoot,
					manifestPath,
					installedAt: "2026-05-16T00:00:00.000Z",
					lastUsedAt: null,
					source: "eliza-download",
					runtimeRole: "chat",
				},
			],
		});

		const installed = await listInstalledModels();
		expect(installed.some((entry) => entry.id === companion.id)).toBe(false);
	});
});
