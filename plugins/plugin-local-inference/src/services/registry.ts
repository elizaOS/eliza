/**
 * On-disk registry of installed models.
 *
 * The default registry contains only Eliza-owned downloads
 * (source: "eliza-download") written on successful completion by the
 * curated bundle downloader. External scans are developer-only diagnostics
 * behind `ELIZA_LOCAL_INFERENCE_ENABLE_EXTERNAL_SCAN=1`; they never enter
 * first-run, setup, or normal Settings surfaces.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ElizaError, logger } from "@elizaos/core";
import {
	ELIZA_1_BUNDLE_SLUGS,
	ELIZA_1_PUBLISHED_TIER_IDS,
	MODEL_CATALOG,
} from "./catalog";
import { scanExternalModels } from "./external-scanner";
import {
	elizaModelsDir,
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
let registryMutationTail: Promise<void> = Promise.resolve();

function errnoCode(error: unknown): string | undefined {
	if (
		typeof error !== "object" ||
		error === null ||
		!("code" in error) ||
		typeof error.code !== "string"
	) {
		return undefined;
	}
	return error.code;
}

async function withRegistryMutation<T>(
	operation: () => Promise<T>,
): Promise<T> {
	const result = registryMutationTail.then(operation);
	registryMutationTail = result.then(
		() => undefined,
		() => undefined,
	);
	return result;
}

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
			throw new ElizaError(
				"[LocalInferenceRegistry] registry.json has an unsupported shape",
				{
					code: "LOCAL_INFERENCE_REGISTRY_INVALID",
					context: { path: registryPath() },
					severity: "fatal",
				},
			);
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
	} catch (error) {
		if (errnoCode(error) === "ENOENT") {
			// error-policy:J4 A missing registry is the designed first-run state.
			return { models: [], needsRewrite: false };
		}
		if (error instanceof ElizaError) throw error;
		throw new ElizaError(
			"[LocalInferenceRegistry] Could not read registry.json",
			{
				code: "LOCAL_INFERENCE_REGISTRY_READ_FAILED",
				context: { path: registryPath() },
				cause: error,
				severity: "fatal",
			},
		);
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
	const recovered = await discoverOrphanedOwnedModels(present);
	const healed = [...present, ...recovered];
	if (needsRewrite || dropped || recovered.length > 0) {
		await writeElizaOwned(healed);
		logger.info(
			`[LocalInferenceRegistry] Healed registry.json: ${healed.length} model(s) persisted with container-relative paths`,
		);
	}
	return healed;
}

function ownedFlatFileNames(modelId: string, catalogFile: string): Set<string> {
	const names = new Set([path.basename(catalogFile).toLowerCase()]);
	const stableSlug = modelId.replace(/^eliza-1-/, "");
	const publishedSlug =
		ELIZA_1_BUNDLE_SLUGS[modelId as keyof typeof ELIZA_1_BUNDLE_SLUGS];
	for (const slug of [stableSlug, publishedSlug]) {
		if (!slug) continue;
		for (const context of ["32k", "64k", "128k", "256k"]) {
			names.add(`eliza-1-${slug}-${context}.gguf`.toLowerCase());
		}
	}
	return names;
}

async function hasGgufHeader(filePath: string): Promise<boolean> {
	let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
	try {
		handle = await fs.open(filePath, "r");
		const header = Buffer.allocUnsafe(4);
		const { bytesRead } = await handle.read(header, 0, header.length, 0);
		return bytesRead === header.length && header.toString("ascii") === "GGUF";
	} catch (error) {
		if (errnoCode(error) === "ENOENT") {
			// error-policy:J3 A disappeared candidate is explicitly invalid.
			return false;
		}
		throw error;
	} finally {
		if (handle) await handle.close();
	}
}

/**
 * Recover first-party mobile downloads that reached the app-owned model
 * directory before the registry write completed. Only exact curated Eliza-1
 * filenames with a real GGUF header qualify; arbitrary blobs remain outside
 * the product registry and require the explicit external-scan developer path.
 */
