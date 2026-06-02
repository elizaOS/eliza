/**
 * Coordinates which model is currently loaded into the plugin-local-ai
 * runtime. Eliza runs one inference model at a time; switching models
 * unloads the previous one first so we don't double-allocate VRAM.
 *
 * This module *does not* talk to `capacitor-llama` directly. The plugin
 * owns the native binding; we ask it to swap via a small runtime service
 * registered under the name "localInferenceLoader". When the plugin is not
 * enabled, we still track the user's preferred active model so the
 * preference survives enabling the plugin later.
 */

import { existsSync, readFileSync } from "node:fs";
import {
	dirname as pathDirname,
	join as pathJoin,
	resolve as pathResolve,
} from "node:path";
import type { AgentRuntime } from "@elizaos/core";
import {
	ELIZA_1_PLACEHOLDER_IDS,
	FIRST_RUN_DEFAULT_MODEL_ID,
	findCatalogModel,
} from "./catalog";
import { localInferenceEngine } from "./engine";
import { probeHardware } from "./hardware";
import type { Eliza1Manifest } from "./manifest";
import {
	assessRamFit,
	defaultManifestLoader,
	type ManifestLoader,
	pickFittingContextVariant,
	type RamFitOptions,
} from "./ram-budget";
import { recommendForFirstRun } from "./recommendation";
import { touchElizaModel } from "./registry";
import type {
	ActiveModelState,
	CatalogModel,
	HardwareProbe,
	InstalledModel,
} from "./types";
import {
	assessVoiceBundleFits,
	VOICE_ENSEMBLE_BUDGETS,
	type VoiceTierSlot,
} from "./voice/voice-budget";

export type { KvOffloadMode, LocalInferenceLoadArgs } from "./load-args.js";
export {
	ELIZA_1_PLACEHOLDER_IDS,
	FIRST_RUN_DEFAULT_MODEL_ID,
	recommendForFirstRun,
};

import type { KvOffloadMode, LocalInferenceLoadArgs } from "./load-args.js";

/**
 * Allow-list for KV cache type strings. The eliza fork of node-llama-cpp
 * (v3.18.1-eliza.3+) extends `GgmlType` with TBQ3_0 (43), TBQ4_0 (44),
 * QJL1_256 (46), Q4_POLAR (47) so the binding accepts the lowercase
 * aliases below. Whether the C++ kernel actually runs depends on the
 * loaded the legacy node-llama-cpp NAPI prebuild (no longer used) binary — the elizaOS/llama.cpp
 * prebuild ships the kernels; upstream's prebuild does not.
 *
 * `validateLocalInferenceLoadArgs({ allowFork: false })` (the route-layer
 * default) still throws on these strings so a UI/API caller can't land
 * the desktop on a kernel that won't run; `allowFork: true` (the AOSP +
 * resolved-args path) lets them through.
 */
const FORK_ONLY_KV_CACHE_TYPES = new Set([
	"tbq1_0",
	"tbq2_0",
	"tbq3_0",
	"tbq4_0",
	"tbq3_0_tcq",
	"turbo2",
	"turbo3",
	"turbo4",
	"turbo2_0",
	"turbo3_0",
	"turbo4_0",
	"turbo2_tcq",
	"turbo3_tcq",
	"qjl1_256",
	"qjl1_512",
	"q4_polar",
]);

const STOCK_KV_CACHE_TYPES = new Set([
	"f16",
	"f32",
	"bf16",
	"q4_0",
	"q4_1",
	"q5_0",
	"q5_1",
	"q8_0",
	"q4_k",
	"q5_k",
	"q6_k",
	"q8_k",
	"iq4_nl",
]);

export function isForkOnlyKvCacheType(name: string | undefined): boolean {
	if (!name) return false;
	return FORK_ONLY_KV_CACHE_TYPES.has(name.trim().toLowerCase());
}

export function isStockKvCacheType(name: string | undefined): boolean {
	if (!name) return false;
	return STOCK_KV_CACHE_TYPES.has(name.trim().toLowerCase());
}

/**
 * Validate per-load overrides against what the in-process backend can
 * honour. The AOSP loader has its own (broader) acceptance set — pass
 * `{ allowFork: true }` to skip the desktop-only restriction.
 *
 * Throws on the first illegal value so the caller (the API route) can
 * surface a 400 with a useful message instead of letting the load slip
 * through and silently degrade to fp16.
 */
