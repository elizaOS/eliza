/**
 * On-disk registry of installed models.
 *
 * The default registry contains only Eliza-owned downloads
 * (source: "eliza-download") written on successful completion by the
 * curated bundle downloader. External scans are developer-only diagnostics
 * behind `ELIZA_LOCAL_INFERENCE_ENABLE_EXTERNAL_SCAN=1`; they never enter
 * first-run, setup, or normal Settings surfaces.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { logger } from "@elizaos/core";
import { scanExternalModels } from "./external-scanner";
import {
	isWithinElizaRoot,
	localInferenceRoot,
	registryPath,
	resolveLocalInferenceStoredPath,
	toLocalInferenceStoredPath,
} from "./paths";
import { type InstalledModel, withRuntimeClass } from "./types";

interface RegistryFile {
	version: 1;
	models: StoredInstalledModel[];
}

type StoredInstalledModel = Omit<
	InstalledModel,
	"path" | "bundleRoot" | "manifestPath"
> & {
	path: string;
	bundleRoot?: string;
	manifestPath?: string;
};

const EXTERNAL_SCAN_CACHE_TTL_MS = 5_000;

let externalScanCache: {
	expiresAt: number;
	models: InstalledModel[];
} | null = null;
let externalScanPromise: Promise<InstalledModel[]> | null = null;

async function ensureRootDir(): Promise<void> {
	await fs.mkdir(localInferenceRoot(), { recursive: true });
}

async function readElizaOwned(): Promise<InstalledModel[]> {
	return (await readElizaOwnedDetailed()).models;
}

async function readElizaOwnedDetailed(): Promise<{
	models: InstalledModel[];
	/** True when the on-disk rows are not in canonical relative form. */
	needsRewrite: boolean;
}> {
	try {
		const raw = await fs.readFile(registryPath(), "utf8");
		const parsed = JSON.parse(raw) as RegistryFile;
		if (parsed?.version !== 1 || !Array.isArray(parsed.models)) {
			return { models: [], needsRewrite: false };
		}
		let needsRewrite = false;
		const models: InstalledModel[] = [];
		for (const stored of parsed.models) {
			const hydrated = hydrateStoredElizaModel(stored);
			if (!hydrated) {
				needsRewrite = true;
				continue;
			}
			if (!storedRowIsCanonical(stored, hydrated)) needsRewrite = true;
			models.push(hydrated);
		}
		return { models, needsRewrite };
	} catch {
		return { models: [], needsRewrite: false };
	}
}

/**
 * Self-healing read used by the list boundary: hydrate rows against the
 * CURRENT local-inference root, drop rows whose model artifact is genuinely
 * missing on disk (so callers surface a real not-downloaded state instead of
 * loading a dead path), and rewrite the registry once when legacy
 * absolute-path rows were migrated or dangling rows were dropped (#11669).
 */
