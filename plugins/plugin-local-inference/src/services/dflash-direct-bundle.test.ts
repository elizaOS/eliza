import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { findCatalogModel } from "./catalog";
import { DflashLlamaServer } from "./dflash-server";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
	process.env = { ...ORIGINAL_ENV };
	vi.restoreAllMocks();
});

describe("DflashLlamaServer direct bundle loads", () => {
	it("uses direct bundle metadata when the registry has no installed row", async () => {
		process.env.ELIZA_STATE_DIR = mkdtempSync(
			path.join(tmpdir(), "eliza-dflash-state-"),
		);
		const bundleRoot = mkdtempSync(path.join(tmpdir(), "eliza-dflash-"));
		mkdirSync(path.join(bundleRoot, "text"), { recursive: true });
		const modelPath = path.join(bundleRoot, "text", "eliza-1-9b-128k.gguf");
		const manifestPath = path.join(bundleRoot, "eliza-1.manifest.json");
		writeFileSync(modelPath, "GGUF", "utf8");
		writeFileSync(manifestPath, JSON.stringify({ id: "eliza-1-9b" }), "utf8");

		const server = new DflashLlamaServer();
		const start = vi.spyOn(server, "start").mockResolvedValue(undefined);
		const catalog = findCatalogModel("eliza-1-9b");
		if (!catalog) throw new Error("missing eliza-1-9b catalog entry");

		await server.load({
			modelPath,
			modelId: "eliza-1-9b",
			catalog,
			overrides: {
				contextSize: 4096,
				bundleRoot,
				manifestPath,
			},
		});

		expect(start).toHaveBeenCalledWith(
			expect.objectContaining({
				targetModelPath: modelPath,
				disableDrafter: true,
				bundleId: "eliza-1-9b",
			}),
			expect.anything(),
		);
	});
});