export function validateLocalInferenceLoadArgs(
	args: Partial<LocalInferenceLoadArgs>,
	options: { allowFork?: boolean } = {},
): void {
	const allowFork = options.allowFork === true;
	for (const field of ["cacheTypeK", "cacheTypeV"] as const) {
		const value = args[field];
		if (value === undefined) continue;
		if (typeof value !== "string" || value.length === 0) {
			throw new Error(`${field} must be a non-empty string`);
		}
		if (!allowFork && isForkOnlyKvCacheType(value)) {
			throw new Error(
				`${field}="${value}" requires the elizaOS/llama.cpp kernel from the elizaOS fork. The elizaOS/capacitor-llama binding accepts the string at the TS layer, but the upstream @node-llama-cpp/<platform> prebuild does not implement the underlying ggml type. Pass through the AOSP path or load the elizaOS/llama.cpp prebuilt binary. Stock-only types accepted here: ${[...STOCK_KV_CACHE_TYPES].join(", ")}.`,
			);
		}
		if (!allowFork && !isStockKvCacheType(value)) {
			throw new Error(
				`${field}="${value}" is not a recognised KV cache type. Stock builds accept ${[...STOCK_KV_CACHE_TYPES].join(", ")}.`,
			);
		}
		if (
			allowFork &&
			!isStockKvCacheType(value) &&
			!isForkOnlyKvCacheType(value)
		) {
			throw new Error(
				`${field}="${value}" is not a recognised KV cache type. Accepted stock types: ${[...STOCK_KV_CACHE_TYPES].join(", ")}. Accepted elizaOS fork types: ${[...FORK_ONLY_KV_CACHE_TYPES].join(", ")}.`,
			);
		}
	}
	if (args.contextSize !== undefined) {
		if (
			typeof args.contextSize !== "number" ||
			!Number.isInteger(args.contextSize) ||
			args.contextSize < 256
		) {
			throw new Error(
				`contextSize must be a positive integer >= 256 (got ${String(args.contextSize)})`,
			);
		}
	}
	if (args.gpuLayers !== undefined) {
		if (
			typeof args.gpuLayers !== "number" ||
			!Number.isInteger(args.gpuLayers) ||
			args.gpuLayers < 0
		) {
			throw new Error(
				`gpuLayers must be a non-negative integer (got ${String(args.gpuLayers)})`,
			);
		}
	}
	if (args.kvOffload !== undefined) {
		const v = args.kvOffload;
		if (typeof v === "string") {
			if (v !== "cpu" && v !== "gpu" && v !== "split") {
				throw new Error(
					`kvOffload must be "cpu", "gpu", "split", or { gpuLayers: number } (got "${v}")`,
				);
			}
		} else if (
			!v ||
			typeof v !== "object" ||
			typeof (v as { gpuLayers?: unknown }).gpuLayers !== "number"
		) {
			throw new Error(
				`kvOffload must be "cpu", "gpu", "split", or { gpuLayers: number }`,
			);
		}
	}
	for (const field of ["flashAttention", "mmap", "mlock"] as const) {
		const value = args[field];
		if (value === undefined) continue;
		if (typeof value !== "boolean") {
			throw new Error(`${field} must be a boolean`);
		}
	}
}

export interface LocalInferenceLoader {
	loadModel(args: LocalInferenceLoadArgs): Promise<void>;
	unloadModel(): Promise<void>;
	currentModelPath(): string | null;
	/**
	 * Optional generation surface. When a loader implements this, the runtime
	 * handler (`ensure-local-inference-handler.ts`) routes TEXT_SMALL /
	 * TEXT_LARGE requests through it instead of the standalone engine. Mobile
	 * builds populate this via the Capacitor adapter; desktop leaves it
	 * unimplemented and falls back to the `LocalInferenceEngine`.
	 */
	generate?(args: {
		prompt: string;
		stopSequences?: string[];
		maxTokens?: number;
		temperature?: number;
		/**
		 * Optional `promptCacheKey` from the runtime cache plan. Loaders
		 * that implement prefix caching (the in-process llama.cpp FFI slot
		 * pool or node-llama-cpp session pool) use this to pin
		 * subsequent calls with the same key to the same KV cache slot.
		 * Loaders without prefix caching can ignore the field.
		 */
		cacheKey?: string;
	}): Promise<string>;
	/**
	 * Optional embedding surface. When a loader implements this, the runtime
	 * handler routes `TEXT_EMBEDDING` requests through it. The AOSP bun:ffi
	 * loader populates this directly via `llama_get_embeddings_seq`; the
	 * device-bridge loader populates it by dispatching an `embed` frame to
	 * the connected device. Loaders that cannot embed leave this undefined,
	 * and the runtime falls back to its non-local embedding provider chain.
	 */
	embed?(args: { input: string }): Promise<{
		embedding: number[];
		tokens: number;
	}>;
}

/**
 * Per-load override fields the caller can set. Subset of `LocalInferenceLoadArgs`
 * minus `modelPath` (which the coordinator owns) and minus speculative
 * fields (which the catalog `runtime.mtp` block owns end-to-end). The
 * route layer accepts this shape on `POST /api/local-inference/active`.
 */
export interface LocalInferenceLoadOverrides {
	contextSize?: number;
	cacheTypeK?: string;
	cacheTypeV?: string;
	gpuLayers?: number;
	kvOffload?: KvOffloadMode;
	flashAttention?: boolean;
	mmap?: boolean;
	mlock?: boolean;
	useGpu?: boolean;
	maxThreads?: number;
}

interface ResolveLocalInferenceLoadArgsOptions {
	manifestLoader?: ManifestLoader;
}

function bundleRootForInstalledModel(installed: InstalledModel): string {
	return installed.bundleRoot ?? pathDirname(pathDirname(installed.path));
}

function manifestTextContextForInstalledPath(
	installed: InstalledModel,
	manifest: Eliza1Manifest,
): number | undefined {
	const modelPath = pathResolve(installed.path);
	const bundleRoot = bundleRootForInstalledModel(installed);
	for (const entry of manifest.files.text) {
		if (
			typeof entry.ctx !== "number" ||
			!Number.isInteger(entry.ctx) ||
			entry.ctx < 256
		) {
			continue;
		}
		if (pathResolve(bundleRoot, entry.path) === modelPath) {
			return entry.ctx;
		}
	}
	return undefined;
}

function candidateManifestPaths(installed: InstalledModel): string[] {
	const candidates = [
		installed.manifestPath,
		installed.bundleRoot
			? pathJoin(installed.bundleRoot, "eliza-1.manifest.json")
			: undefined,
		pathJoin(pathDirname(pathDirname(installed.path)), "eliza-1.manifest.json"),
		pathJoin(pathDirname(installed.path), "eliza-1.manifest.json"),
	];
	return [...new Set(candidates.filter((p): p is string => Boolean(p)))];
}

