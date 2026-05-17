/**
 * WS2 mmproj routing test.
 *
 * `resolveLocalInferenceLoadArgs` must:
 *
 *   1. Plumb `mmprojPath` into the load args when:
 *      (a) the installed model has a `bundleRoot` set, AND
 *      (b) the catalog tier declares a `sourceModel.components.vision.file`, AND
 *      (c) the file exists on disk under `<bundleRoot>/<vision.file>`.
 *
 *   2. Leave `mmprojPath` undefined when:
 *      (a) the tier does not declare vision (text-only bundle), OR
 *      (b) the file is missing on disk (degraded vision; warning surfaces
 *          via the coordinator).
 *
 *   3. Survive the text-load path: even when mmproj is missing, the
 *      resolver must NOT throw — text is still expected to load.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	resolveLocalInferenceLoadArgs,
	resolveMmprojPath,
} from "../src/services/active-model";
import { findCatalogModel } from "../src/services/catalog";
import type { InstalledModel } from "../src/services/types";

const tmpRoots: string[] = [];

function makeTempBundle(args: {
	hasMmproj: boolean;
	tier: string; // e.g. "2b"
}): { bundleRoot: string; textPath: string } {
	const root = mkdtempSync(pathJoin(tmpdir(), "eliza-ws2-mmproj-"));
	tmpRoots.push(root);
	mkdirSync(pathJoin(root, "text"), { recursive: true });
	const textPath = pathJoin(root, "text", `eliza-1-${args.tier}-32k.gguf`);
	writeFileSync(textPath, "fake-text-gguf");
	if (args.hasMmproj) {
		mkdirSync(pathJoin(root, "vision"), { recursive: true });
		writeFileSync(
			pathJoin(root, "vision", `mmproj-${args.tier}.gguf`),
			"fake-mmproj-gguf",
		);
	}
	return { bundleRoot: root, textPath };
}

function installedModel(args: {
	id: string;
	bundleRoot: string;
	path: string;
}): InstalledModel {
	return {
		id: args.id,
		displayName: args.id,
		path: args.path,
		sizeBytes: 1024,
		bundleRoot: args.bundleRoot,
		installedAt: new Date().toISOString(),
		lastUsedAt: null,
		source: "eliza-download",
	};
}

beforeAll(() => {
	// No setup needed — each test makes its own temp dir.
});

afterAll(() => {
	for (const root of tmpRoots) {
		try {
			rmSync(root, { recursive: true, force: true });
		} catch {
			// non-fatal during teardown
		}
	}
});

describe("WS2 mmproj routing", () => {
	it("plumbs mmprojPath when the file exists for a vision-capable tier", async () => {
		// 2B is hasVision: true in the catalog post-WS2 catalog-flip.
		const tier = "2b";
		const bundle = makeTempBundle({ hasMmproj: true, tier });
		const installed = installedModel({
			id: `eliza-1-${tier}`,
			bundleRoot: bundle.bundleRoot,
			path: bundle.textPath,
		});
		const resolved = await resolveLocalInferenceLoadArgs(installed);
		expect(resolved.modelPath).toBe(bundle.textPath);
		expect(resolved.mmprojPath).toBe(
			pathJoin(bundle.bundleRoot, "vision", `mmproj-${tier}.gguf`),
		);
	});

	it("leaves mmprojPath undefined when the catalog tier doesn't ship vision", async () => {
		const catalog = findCatalogModel("eliza-1-2b");
		// Build a synthetic "vision-less" model by pointing at a tier id
		// that isn't in the catalog at all — `findCatalogModel` will
		// return undefined and the resolver must short-circuit.
		const bundle = makeTempBundle({ hasMmproj: false, tier: "2b" });
		const installed = installedModel({
			id: "definitely-not-a-real-tier-id",
			bundleRoot: bundle.bundleRoot,
			path: bundle.textPath,
		});
		const resolved = await resolveLocalInferenceLoadArgs(installed);
		expect(resolved.mmprojPath).toBeUndefined();
		// Sanity: the catalog DOES know about eliza-1-2b — this test
		// isn't about that tier, it's about how the resolver handles
		// unknown tier ids.
		expect(catalog).toBeDefined();
	});

	it("leaves mmprojPath undefined when the file is missing under bundleRoot", async () => {
		const tier = "2b";
		// hasMmproj: false simulates a partial bundle download — the
		// text GGUF arrived but the vision projector didn't.
		const bundle = makeTempBundle({ hasMmproj: false, tier });
		const installed = installedModel({
			id: `eliza-1-${tier}`,
			bundleRoot: bundle.bundleRoot,
			path: bundle.textPath,
		});
		const resolved = await resolveLocalInferenceLoadArgs(installed);
		expect(resolved.mmprojPath).toBeUndefined();
		// Text load is NOT gated on mmproj — modelPath still resolves.
		expect(resolved.modelPath).toBe(bundle.textPath);
	});

	it("leaves mmprojPath undefined when bundleRoot is absent", async () => {
		// External-scan models (LM Studio, Jan) have a path but no
		// bundleRoot. They never carry mmproj — even if the catalog has
		// a vision component for the tier, the resolver must skip the
		// per-tier lookup.
		const tier = "2b";
		const bundle = makeTempBundle({ hasMmproj: true, tier });
		const installed: InstalledModel = {
			id: `eliza-1-${tier}`,
			displayName: `eliza-1-${tier}`,
			path: bundle.textPath,
			sizeBytes: 1024,
			// No bundleRoot.
			installedAt: new Date().toISOString(),
			lastUsedAt: null,
			source: "external-scan",
			externalOrigin: "lm-studio",
		};
		const resolved = await resolveLocalInferenceLoadArgs(installed);
		expect(resolved.mmprojPath).toBeUndefined();
	});

	it("resolveMmprojPath is exported and usable independently", () => {
		const tier = "2b";
		const bundle = makeTempBundle({ hasMmproj: true, tier });
		const installed = installedModel({
			id: `eliza-1-${tier}`,
			bundleRoot: bundle.bundleRoot,
			path: bundle.textPath,
		});
		const catalog = findCatalogModel(installed.id);
		const path = resolveMmprojPath(installed, catalog);
		expect(path).toBe(
			pathJoin(bundle.bundleRoot, "vision", `mmproj-${tier}.gguf`),
		);
	});

	it("plumbs mmproj for the 0_8b tier — the smallest vision-enabled bundle", async () => {
		// WS2 flipped hasVision: true on 0_8b specifically because the
		// 220 MB mmproj is the smallest practical projector and fits the
		// 2 GB-floor low-tier-Android target. Validate the resolver
		// honours that catalog flip.
		const tier = "0_8b";
		const bundle = makeTempBundle({ hasMmproj: true, tier });
		const installed = installedModel({
			id: `eliza-1-${tier}`,
			bundleRoot: bundle.bundleRoot,
			path: bundle.textPath,
		});
		const resolved = await resolveLocalInferenceLoadArgs(installed);
		expect(resolved.mmprojPath).toBe(
			pathJoin(bundle.bundleRoot, "vision", `mmproj-${tier}.gguf`),
		);
	});
});
