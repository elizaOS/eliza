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
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	resolveLocalInferenceLoadArgs,
	resolveMmprojPath,
} from "../src/services/active-model";
import { findCatalogModel } from "../src/services/catalog";
import type { InstalledModel } from "../src/services/types";

const tmpRoots: string[] = [];

function makeTempBundle(args: {
	hasMmproj: boolean;
	hasMtp?: boolean;
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
	if (args.hasMtp !== false) {
		mkdirSync(pathJoin(root, "mtp"), { recursive: true });
		writeFileSync(
			pathJoin(root, "mtp", `drafter-${args.tier}.gguf`),
			"fake-mtp-drafter-gguf",
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

	for (const tier of ["2b", "4b"] as const) {
		it(`resolves the bundled gemma4-assistant drafter for the hosted MTP tier (${tier})`, async () => {
			// bundles/<tier>/mtp/drafter-<tier>.gguf is hosted (gemma4-assistant,
			// converted from google/gemma-4-E2B-it-assistant /
			// google/gemma-4-E4B-it-assistant) and the catalog advertises
			// runtime.mtp for the tier, so the resolver must wire the on-disk
			// drafter with the catalog's draft window.
			const catalog = findCatalogModel(`eliza-1-${tier}`);
			expect(catalog?.runtime?.mtp?.specType).toBe("draft-mtp");
			const bundle = makeTempBundle({ hasMmproj: true, hasMtp: true, tier });
			const installed = installedModel({
				id: `eliza-1-${tier}`,
				bundleRoot: bundle.bundleRoot,
				path: bundle.textPath,
			});
			const resolved = await resolveLocalInferenceLoadArgs(installed);
			expect(resolved.modelPath).toBe(bundle.textPath);
			expect(resolved.draftModelPath).toBe(
				pathJoin(bundle.bundleRoot, "mtp", `drafter-${tier}.gguf`),
			);
			expect(resolved.draftMin).toBe(catalog?.runtime?.mtp?.draftMin);
			expect(resolved.draftMax).toBe(catalog?.runtime?.mtp?.draftMax);
		});
	}

	it("ignores an on-disk MTP drafter for tiers without a hosted Gemma drafter", async () => {
		const tier = "9b";
		// The active HF tree does not host `mtp/drafter-9b.gguf`, so the catalog
		// must not enable speculative decoding just because a local file with
		// that shape exists.
		expect(findCatalogModel(`eliza-1-${tier}`)?.runtime?.mtp).toBeUndefined();
		const bundle = makeTempBundle({ hasMmproj: true, hasMtp: true, tier });
		const installed = installedModel({
			id: `eliza-1-${tier}`,
			bundleRoot: bundle.bundleRoot,
			path: bundle.textPath,
		});
		const resolved = await resolveLocalInferenceLoadArgs(installed);
		expect(resolved.modelPath).toBe(bundle.textPath);
		expect(resolved.draftModelPath).toBeUndefined();
		expect(resolved.draftMin).toBeUndefined();
		expect(resolved.draftMax).toBeUndefined();
		expect(resolved.mobileSpeculative).toBeUndefined();
	});

	it("falls back to a non-speculative load when a pre-cutover bundle is missing the drafter GGUF", async () => {
		// Back-compat (#11517): a 2b/4b bundle installed BEFORE the Gemma-4 MTP
		// cutover has no `mtp/drafter-<tier>.gguf` on disk even though the
		// catalog now advertises runtime.mtp for the tier. The drafter is a
		// perf-only speculative-decoding artifact — the text model must still
		// load (warn + plain decode), never hard-throw and brick the install.
		const tier = "2b";
		expect(findCatalogModel(`eliza-1-${tier}`)?.runtime?.mtp?.specType).toBe(
			"draft-mtp",
		);
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const bundle = makeTempBundle({ hasMmproj: true, hasMtp: false, tier });
			const installed = installedModel({
				id: `eliza-1-${tier}`,
				bundleRoot: bundle.bundleRoot,
				path: bundle.textPath,
			});
			const resolved = await resolveLocalInferenceLoadArgs(installed);
			expect(resolved.modelPath).toBe(bundle.textPath);
			expect(resolved.draftModelPath).toBeUndefined();
			expect(resolved.draftMin).toBeUndefined();
			expect(resolved.draftMax).toBeUndefined();
			expect(resolved.mobileSpeculative).toBeUndefined();
			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringContaining(
					"Re-download the model to enable the MTP drafter",
				),
			);
		} finally {
			warnSpy.mockRestore();
		}
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

	it("plumbs mmproj for the 2b tier — the smallest vision-enabled bundle", async () => {
		// The 2B entry tier ships hasVision: true; the 220 MB mmproj is the
		// smallest practical projector and fits the small-phone target.
		// Validate the resolver honours that catalog flag.
		const tier = "2b";
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