function readLegacyStagedManifestTextContext(
	installed: InstalledModel,
): number | undefined {
	if (installed.source !== "eliza-download") return undefined;
	const modelPath = pathResolve(installed.path);
	const bundleRoot = bundleRootForInstalledModel(installed);

	for (const manifestPath of candidateManifestPaths(installed)) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
		} catch {
			continue;
		}
		if (!parsed || typeof parsed !== "object") continue;
		const raw = parsed as {
			id?: unknown;
			version?: unknown;
			defaultEligible?: unknown;
			files?: { text?: unknown };
		};
		if (typeof raw.id === "string" && raw.id !== installed.id) continue;
		const version = typeof raw.version === "string" ? raw.version : "";
		const stagedOrCandidate =
			raw.defaultEligible === false ||
			/(?:candidate|staged|dev|local)/i.test(version);
		if (!stagedOrCandidate) continue;
		if (!Array.isArray(raw.files?.text)) continue;
		for (const entry of raw.files.text) {
			if (!entry || typeof entry !== "object") continue;
			const file = entry as { path?: unknown; ctx?: unknown };
			if (typeof file.path !== "string") continue;
			if (
				typeof file.ctx !== "number" ||
				!Number.isInteger(file.ctx) ||
				file.ctx < 256
			) {
				continue;
			}
			if (pathResolve(bundleRoot, file.path) === modelPath) {
				return file.ctx;
			}
		}
	}
	return undefined;
}

function installedBundleContextSize(
	installed: InstalledModel,
	manifestLoader: ManifestLoader,
): number | undefined {
	const manifest = manifestLoader(installed.id, installed);
	if (manifest) {
		const contextSize = manifestTextContextForInstalledPath(
			installed,
			manifest,
		);
		if (contextSize !== undefined) return contextSize;
	}
	return readLegacyStagedManifestTextContext(installed);
}

function applyCatalogDefaults(
	args: LocalInferenceLoadArgs,
	installed: InstalledModel,
	catalog: CatalogModel | undefined,
	manifestLoader: ManifestLoader,
): void {
	const runtime = catalog?.runtime;

	// KV cache types from the catalog runtime block. Per-call overrides
	// take precedence and are merged in afterwards.
	if (runtime?.kvCache?.typeK) args.cacheTypeK = runtime.kvCache.typeK;
	if (runtime?.kvCache?.typeV) args.cacheTypeV = runtime.kvCache.typeV;

	// Catalog-level model ceiling. Without a per-load override, plumb the
	// model's true `contextLength` so the loader picks an appropriate
	// window instead of falling back to whatever default the binding
	// happens to use ("auto" → smallest fitting, which historically meant
	// 4k or 8k even for 128k-trained models).
	if (args.contextSize === undefined) {
		args.contextSize =
			installedBundleContextSize(installed, manifestLoader) ??
			catalog?.contextLength;
	}

	// Catalog-declared GPU offload default — only apply when the caller
	// didn't override `gpuLayers`. Numeric `gpuLayers` is the canonical
	// shape; `"auto"` is the loader's default and we don't need to set
	// anything for it.
	if (
		catalog?.gpuLayers !== undefined &&
		typeof catalog.gpuLayers === "number" &&
		args.gpuLayers === undefined
	) {
		args.gpuLayers = catalog.gpuLayers;
	}

	// flashAttention default from catalog optimizations block. Per-load
	// overrides win.
	if (
		runtime?.optimizations?.flashAttention !== undefined &&
		args.flashAttention === undefined
	) {
		args.flashAttention = runtime.optimizations.flashAttention;
	}

	// mmap / mlock from catalog optimizations. `noMmap === true` means
	// disable mmap explicitly; otherwise leave the loader default.
	if (runtime?.optimizations?.noMmap !== undefined && args.mmap === undefined) {
		args.mmap = !runtime.optimizations.noMmap;
	}
	if (runtime?.optimizations?.mlock !== undefined && args.mlock === undefined) {
		args.mlock = runtime.optimizations.mlock;
	}
}

function mergeOverrides(
	args: LocalInferenceLoadArgs,
	overrides: LocalInferenceLoadOverrides | undefined,
): void {
	if (!overrides) return;
	if (overrides.contextSize !== undefined)
		args.contextSize = overrides.contextSize;
	if (overrides.cacheTypeK !== undefined)
		args.cacheTypeK = overrides.cacheTypeK;
	if (overrides.cacheTypeV !== undefined)
		args.cacheTypeV = overrides.cacheTypeV;
	if (overrides.gpuLayers !== undefined) args.gpuLayers = overrides.gpuLayers;
	if (overrides.kvOffload !== undefined) args.kvOffload = overrides.kvOffload;
	if (overrides.flashAttention !== undefined) {
		args.flashAttention = overrides.flashAttention;
	}
	if (overrides.mmap !== undefined) args.mmap = overrides.mmap;
	if (overrides.mlock !== undefined) args.mlock = overrides.mlock;
	if (overrides.useGpu !== undefined) args.useGpu = overrides.useGpu;
	if (overrides.maxThreads !== undefined)
		args.maxThreads = overrides.maxThreads;
}