async function discoverOrphanedOwnedModels(
	registered: InstalledModel[],
): Promise<InstalledModel[]> {
	let entries: import("node:fs").Dirent[];
	try {
		entries = await fs.readdir(elizaModelsDir(), { withFileTypes: true });
	} catch (error) {
		if (errnoCode(error) === "ENOENT") {
			// error-policy:J4 No model directory is the designed pre-download state.
			return [];
		}
		throw error;
	}
	const registeredIds = new Set(registered.map((model) => model.id));
	const publishedIds = new Set<string>(ELIZA_1_PUBLISHED_TIER_IDS);
	const recovered: InstalledModel[] = [];
	for (const catalogModel of MODEL_CATALOG) {
		if (!publishedIds.has(catalogModel.id)) continue;
		if (registeredIds.has(catalogModel.id)) continue;
		const acceptedNames = ownedFlatFileNames(
			catalogModel.id,
			catalogModel.ggufFile,
		);
		const entry = entries.find(
			(candidate) =>
				candidate.isFile() && acceptedNames.has(candidate.name.toLowerCase()),
		);
		if (!entry) continue;
		const modelPath = path.join(elizaModelsDir(), entry.name);
		if (!(await hasGgufHeader(modelPath))) continue;
		const stat = await fs.stat(modelPath);
		const timestampMs = stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs;
		recovered.push({
			id: catalogModel.id,
			displayName: catalogModel.displayName,
			path: modelPath,
			sizeBytes: stat.size,
			hfRepo: catalogModel.hfRepo,
			installedAt: new Date(timestampMs).toISOString(),
			lastUsedAt: null,
			runtimeClass: catalogModel.runtimeClass,
			source: "eliza-download",
		});
	}
	return recovered;
}

async function modelArtifactPresent(modelPath: string): Promise<boolean> {
	try {
		return (await fs.stat(modelPath)).isFile();
	} catch (error) {
		if (errnoCode(error) === "ENOENT") {
			// error-policy:J3 A missing artifact is an explicit invalid registry row.
			return false;
		}
		throw error;
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
	const tmp = `${registryPath()}.tmp-${process.pid}-${randomUUID()}`;
	const payload: RegistryFile = {
		version: 1,
		models: models.map(serializeElizaOwnedModel),
	};
	try {
		await fs.writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
		await fs.rename(tmp, registryPath());
	} catch (error) {
		try {
			await fs.rm(tmp, { force: true });
		} catch (cleanupError) {
			// error-policy:J6 A failed scratch-file cleanup must not replace the registry error.
			logger.warn(
				`[LocalInferenceRegistry] Could not remove temporary registry file ${tmp}: ${
					cleanupError instanceof Error
						? cleanupError.message
						: String(cleanupError)
				}`,
			);
		}
		throw new ElizaError(
			"[LocalInferenceRegistry] Could not persist registry.json",
			{
				code: "LOCAL_INFERENCE_REGISTRY_WRITE_FAILED",
				context: { path: registryPath() },
				cause: error,
				severity: "fatal",
			},
		);
	}
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
	} catch (error) {
		if (errnoCode(error) === "ENOENT") {
			// error-policy:J3 A missing root makes the removal target explicitly absent.
			return { status: "missing" };
		}
		throw error;
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
	const owned = (await withRegistryMutation(() => readElizaOwnedHealed())).map(
		withRuntimeClass,
	);
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
	await withRegistryMutation(async () => {
		const owned = await readElizaOwned();
		const withoutCurrent = owned.filter((m) => m.id !== model.id);
		withoutCurrent.push(model);
		await writeElizaOwned(withoutCurrent);
	});
}

/** Mark an existing Eliza-owned model as most-recently-used. */
export async function touchElizaModel(id: string): Promise<void> {
	await withRegistryMutation(async () => {
		const owned = await readElizaOwned();
		const target = owned.find((m) => m.id === id);
		if (!target) return;
		target.lastUsedAt = new Date().toISOString();
		await writeElizaOwned(owned);
	});
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
	return withRegistryMutation(async () => {
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
		if (removable.status === "safe") {
			await fs.rm(removable.path, { recursive: true, force: true });
		}

		await writeElizaOwned(owned.filter((m) => m.id !== id));
		return { removed: true };
	});
}