async function readElizaOwnedHealed(): Promise<InstalledModel[]> {
	const { models, needsRewrite } = await readElizaOwnedDetailed();
	const present: InstalledModel[] = [];
	let dropped = false;
	for (const model of models) {
		if (await modelArtifactPresent(model.path)) {
			present.push(model);
		} else {
			dropped = true;
			logger.warn(
				`[LocalInferenceRegistry] Dropping registry entry "${model.id}": model file missing at ${model.path}; the model must be downloaded again`,
			);
		}
	}
	if (needsRewrite || dropped) {
		try {
			await writeElizaOwned(present);
			logger.info(
				`[LocalInferenceRegistry] Healed registry.json: ${present.length} model(s) persisted with container-relative paths`,
			);
		} catch (error) {
			logger.warn(
				`[LocalInferenceRegistry] Could not rewrite healed registry.json: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}
	return present;
}

async function modelArtifactPresent(modelPath: string): Promise<boolean> {
	try {
		return (await fs.stat(modelPath)).isFile();
	} catch {
		return false;
	}
}

function storedRowIsCanonical(
	stored: StoredInstalledModel,
	hydrated: InstalledModel,
): boolean {
	if (stored.path !== toLocalInferenceStoredPath(hydrated.path)) return false;
	if (
		(stored.bundleRoot === undefined) !==
		(hydrated.bundleRoot === undefined)
	) {
		return false;
	}
	if (
		hydrated.bundleRoot &&
		stored.bundleRoot !== toLocalInferenceStoredPath(hydrated.bundleRoot)
	) {
		return false;
	}
	if (
		(stored.manifestPath === undefined) !==
		(hydrated.manifestPath === undefined)
	) {
		return false;
	}
	if (
		hydrated.manifestPath &&
		stored.manifestPath !== toLocalInferenceStoredPath(hydrated.manifestPath)
	) {
		return false;
	}
	return true;
}

async function writeElizaOwned(models: InstalledModel[]): Promise<void> {
	await ensureRootDir();
	const tmp = `${registryPath()}.tmp`;
	const payload: RegistryFile = {
		version: 1,
		models: models.map(serializeElizaOwnedModel),
	};
	await fs.writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
	await fs.rename(tmp, registryPath());
}

function hydrateStoredElizaModel(
	model: StoredInstalledModel,
): InstalledModel | null {
	if (
		!model ||
		typeof model !== "object" ||
		model.source !== "eliza-download"
	) {
		return null;
	}
	if (typeof model.path !== "string") return null;
	const modelPath = resolveLocalInferenceStoredPath(model.path);
	if (!modelPath) return null;

	const bundleRoot =
		typeof model.bundleRoot === "string"
			? resolveLocalInferenceStoredPath(model.bundleRoot)
			: null;
	const manifestPath =
		typeof model.manifestPath === "string"
			? resolveLocalInferenceStoredPath(model.manifestPath)
			: null;

	// Build explicitly so a stored bundleRoot/manifestPath that failed to
	// resolve is dropped instead of leaking its raw stored string through.
	const {
		bundleRoot: _bundleRoot,
		manifestPath: _manifestPath,
		...rest
	} = model;
	return {
		...rest,
		path: modelPath,
		...(bundleRoot ? { bundleRoot } : {}),
		...(manifestPath ? { manifestPath } : {}),
	};
}

function serializeElizaOwnedModel(model: InstalledModel): StoredInstalledModel {
	const storedPath = toLocalInferenceStoredPath(model.path);
	if (!storedPath) {
		throw new Error(
			"[local-inference] Eliza-owned model path must live under the local-inference root",
		);
	}
	const storedBundleRoot = model.bundleRoot
		? toLocalInferenceStoredPath(model.bundleRoot)
		: null;
	if (model.bundleRoot && !storedBundleRoot) {
		throw new Error(
			"[local-inference] Eliza-owned bundle root must live under the local-inference root",
		);
	}
	const storedManifestPath = model.manifestPath
		? toLocalInferenceStoredPath(model.manifestPath)
		: null;
	if (model.manifestPath && !storedManifestPath) {
		throw new Error(
			"[local-inference] Eliza-owned manifest path must live under the local-inference root",
		);
	}
	return {
		...model,
		path: storedPath,
		...(storedBundleRoot ? { bundleRoot: storedBundleRoot } : {}),
		...(storedManifestPath ? { manifestPath: storedManifestPath } : {}),
	};
}

function externalScanEnabled(): boolean {
	const value =
		process.env.ELIZA_LOCAL_INFERENCE_ENABLE_EXTERNAL_SCAN?.trim().toLowerCase();
	return value === "1" || value === "true" || value === "yes";
}

function isSubpath(target: string, root: string): boolean {
	const relative = path.relative(root, target);
	return (
		relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
	);
}

async function resolveRemovableElizaPath(
	target: string,
): Promise<
	| { status: "safe"; path: string }
	| { status: "missing" }
	| { status: "unsafe" }
> {
	if (!isWithinElizaRoot(target)) return { status: "unsafe" };

	let rootRealPath: string;
	try {
		rootRealPath = await fs.realpath(localInferenceRoot());
	} catch {
		return { status: "missing" };
	}

	try {
		const targetRealPath = await fs.realpath(target);
		if (!isSubpath(targetRealPath, rootRealPath)) {
			return { status: "unsafe" };
		}
		return { status: "safe", path: target };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { status: "missing" };
		}
		throw error;
	}
}

async function scanExternalModelsCached(): Promise<InstalledModel[]> {
	const now = Date.now();
	if (externalScanCache && externalScanCache.expiresAt > now) {
		return externalScanCache.models;
	}
	externalScanPromise ??= scanExternalModels()
		.then((models) => {
			externalScanCache = {
				expiresAt: Date.now() + EXTERNAL_SCAN_CACHE_TTL_MS,
				models,
			};
			return models;
		})
		.finally(() => {
			externalScanPromise = null;
		});
	return externalScanPromise;
}

/**
 * Return models currently usable by the curated local-inference path.
 *
 * Normal product behavior is Eliza-1 only. The external scan remains available
 * only to developers who explicitly opt into the old arbitrary-GGUF diagnostic
 * path with `ELIZA_LOCAL_INFERENCE_ENABLE_EXTERNAL_SCAN=1`. External scans are
 * cached briefly and shared while in flight because model-hub UI refreshes can
 * arrive in bursts during active downloads.
 */
export async function listInstalledModels(): Promise<InstalledModel[]> {
	const owned = await readElizaOwnedHealed();
	if (!externalScanEnabled()) return owned;

	// Filter out Eliza-owned files that also survived a reboot of the local
	// file and got re-detected by the scanner.
	const external = await scanExternalModelsCached();
	const ownedPaths = new Set(owned.map((m) => path.resolve(m.path)));
	const dedupedExternal = external.filter(
		(m) => !ownedPaths.has(path.resolve(m.path)),
	);

	// Backfill `runtimeClass` once, at the canonical read boundary: legacy
	// registry rows and freshly scanned external models predate the field.
	// Downstream (dispatcher, load-arg resolver, UI) reads the field rather
	// than re-deriving the class from the id.
	return [...owned, ...dedupedExternal].map(withRuntimeClass);
}

/** Add or update a Eliza-owned entry. External entries are rejected. */
export async function upsertElizaModel(model: InstalledModel): Promise<void> {
	if (model.source !== "eliza-download") {
		throw new Error(
			"[local-inference] registry only accepts Eliza-owned models",
		);
	}
	if (!isWithinElizaRoot(model.path)) {
		throw new Error(
			"[local-inference] Eliza-owned models must live under the local-inference root",
		);
	}
	if (model.bundleRoot && !isWithinElizaRoot(model.bundleRoot)) {
		throw new Error(
			"[local-inference] Eliza-owned bundle roots must live under the local-inference root",
		);
	}
	if (model.manifestPath && !isWithinElizaRoot(model.manifestPath)) {
		throw new Error(
			"[local-inference] Eliza-owned manifests must live under the local-inference root",
		);
	}
	const owned = await readElizaOwned();
	const withoutCurrent = owned.filter((m) => m.id !== model.id);
	withoutCurrent.push(model);
	await writeElizaOwned(withoutCurrent);
}

/** Mark an existing Eliza-owned model as most-recently-used. */
export async function touchElizaModel(id: string): Promise<void> {
	const owned = await readElizaOwned();
	const target = owned.find((m) => m.id === id);
	if (!target) return;
	target.lastUsedAt = new Date().toISOString();
	await writeElizaOwned(owned);
}

/**
 * Delete a Eliza-owned model from the registry and from disk.
 *
 * Refuses if the model was discovered from another tool — Eliza must not
 * touch files it doesn't own. Callers surface that refusal as a 4xx.
 */
export async function removeElizaModel(id: string): Promise<{
	removed: boolean;
	reason?: "external" | "not-found";
}> {
	const owned = await readElizaOwned();
	const target = owned.find((m) => m.id === id);
	if (!target) {
		// Check whether it's a known external entry so we can return a
		// helpful error message instead of 404.
		const external = await scanExternalModels();
		if (external.some((m) => m.id === id)) {
			return { removed: false, reason: "external" };
		}
		return { removed: false, reason: "not-found" };
	}

	if (!isWithinElizaRoot(target.path)) {
		return { removed: false, reason: "external" };
	}

	const removePath =
		target.bundleRoot && isWithinElizaRoot(target.bundleRoot)
			? target.bundleRoot
			: target.path;
	const removable = await resolveRemovableElizaPath(removePath);
	if (removable.status === "unsafe") {
		return { removed: false, reason: "external" };
	}
	try {
		if (removable.status === "safe") {
			await fs.rm(removable.path, { recursive: true, force: true });
		}
	} catch {
		// If the file was already gone we still want to clear the registry entry.
	}

	await writeElizaOwned(owned.filter((m) => m.id !== id));
	return { removed: true };
}