/**
 * Resolve the per-tier mmproj GGUF path for a given installed model when
 * the catalog declares the tier ships a vision projector AND the file is
 * actually on disk under the bundle root.
 *
 * Returns:
 *   - the absolute path to the mmproj file when the tier has vision and
 *     the file exists.
 *   - undefined when the tier has no vision component (text-only bundle)
 *     or when the file hasn't been downloaded yet. In the latter case
 *     the coordinator emits a one-shot warning; vision capability is
 *     unavailable for the session but the text load still succeeds.
 *
 * Path layout: the catalog's `sourceModel.components.vision.file` is the
 * Hugging Face-relative path, e.g. `bundles/2b/vision/mmproj-2b.gguf`.
 * Locally the bundleRoot already represents the per-tier "bundles/<tier>"
 * subtree, so we strip the leading `bundles/<tier>/` segment before
 * joining against the local bundleRoot. When that prefix isn't present
 * (e.g. a custom bundle layout), we fall through to the original path
 * unchanged. Manifest-validated bundles (`bundleRoot` set) are the only
 * path that lands a vision component — external-scan models (LM Studio,
 * Jan) don't.
 */
export function resolveMmprojPath(
	installed: InstalledModel,
	catalog: CatalogModel | undefined,
): string | undefined {
	if (!catalog) return undefined;
	const visionComponent = catalog.sourceModel?.components?.vision;
	if (!visionComponent?.file) return undefined;
	const bundleRoot = installed.bundleRoot;
	if (!bundleRoot) return undefined;
	const local = stripBundlePrefix(visionComponent.file, installed.id);
	const candidate = pathJoin(bundleRoot, local);
	if (!existsSync(candidate)) return undefined;
	return candidate;
}

function resolveMtpDrafterPath(
	installed: InstalledModel,
	catalog: CatalogModel | undefined,
	manifestLoader: ManifestLoader,
): string | undefined {
	const bundleRoot = installed.bundleRoot;
	if (!bundleRoot) return undefined;

	const manifest = manifestLoader(installed.id, installed);
	for (const entry of manifest?.files.mtp ?? []) {
		const candidate = pathJoin(bundleRoot, entry.path);
		if (existsSync(candidate)) return candidate;
	}

	const catalogFile =
		catalog?.runtime?.mtp?.drafterFile ??
		catalog?.sourceModel?.components?.mtp?.file;
	if (!catalogFile) return undefined;
	const local = stripBundlePrefix(catalogFile, installed.id);
	const candidate = pathJoin(bundleRoot, local);
	if (!existsSync(candidate)) return undefined;
	return candidate;
}

/**
 * Strip the `bundles/<tier-slug>/` prefix the catalog uses for HF
 * paths so the remaining string is bundle-root-relative. When the
 * prefix isn't present, return the input unchanged.
 */
function stripBundlePrefix(catalogFile: string, modelId: string): string {
	const slug = modelId.startsWith("eliza-1-")
		? modelId.slice("eliza-1-".length)
		: modelId;
	const prefix = `bundles/${slug}/`;
	if (catalogFile.startsWith(prefix)) {
		return catalogFile.slice(prefix.length);
	}
	return catalogFile;
}

export async function resolveLocalInferenceLoadArgs(
	installed: InstalledModel,
	overrides?: LocalInferenceLoadOverrides,
	options: ResolveLocalInferenceLoadArgsOptions = {},
): Promise<LocalInferenceLoadArgs> {
	const args: LocalInferenceLoadArgs = { modelPath: installed.path };
	const catalog = findCatalogModel(installed.id);
	const runtime = catalog?.runtime;
	const manifestLoader = options.manifestLoader ?? defaultManifestLoader;

	applyCatalogDefaults(args, installed, catalog, manifestLoader);

	// WS2: when the tier declares vision and the per-tier mmproj GGUF is
	// already on disk, plumb the path. The text load is never gated on
	// mmproj — when the file is missing on a vision-capable tier the
	// coordinator emits a one-shot warning and continues.
	const mmprojPath = resolveMmprojPath(installed, catalog);
	if (mmprojPath) {
		args.mmprojPath = mmprojPath;
	}

	const mtp = runtime?.mtp;
	if (mtp) {
		// Native MTP launch defaults. Do NOT replace catalog `contextLength`
		// here; `applyCatalogDefaults` owns the chat-side context. The MTP
		// block only owns the speculative draft window.
		//
		// Two MTP shapes: same-file MTP embeds the NextN head in the text
		// GGUF (no `drafterFile` in the catalog) and runs with no separate
		// draft model; separate-drafter MTP declares a `drafterFile` and
		// requires the bundled drafter GGUF to be present on disk.
		const sameFileMtp = !mtp.drafterFile;
		const drafterPath = sameFileMtp
			? undefined
			: resolveMtpDrafterPath(installed, catalog, manifestLoader);
		if (!sameFileMtp && installed.bundleRoot && !drafterPath) {
			throw new Error(
				`[local-inference] ${installed.id} declares a separate-drafter MTP but no bundled drafter GGUF was found under ${installed.bundleRoot}`,
			);
		}
		args.useGpu = true;
		args.draftModelPath = drafterPath;
		args.draftMin = mtp.draftMin;
		args.draftMax = mtp.draftMax;
		args.speculativeSamples = mtp.draftMax;
		args.mobileSpeculative = true;
	}

	mergeOverrides(args, overrides);
	if (args.cacheTypeK) args.cacheTypeK = args.cacheTypeK.trim().toLowerCase();
	if (args.cacheTypeV) args.cacheTypeV = args.cacheTypeV.trim().toLowerCase();

	// Validate the final merged args. The route layer is the one
	// that calls `validateLocalInferenceLoadArgs` with `allowFork: false`
	// against just the overrides — see `local-inference-compat-routes.ts`.
	validateLocalInferenceLoadArgs(args, { allowFork: true });
	return args;
}

const MB_PER_GB = 1024;

export class ModelDoesNotFitError extends Error {
	readonly modelId: string;
	readonly requiredMb: number;
	readonly usableMb: number;
	readonly hostRamMb: number;
	readonly fittingVariantId: string | null;

	constructor(args: {
		modelId: string;
		requiredMb: number;
		usableMb: number;
		hostRamMb: number;
		fittingVariantId: string | null;
	}) {
		const variantHint = args.fittingVariantId
			? args.fittingVariantId === args.modelId
				? ""
				: ` The largest context variant of this tier that would fit is "${args.fittingVariantId}".`
			: " No context variant of this tier fits this host.";
		super(
			`[local-inference] Model "${args.modelId}" needs ~${args.requiredMb} MB RAM to boot, but only ~${args.usableMb} MB are usable on this host (${args.hostRamMb} MB total, after the OS/runtime headroom reserve). Refusing to load it.${variantHint} Pick a smaller tier in Settings → Model Hub, or set ELIZA_LOCAL_RAM_HEADROOM_MB lower if you accept running closer to the limit.`,
		);
		this.name = "ModelDoesNotFitError";
		this.modelId = args.modelId;
		this.requiredMb = args.requiredMb;
		this.usableMb = args.usableMb;
		this.hostRamMb = args.hostRamMb;
		this.fittingVariantId = args.fittingVariantId;
	}
}

/**
 * Admission gate: refuse a model load when the host can't fit the bundle's
 * boot floor. `hostRamMb` is the host's total RAM in megabytes. `installed`
 * is forwarded to `assessRamFit` so a manifest-declared `ramBudgetMb` wins
 * over the catalog scalar. Throws `ModelDoesNotFitError` on no-fit; returns
 * the (advisory) fit decision otherwise so callers can log a `tight` warning.
 *
 * Models with no catalog entry (external HF blobs) are not gated — the
 * catalog has no RAM budget for them, so we trust the operator's explicit
 * pick (the dispatcher's load-time error surfaces if it genuinely OOMs).
 */
export function assertModelFitsHost(
	installed: InstalledModel,
	hostRamMb: number,
	options: RamFitOptions = {},
): { level: "fits" | "tight"; minMb: number; recommendedMb: number } {
	const catalog = findCatalogModel(installed.id);
	if (!catalog) return { level: "fits", minMb: 0, recommendedMb: 0 };
	const fit = assessRamFit(catalog, hostRamMb, { ...options, installed });
	if (fit.fits) {
		return {
			level: fit.level === "wontfit" ? "tight" : fit.level,
			minMb: fit.budget.minMb,
			recommendedMb: fit.budget.recommendedMb,
		};
	}
	const fitting = pickFittingContextVariant(catalog, hostRamMb, {
		...options,
		installed,
	});
	throw new ModelDoesNotFitError({
		modelId: installed.id,
		requiredMb: fit.budget.minMb,
		usableMb: fit.usableMb,
		hostRamMb,
		fittingVariantId: fitting?.id ?? null,
	});
}

/**
 * Typed error for refused local-voice sessions. Mirrors
 * `ModelDoesNotFitError` but at the bundle level — emitted by
 * `assertVoiceBundleFitsHost` when the whole co-resident voice + text stack
 * cannot fit a host's RAM (per R9 §2.3 / §3.2).
 *
 * Catch this at the runtime's voice-session-start boundary and surface the
 * tier-warning copy (`TIER_WARNING_COPY[<tier>]`) — DO NOT load weights and
 * watch `MemoryMonitor` evict mid-session.
 */
export class VoiceBundleDoesNotFitError extends Error {
	readonly tierSlot: string;
	readonly deviceTier: string;
	readonly requiredPeakMb: number;
	readonly requiredSteadyStateMb: number;
	readonly usableMb: number;
	readonly hostRamMb: number;

	constructor(args: {
		tierSlot: string;
		deviceTier: string;
		requiredPeakMb: number;
		requiredSteadyStateMb: number;
		usableMb: number;
		hostRamMb: number;
	}) {
		super(
			`[local-inference] The voice bundle for tier "${args.tierSlot}" needs ~${args.requiredSteadyStateMb} MB steady-state (+~${args.requiredPeakMb - args.requiredSteadyStateMb} MB transient TTS peak) but only ~${args.usableMb} MB are usable on this host (${args.hostRamMb} MB total, after the OS/runtime headroom reserve). Refusing to start local voice; the runtime should fall back to cloud TTS+ASR or refuse the user-facing action.`,
		);
		this.name = "VoiceBundleDoesNotFitError";
		this.tierSlot = args.tierSlot;
		this.deviceTier = args.deviceTier;
		this.requiredPeakMb = args.requiredPeakMb;
		this.requiredSteadyStateMb = args.requiredSteadyStateMb;
		this.usableMb = args.usableMb;
		this.hostRamMb = args.hostRamMb;
	}
}

/**
 * Cross-model admission gate for the local-voice session. Sums the whole
 * co-resident bundle (LM + ASR + TTS + embedding + VAD +
 * wake-word + turn-detector + emotion + speaker-encoder + transient TTS
 * peak) and refuses entry when the host can't fit it.
 *
 * Returns the decision on `fits`. Throws `VoiceBundleDoesNotFitError` when
 * `wontfit` (when `strict=true`, the default), or just returns the
 * `wontfit` decision when `strict=false` (the runtime then logs and
 * degrades silently). Pair with `TIER_WARNING_COPY[deviceTier]` for
 * user-facing UX.
 *
 * R9 §1.4 + §2.3 + §3.2 spec.
 */
export function assertVoiceBundleFitsHost(args: {
	tierSlot: string;
	deviceTier: string;
	hostRamMb: number;
	reserveMb?: number;
	strict?: boolean;
}): {
	level: "fits" | "tight" | "wontfit";
	steadyStateMb: number;
	peakMb: number;
	usableMb: number;
	fits: boolean;
} {
	if (!(args.tierSlot in VOICE_ENSEMBLE_BUDGETS)) {
		// Unknown tier slot — be permissive: the runtime hasn't built a
		// canonical slot for this combination yet, and falling through to
		// `assertModelFitsHost` (the per-tier check) is the right default.
		return {
			level: "fits",
			steadyStateMb: 0,
			peakMb: 0,
			usableMb: Math.max(0, args.hostRamMb - (args.reserveMb ?? 1536)),
			fits: true,
		};
	}
	const decision = assessVoiceBundleFits({
		tierSlot: args.tierSlot as VoiceTierSlot,
		deviceTier: args.deviceTier as "MAX" | "GOOD" | "OKAY" | "POOR",
		hostRamMb: args.hostRamMb,
		reserveMb: args.reserveMb,
	});
	if (decision.level === "wontfit" && args.strict !== false) {
		throw new VoiceBundleDoesNotFitError({
			tierSlot: args.tierSlot,
			deviceTier: args.deviceTier,
			requiredPeakMb: Math.round(decision.peakMb),
			requiredSteadyStateMb: Math.round(decision.steadyStateMb),
			usableMb: Math.round(decision.usableMb),
			hostRamMb: args.hostRamMb,
		});
	}
	return {
		level: decision.level,
		steadyStateMb: decision.steadyStateMb,
		peakMb: decision.peakMb,
		usableMb: decision.usableMb,
		fits: decision.fits,
	};
}

function hostRamMbFromProbe(probe: HardwareProbe): number {
	return Math.round(probe.totalRamGb * MB_PER_GB);
}

/**
 * Refusal raised when activation is asked for a model whose own
 * `eliza-1.manifest.json` says its text eval has not passed (`candidate.*` /
 * `weights-staged.*` tiers). Carries the structured payload the route layer
 * surfaces verbatim to the API consumer: `manifestVersion` so the UI can
 * say "this tier isn't ready" with the actual version string, and
 * `failedEvals` so the user sees which checks are still red.
 *
 * Why we gate here, not just at download:
 * - the bundle may already be on disk (hand-staged, manually copied, or
 *   downloaded before a fail-state was recorded), so the download gate
 *   alone leaves a window where a candidate-only bundle can be flipped
 *   into the active model slot and silently emit `[unused]` tokens.
 *
 * See issue #7679 for the original symptom: the runtime activated an
 * `eliza-1-0_8b` `1.0.0-candidate.1` bundle whose every `evals.*.passed`
 * was `false`, then served BERT/WordPiece reserved tokens (`[unused0..99]`
 * / `[PAD]`) as chat output with no actionable error.
 */
export class CandidateModelActivationError extends Error {
	readonly modelId: string;
	readonly manifestVersion: string;
	readonly failedEvals: ReadonlyArray<string>;

	constructor(args: {
		modelId: string;
		manifestVersion: string;
		failedEvals: ReadonlyArray<string>;
	}) {
		const evalSuffix =
			args.failedEvals.length > 0
				? ` Failed evals: ${args.failedEvals.join(", ")}.`
				: "";
		super(
			`Model "${args.modelId}" is candidate-only — its manifest (version ${args.manifestVersion}) reports evals.textEval.passed=false. Refusing to activate.${evalSuffix} Wait for the publisher to flip the manifest off candidate/weights-staged and re-fetch the bundle.`,
		);
		this.name = "CandidateModelActivationError";
		this.modelId = args.modelId;
		this.manifestVersion = args.manifestVersion;
		this.failedEvals = args.failedEvals;
	}
}

/**
 * Activation eval gate. Reads the installed bundle's manifest and refuses
 * activation when `evals.textEval.passed` is not `true`. A bundle with no
 * `eliza-1.manifest.json` on disk (third-party HF GGUFs, external scans,
 * pre-bundle installs) is *not* gated — the gate only applies to bundles
 * that ship a published manifest, which is the source of truth for the
 * publish state.
 *
 * Throws `CandidateModelActivationError` on a failing manifest; returns
 * silently otherwise.
 */
export function assertManifestEvalsPassed(
	installed: InstalledModel,
	manifestLoader: ManifestLoader = defaultManifestLoader,
): void {
	const manifest = manifestLoader(installed.id, installed);
	if (!manifest) return;
	if (manifest.evals.textEval.passed === true) return;
	throw new CandidateModelActivationError({
		modelId: installed.id,
		manifestVersion: manifest.version,
		failedEvals: collectFailedEvalNames(manifest),
	});
}

function collectFailedEvalNames(manifest: Eliza1Manifest): string[] {
	const failed: string[] = [];
	const evals = manifest.evals;
	if (evals.textEval.passed !== true) failed.push("textEval");
	if (evals.voiceRtf.passed !== true) failed.push("voiceRtf");
	if (evals.e2eLoopOk !== true) failed.push("e2eLoopOk");
	if (evals.thirtyTurnOk !== true) failed.push("thirtyTurnOk");
	if (evals.asrWer && evals.asrWer.passed !== true) failed.push("asrWer");
	if (evals.embedMteb && evals.embedMteb.passed !== true) {
		failed.push("embedMteb");
	}
	if (evals.vadLatencyMs && evals.vadLatencyMs.passed !== true) {
		failed.push("vadLatencyMs");
	}
	if (evals.expressive && evals.expressive.passed !== true) {
		failed.push("expressive");
	}
	if (evals.turnDetector && evals.turnDetector.passed !== true) {
		failed.push("turnDetector");
	}
	return failed;
}

function isLoader(value: unknown): value is LocalInferenceLoader {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<LocalInferenceLoader>;
	return (
		typeof candidate.loadModel === "function" &&
		typeof candidate.unloadModel === "function" &&
		typeof candidate.currentModelPath === "function"
	);
}

export class ActiveModelCoordinator {
	private state: ActiveModelState = {
		modelId: null,
		loadedAt: null,
		status: "idle",
	};

	/**
	 * The last model that successfully reached `status: "ready"`, plus the
	 * inputs needed to re-load it. switchTo() tears the active model down
	 * before loading the new one (unload-then-load); if the new load fails we
	 * restore this so a failed switch never leaves the host with zero models
	 * loaded while a working one existed moments earlier. `null` until the
	 * first successful load (or after an unload).
	 */
	private lastReady: {
		installed: InstalledModel;
		overrides?: LocalInferenceLoadOverrides;
		state: ActiveModelState;
	} | null = null;

	private readonly listeners = new Set<(state: ActiveModelState) => void>();

	snapshot(): ActiveModelState {
		return { ...this.state };
	}

	subscribe(listener: (state: ActiveModelState) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	private emit(): void {
		const current = { ...this.state };
		for (const listener of this.listeners) {
			try {
				listener(current);
			} catch {
				this.listeners.delete(listener);
			}
		}
	}

	/**
	 * WS2: one-shot warning latch per (modelId) — when the tier declares
	 * vision but no mmproj GGUF was found on disk, log once so the
	 * operator sees that vision is degraded for this session. The
	 * arbiter's vision-describe capability stays unregistered for this
	 * session; plugin-vision falls back to its non-eliza-1 path.
	 */
	private readonly warnedDegradedVisionFor = new Set<string>();

	private warnIfVisionDegraded(
		installed: InstalledModel,
		resolvedMmprojPath: string | undefined,
	): void {
		const catalog = findCatalogModel(installed.id);
		const tierClaimsVision = Boolean(
			catalog?.sourceModel?.components?.vision?.file,
		);
		if (!tierClaimsVision) return;
		if (resolvedMmprojPath) return;
		if (this.warnedDegradedVisionFor.has(installed.id)) return;
		this.warnedDegradedVisionFor.add(installed.id);
		console.warn(
			`[local-inference] vision capability unavailable for tier "${installed.id}" — the bundle declares vision/mmproj but the projector GGUF is not on disk under "${installed.bundleRoot ?? "<no-bundleRoot>"}". Text and voice will continue to load; plugin-vision will fall back to its Florence-2 path. Download the per-tier mmproj-<tier>.gguf to enable native vision-describe.`,
		);
	}

	/** Return the loader service from the current runtime, if registered. */
	private getLoader(runtime: AgentRuntime | null): LocalInferenceLoader | null {
		if (!runtime) return null;
		const candidate = (
			runtime as {
				getService?: (name: string) => unknown;
			}
		).getService?.("localInferenceLoader");
		return isLoader(candidate) ? candidate : null;
	}

	async switchTo(
		runtime: AgentRuntime | null,
		installed: InstalledModel,
		overrides?: LocalInferenceLoadOverrides,
		opts: { hardware?: HardwareProbe; manifestLoader?: ManifestLoader } = {},
	): Promise<ActiveModelState> {
		// Activation eval gate (#7679). Refuse to flip a candidate-only /
		// weights-staged bundle into the active model slot — the manifest
		// already says its text eval hasn't passed, so the only thing
		// activation buys is `[unused]`/`[PAD]` tokens in chat output and
		// a confused user. Runs BEFORE the loading state is emitted so
		// the UI never shows "loading → error" for a known-bad bundle;
		// it sees the 422 from the route layer directly.
		assertManifestEvalsPassed(installed, opts.manifestLoader);

		this.state = {
			modelId: installed.id,
			loadedAt: null,
			status: "loading",
		};
		this.emit();

		// Prefer a runtime-registered loader (plugin-local-ai or equivalent)
		// when present — it will already have warmed up the right configuration.
		// Otherwise, fall back to the standalone engine, which is the default
		// path for users who haven't separately enabled plugin-local-ai.
		const loader = this.getLoader(runtime);

		// Snapshot the previously-active model BEFORE the unload-then-load tears
		// it down, so a failed switch can restore it instead of leaving zero
		// models loaded under the requested id.
		const previous = this.lastReady;
		let previousDisplaced = false;

		try {
			const ready = await this.performLoad(
				loader,
				installed,
				overrides,
				opts,
				() => {
					previousDisplaced = true;
				},
			);
			this.state = ready;
			this.lastReady = { installed, overrides, state: ready };
		} catch (err) {
			const failure = err instanceof Error ? err.message : String(err);
			if (previous) {
				previousDisplaced =
					(loader?.currentModelPath() ??
						localInferenceEngine.currentModelPath()) !==
					previous.installed.path;
			}
			// Attempt to restore the previously-active model. The unload-then-load
			// already tore it down, so without this the host has no model loaded.
			if (previous && previousDisplaced) {
				try {
					const restored = await this.performLoad(
						loader,
						previous.installed,
						previous.overrides,
						opts,
						() => {},
					);
					this.state = restored;
					this.lastReady = {
						installed: previous.installed,
						overrides: previous.overrides,
						state: restored,
					};
					console.warn(
						`[local-inference] Failed to switch to "${installed.id}" (${failure}); restored previously-active model "${previous.installed.id}".`,
					);
					this.emit();
					return this.snapshot();
				} catch (restoreErr) {
					const restoreFailure =
						restoreErr instanceof Error
							? restoreErr.message
							: String(restoreErr);
					console.error(
						`[local-inference] Failed to switch to "${installed.id}" (${failure}) AND failed to restore "${previous.installed.id}" (${restoreFailure}). No model is loaded.`,
					);
				}
			} else if (previous) {
				// Admission/load-arg errors happen before unload, so the previous
				// model is still live. Restore the coordinator state without touching
				// the loader and surface the failed request only as a warning.
				this.state = previous.state;
				this.lastReady = previous;
				console.warn(
					`[local-inference] Refused to switch to "${installed.id}" before unloading the active model "${previous.installed.id}" (${failure}).`,
				);
				this.emit();
				return this.snapshot();
			}
			// No prior model to restore (or restore also failed): report honestly
			// that nothing is loaded rather than attributing a phantom id.
			this.lastReady = null;
			this.state = {
				modelId: null,
				loadedAt: null,
				status: "error",
				error: failure,
			};
		}

		this.emit();
		if (installed.source === "eliza-download") {
			try {
				await touchElizaModel(installed.id);
			} catch (err) {
				console.warn(
					`[local-inference] Model "${installed.id}" loaded, but failed to update last-used metadata: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}
		return this.snapshot();
	}

	/**
	 * Run the unload-then-load against the loader (or standalone engine) and
	 * build the `status: "ready"` state. Throws on any load failure; never
	 * mutates `this.state`/`this.lastReady` so callers control rollback.
	 */
	private async performLoad(
		loader: LocalInferenceLoader | null,
		installed: InstalledModel,
		overrides: LocalInferenceLoadOverrides | undefined,
		opts: { hardware?: HardwareProbe; manifestLoader?: ManifestLoader },
		markPreviousDisplaced: () => void,
	): Promise<ActiveModelState> {
		// RAM-budget admission control (W10 / J1): refuse a model that won't
		// fit this host *before* touching the loader, so we never half-load
		// and OOM. `assertModelFitsHost` throws `ModelDoesNotFitError` with
		// the specific numbers + the largest fitting variant of the tier.
		const probe = opts.hardware ?? (await probeHardware());
		const admission = assertModelFitsHost(installed, hostRamMbFromProbe(probe));
		if (admission.level === "tight") {
			console.warn(
				`[local-inference] Loading "${installed.id}" with tight RAM headroom (~${admission.minMb} MB floor, ${admission.recommendedMb} MB recommended; ${hostRamMbFromProbe(probe)} MB host). Expect swapping under sustained load.`,
			);
		}
		const resolved = await resolveLocalInferenceLoadArgs(installed, overrides);
		// WS2: warn one-shot when the tier declares vision but the
		// per-tier mmproj GGUF isn't on disk yet. The text load still
		// proceeds; vision capability is degraded for this session
		// (plugin-vision falls back to its Florence-2 path).
		this.warnIfVisionDegraded(installed, resolved.mmprojPath);
		if (loader) {
			markPreviousDisplaced();
			await loader.unloadModel();
			await loader.loadModel(resolved);
		} else {
			await localInferenceEngine.load(installed.path, resolved);
		}
		const runtimeLoad = loader
			? null
			: localInferenceEngine.currentRuntimeLoadConfig();
		// Surface the effective load config so consumers (the benchmark
		// harness, the Settings UI, the active-model SSE) can verify the
		// requested overrides actually took hold instead of silently
		// falling back to a smaller context or fp16 KV.
		return {
			modelId: installed.id,
			loadedAt: new Date().toISOString(),
			status: "ready",
			loadedContextSize:
				runtimeLoad?.contextSize ?? resolved.contextSize ?? null,
			loadedCacheTypeK: runtimeLoad
				? runtimeLoad.cacheTypeK
				: (resolved.cacheTypeK ?? null),
			loadedCacheTypeV: runtimeLoad
				? runtimeLoad.cacheTypeV
				: (resolved.cacheTypeV ?? null),
			loadedGpuLayers:
				runtimeLoad !== null
					? runtimeLoad.gpuLayers
					: typeof resolved.gpuLayers === "number"
						? resolved.gpuLayers
						: null,
		};
	}

	async unload(runtime: AgentRuntime | null): Promise<ActiveModelState> {
		const loader = this.getLoader(runtime);
		try {
			if (loader) {
				await loader.unloadModel();
			} else {
				await localInferenceEngine.unload();
			}
		} catch (err) {
			this.state = {
				modelId: null,
				loadedAt: null,
				status: "error",
				error: err instanceof Error ? err.message : String(err),
				loadedContextSize: null,
				loadedCacheTypeK: null,
				loadedCacheTypeV: null,
				loadedGpuLayers: null,
			};
			this.emit();
			return this.snapshot();
		}
		// The model was deliberately unloaded — drop the restore snapshot so a
		// later failed switch doesn't silently re-load a model the operator
		// asked to unload.
		this.lastReady = null;
		this.state = {
			modelId: null,
			loadedAt: null,
			status: "idle",
			loadedContextSize: null,
			loadedCacheTypeK: null,
			loadedCacheTypeV: null,
			loadedGpuLayers: null,
		};
		this.emit();
		return this.snapshot();
	}
}
