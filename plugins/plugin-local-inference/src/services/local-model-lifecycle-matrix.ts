/**
 * Builds the per-tier, per-component (text / vision / MTP / embedding) lifecycle
 * matrix that reports each Eliza-1 model's install, download, and assignment
 * state against the current hardware probe. Cross-references the catalog,
 * installed registry, supported backends, and recommendation logic to tell the
 * UI which components are ready, downloadable, or unfit on this device.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { EMBEDDING_PRESETS } from "../runtime/embedding-presets";
import {
	buildHuggingFaceResolveUrlForPath,
	ELIZA_1_MTP_TIER_IDS,
	ELIZA_1_ON_DEVICE_TIER_IDS,
	ELIZA_1_VISION_TIER_IDS,
	eliza1TierPublishStatus,
	MODEL_CATALOG,
} from "./catalog";
import type { Eliza1Backend } from "./manifest";
import { SUPPORTED_BACKENDS_BY_TIER } from "./manifest";
import {
	deviceCapsFromProbe,
	selectBestQuantizationVariant,
} from "./recommendation";
import {
	AGENT_MODEL_SLOTS,
	type AgentModelSlot,
	type CatalogModel,
	type HardwareProbe,
	type InstalledModel,
	type ModelAssignments,
} from "./types";

export type LocalModelLifecycleComponent =
	| "text"
	| "voice"
	| "asr"
	| "vad"
	| "embedding"
	| "vision"
	| "litert"
	| "mtp";

export type LifecycleCheckStatus =
	| "pass"
	| "fail"
	| "warn"
	| "unknown"
	| "skipped";

export interface LifecycleCheck {
	status: LifecycleCheckStatus;
	detail: string;
	checkedAt?: string;
	httpStatus?: number;
	url?: string;
	path?: string;
}

export interface LifecycleRemoteCheck {
	status: "pass" | "fail" | "warn";
	detail: string;
	checkedAt: string;
	httpStatus?: number;
}

export interface LifecycleLocalFileCheck {
	status: "present" | "missing" | "error";
	detail: string;
	path: string;
	sizeBytes?: number;
}

/**
 * Direct load-and-run evidence for a model's text component, produced by the
 * `--load-run` lane (`lifecycle-loadrun.ts`): the real FFI engine loaded the
 * installed artifact and decoded tokens, so throughput and the serving
 * backend are measured, not inferred from `bundleVerifiedAt`.
 */
export interface LifecycleLoadRunCheck {
	status: "pass" | "fail" | "skipped";
	detail: string;
	checkedAt: string;
	backend?: string;
	loadMs?: number;
	generateMs?: number;
	promptTokens?: number;
	decodeTokens?: number;
	tokensPerSecond?: number;
}

export interface LifecycleBundleRemoteCheck {
	status: "pass" | "fail" | "warn";
	detail: string;
	checkedAt: string;
	manifestUrl: string;
	fileCount: number;
	failingFiles: Array<{
		path: string;
		status: "fail" | "warn";
		detail: string;
		httpStatus?: number;
	}>;
}

/**
 * A catalog-grounded explanation for an expected component that has no
 * advertised artifact. Distinguishes the two honest non-fail cases from a
 * genuinely missing implementation (#10727 reconciliation):
 *
 * - `publish-pending`: the runtime seam and the exact artifact path are
 *   implemented and documented in the catalog, but the artifact is not hosted
 *   yet (e.g. Gemma MTP drafters gated by `ELIZA_1_HOSTED_MTP_TIER_IDS`).
 *   The row stays red — but on `published`/`downloadable`, attributed to the
 *   publish gap, and it counts in `pendingPublishRows`.
 * - `served-by-alternate-runtime`: the model slot is deliberately served by a
 *   different runtime artifact (e.g. the 2b tier ships no bundle embedding;
 *   `TEXT_EMBEDDING` is served by the gte-small preset). The row is `skipped`
 *   with the recorded product decision instead of a permanent unfixable fail.
 */
export interface LifecycleKnownGap {
	kind: "publish-pending" | "served-by-alternate-runtime";
	reason: string;
}

export interface LocalModelLifecycleArtifact {
	key: string;
	modelId: string;
	displayName: string;
	component: LocalModelLifecycleComponent;
	expected: boolean;
	catalogAdvertised: boolean;
	sourceRepo: string | null;
	sourceFile: string | null;
	bundleFile: string | null;
	downloadUrl: string | null;
	bootPath: string;
	knownGap?: LifecycleKnownGap;
}

export interface LocalModelLifecycleRow extends LocalModelLifecycleArtifact {
	publishStatus: "published" | "pending";
	quantization: {
		defaultVariantId: string | null;
		publishedVariantIds: string[];
		plannedVariantIds: string[];
		mobilePreferredVariantIds: string[];
	} | null;
	runtime: {
		preferredBackend: string | null;
		requiredKernels: string[];
		supportedBackends: Eliza1Backend[];
		deviceBackends: Eliza1Backend[];
		expectedPrimaryBackend: Eliza1Backend;
		cpuFallbackAllowed: boolean;
	};
	local: {
		installed: boolean;
		assignedSlots: AgentModelSlot[];
		modelPath: string | null;
		bundleRoot: string | null;
		manifestPath: string | null;
		bundleVerifiedAt: string | null;
		componentPath: string | null;
		componentFile: LifecycleLocalFileCheck | null;
	};
	bundle: {
		manifestUrl: string;
		fileCount: number;
		failingFiles: LifecycleBundleRemoteCheck["failingFiles"];
	} | null;
	checks: {
		implemented: LifecycleCheck;
		integrated: LifecycleCheck;
		deployable: LifecycleCheck;
		published: LifecycleCheck;
		downloadable: LifecycleCheck;
		bundleClosure: LifecycleCheck;
		installed: LifecycleCheck;
		loadsAndRunsOnDevice: LifecycleCheck;
		backendPolicy: LifecycleCheck;
	};
	blockers: string[];
}

export interface LocalModelLifecycleMatrix {
	schemaVersion: 1;
	issue: 10727;
	observedAt: string;
	host: {
		platform: NodeJS.Platform;
		arch: NodeJS.Architecture;
		totalRamGb: number;
		freeRamGb: number;
		gpuBackend: Eliza1Backend | null;
		deviceBackends: Eliza1Backend[];
		expectedPrimaryBackend: Eliza1Backend;
		cpuFallbackAllowed: boolean;
		openvinoAsrDevice: string | null;
	};
	rows: LocalModelLifecycleRow[];
	summary: {
		totalRows: number;
		failingRows: number;
		unknownRows: number;
		installedRows: number;
		verifiedRows: number;
		pendingPublishRows: number;
		blockers: string[];
	};
}

export interface BuildLocalModelLifecycleMatrixOptions {
	catalog?: ReadonlyArray<CatalogModel>;
	installed: ReadonlyArray<InstalledModel>;
	assignments: ModelAssignments;
	hardware: HardwareProbe;
	observedAt?: string;
	remoteChecks?: Readonly<Record<string, LifecycleRemoteCheck>>;
	bundleChecks?: Readonly<Record<string, LifecycleBundleRemoteCheck>>;
	localFileChecks?: Readonly<Record<string, LifecycleLocalFileCheck>>;
	/** Keyed by model id; applies to the model's `text` row. */
	loadRunChecks?: Readonly<Record<string, LifecycleLoadRunCheck>>;
}

const COMPONENTS_WITH_LOCAL_RUNTIME: ReadonlySet<LocalModelLifecycleComponent> =
	new Set([
		"text",
		"voice",
		"asr",
		"vad",
		"embedding",
		"vision",
		"litert",
		"mtp",
	]);

const ACCELERATED_BACKEND_ORDER: readonly Eliza1Backend[] = [
	"metal",
	"cuda",
	"vulkan",
	"rocm",
];

const COMPONENT_BOOT_PATHS: Record<LocalModelLifecycleComponent, string> = {
	text: "TEXT_SMALL/TEXT_LARGE handlers via ensureLocalInferenceHandler",
	voice: "TEXT_TO_SPEECH handler via the local voice pipeline",
	asr: "TRANSCRIPTION handler via the local ASR pipeline",
	vad: "voice activity detection inside the local voice pipeline",
	embedding: "TEXT_EMBEDDING handler via ensureLocalInferenceHandler",
	vision: "IMAGE_DESCRIPTION handler and fused vision context path",
	litert: "mobile LiteRT-LM loader for on-device text/vision/audio",
	mtp: "fused llama.cpp MTP drafter loader",
};

export function lifecycleArtifactKey(
	modelId: string,
	component: LocalModelLifecycleComponent,
): string {
	return `${modelId}:${component}`;
}

function hasTier(tiers: ReadonlyArray<string>, modelId: string): boolean {
	return tiers.some((tierId) => tierId === modelId);
}

function expectedComponentsForModel(
	model: CatalogModel,
): LocalModelLifecycleComponent[] {
	const components = new Set<LocalModelLifecycleComponent>([
		"text",
		"voice",
		"asr",
		"vad",
		"embedding",
	]);
	if (hasTier(ELIZA_1_VISION_TIER_IDS, model.id)) components.add("vision");
	if (hasTier(ELIZA_1_ON_DEVICE_TIER_IDS, model.id)) components.add("litert");
	if (hasTier(ELIZA_1_MTP_TIER_IDS, model.id)) components.add("mtp");
	for (const component of Object.keys(model.sourceModel?.components ?? {})) {
		components.add(component as LocalModelLifecycleComponent);
	}
	return Array.from(components);
}

function sourceComponentFor(
	model: CatalogModel,
	component: LocalModelLifecycleComponent,
): { repo: string; file?: string } | undefined {
	if (component === "text") {
		return (
			model.sourceModel?.components.text ?? {
				repo: model.hfRepo,
				file: model.ggufFile,
			}
		);
	}
	return model.sourceModel?.components[component];
}

/**
 * Catalog-grounded known-gap classification for an expected component that
 * has no advertised source file. Keeps a deliberate catalog gate and a
 * genuinely-missing implementation distinguishable in the matrix output —
 * the exact "expected but not advertised" reconciliation from #10727.
 */
function knownGapFor(
	model: CatalogModel,
	component: LocalModelLifecycleComponent,
	hasSourceFile: boolean,
): LifecycleKnownGap | undefined {
	if (hasSourceFile) return undefined;
	if (component === "mtp" && hasTier(ELIZA_1_MTP_TIER_IDS, model.id)) {
		const slug = model.id.startsWith("eliza-1-")
			? model.id.slice("eliza-1-".length)
			: model.id;
		return {
			kind: "publish-pending",
			reason:
				`Gemma MTP drafter mtp/drafter-${slug}.gguf is not hosted on ` +
				`${model.hfRepo} (candidates/gemma-2b-base-v1/mtp/MISSING.txt); the ` +
				"catalog gates advertisement on ELIZA_1_HOSTED_MTP_TIER_IDS " +
				"(currently empty) so the downloader never fetches a missing artifact",
		};
	}
	if (component === "embedding") {
		const preset = EMBEDDING_PRESETS.standard;
		return {
			kind: "served-by-alternate-runtime",
			reason:
				"tier ships no bundle embedding artifact by design; TEXT_EMBEDDING " +
				`is served by the ${preset.model} preset (${preset.modelRepo}, ` +
				`${preset.dimensions}-dim — matches plugin-sql's dim384 column; see ` +
				"runtime/embedding-presets.ts)",
		};
	}
	return undefined;
}

function bundleRelativeFileFor(model: CatalogModel, file: string): string {
	const cleanFile = file.replace(/^\/+/, "");
	const cleanPrefix = model.hfPathPrefix?.replace(/^\/+|\/+$/g, "");
	if (cleanPrefix && cleanFile.startsWith(`${cleanPrefix}/`)) {
		return cleanFile.slice(cleanPrefix.length + 1);
	}
	return cleanFile;
}

export function listLocalModelLifecycleArtifacts(
	catalog: ReadonlyArray<CatalogModel> = MODEL_CATALOG,
): LocalModelLifecycleArtifact[] {
	const rows: LocalModelLifecycleArtifact[] = [];
	for (const model of catalog.filter((entry) => !entry.hiddenFromCatalog)) {
		for (const component of expectedComponentsForModel(model)) {
			const source = sourceComponentFor(model, component);
			const sourceFile = source?.file ?? null;
			const sourceRepo = source?.repo ?? null;
			const bundleFile = sourceFile
				? bundleRelativeFileFor(model, sourceFile)
				: null;
			const knownGap = knownGapFor(model, component, Boolean(sourceFile));
			rows.push({
				key: lifecycleArtifactKey(model.id, component),
				modelId: model.id,
				displayName: model.displayName,
				component,
				expected: true,
				catalogAdvertised: Boolean(sourceFile),
				sourceRepo,
				sourceFile,
				bundleFile,
				downloadUrl: sourceFile
					? buildHuggingFaceResolveUrlForPath(model, sourceFile)
					: null,
				bootPath: COMPONENT_BOOT_PATHS[component],
				...(knownGap ? { knownGap } : {}),
			});
		}
	}
	return rows;
}

function status(
	status: LifecycleCheckStatus,
	detail: string,
	extra: Partial<LifecycleCheck> = {},
): LifecycleCheck {
	return { status, detail, ...extra };
}

function assignedSlotsForModel(
	assignments: ModelAssignments,
	modelId: string,
): AgentModelSlot[] {
	return AGENT_MODEL_SLOTS.filter((slot) => assignments[slot] === modelId);
}

function installedById(
	installed: ReadonlyArray<InstalledModel>,
): Map<string, InstalledModel> {
	return new Map(installed.map((model) => [model.id, model]));
}

function expectedPrimaryBackend(
	deviceBackends: ReadonlyArray<Eliza1Backend>,
	supportedBackends: ReadonlyArray<Eliza1Backend> = [
		...ACCELERATED_BACKEND_ORDER,
		"cpu",
	],
): Eliza1Backend {
	return (
		ACCELERATED_BACKEND_ORDER.find(
			(backend) =>
				deviceBackends.includes(backend) && supportedBackends.includes(backend),
		) ?? "cpu"
	);
}

function supportedBackendsForModel(model: CatalogModel): Eliza1Backend[] {
	const tier = model.id.startsWith("eliza-1-")
		? model.id.slice("eliza-1-".length)
		: null;
	if (tier && tier in SUPPORTED_BACKENDS_BY_TIER) {
		return [
			...SUPPORTED_BACKENDS_BY_TIER[
				tier as keyof typeof SUPPORTED_BACKENDS_BY_TIER
			],
		];
	}
	return ["metal", "vulkan", "cuda", "rocm", "cpu"];
}

function quantizationForModel(
	model: CatalogModel,
): LocalModelLifecycleRow["quantization"] {
	if (!model.quantization) return null;
	return {
		defaultVariantId: selectBestQuantizationVariant(model)?.id ?? null,
		publishedVariantIds: model.quantization.variants
			.filter((variant) => variant.status === "published")
			.map((variant) => variant.id),
		plannedVariantIds: model.quantization.variants
			.filter((variant) => variant.status === "planned")
			.map((variant) => variant.id),
		mobilePreferredVariantIds: model.quantization.variants
			.filter((variant) => variant.mobilePreferred)
			.map((variant) => variant.id),
	};
}

function componentPathFor(
	model: InstalledModel,
	artifact: LocalModelLifecycleArtifact,
): string | null {
	if (!artifact.bundleFile) return null;
	if (artifact.component === "text") return model.path;
	const root = model.bundleRoot ?? path.dirname(model.path);
	return path.join(root, artifact.bundleFile);
}

function implementedCheck(
	artifact: LocalModelLifecycleArtifact,
): LifecycleCheck {
	if (!artifact.expected) return status("skipped", "artifact is not expected");
	if (!artifact.catalogAdvertised) {
		if (artifact.knownGap?.kind === "served-by-alternate-runtime") {
			return status("skipped", artifact.knownGap.reason);
		}
		if (artifact.knownGap?.kind === "publish-pending") {
			return status(
				"pass",
				`${artifact.component} runtime seam and catalog artifact path are implemented; ${artifact.knownGap.reason}`,
			);
		}
		return status(
			"fail",
			`${artifact.component} is expected but has no catalog source file`,
		);
	}
	return status(
		"pass",
		`${artifact.component} has a catalog source file and download path`,
	);
}

function integratedCheck(
	artifact: LocalModelLifecycleArtifact,
	implemented: LifecycleCheck,
): LifecycleCheck {
	if (!COMPONENTS_WITH_LOCAL_RUNTIME.has(artifact.component)) {
		return status("unknown", "no runtime integration policy is registered");
	}
	if (implemented.status === "fail") {
		return status(
			"warn",
			`${artifact.bootPath} exists, but the catalog artifact is missing`,
		);
	}
	return status("pass", artifact.bootPath);
}

function deployableCheck(
	artifact: LocalModelLifecycleArtifact,
	implemented: LifecycleCheck,
): LifecycleCheck {
	if (implemented.status === "fail") return implemented;
	if (artifact.knownGap?.kind === "served-by-alternate-runtime") {
		return status("skipped", artifact.knownGap.reason);
	}
	if (!artifact.downloadUrl) {
		if (artifact.knownGap?.kind === "publish-pending") {
			return status(
				"fail",
				`artifact awaits publish; no download URL until it is hosted (${artifact.knownGap.reason})`,
			);
		}
		return status("fail", "artifact has no resolved download URL");
	}
	return status("pass", "artifact has a resolved catalog download URL", {
		url: artifact.downloadUrl,
	});
}

function publishedCheck(
	artifact: LocalModelLifecycleArtifact,
	publishStatus: "published" | "pending",
): LifecycleCheck {
	if (!artifact.catalogAdvertised) {
		if (artifact.knownGap?.kind === "served-by-alternate-runtime") {
			return status("skipped", artifact.knownGap.reason);
		}
		if (artifact.knownGap?.kind === "publish-pending") {
			return status("fail", artifact.knownGap.reason);
		}
		return status(
			"fail",
			"catalog does not advertise a hosted artifact for this component",
		);
	}
	if (publishStatus === "pending") {
		return status("fail", "tier publish status is pending");
	}
	return status("pass", "tier publish status is published");
}

function downloadableCheck(
	artifact: LocalModelLifecycleArtifact,
	remote: LifecycleRemoteCheck | undefined,
	published: LifecycleCheck,
): LifecycleCheck {
	if (artifact.knownGap?.kind === "served-by-alternate-runtime") {
		return status("skipped", artifact.knownGap.reason);
	}
	if (!artifact.downloadUrl) {
		if (artifact.knownGap?.kind === "publish-pending") {
			return status("fail", artifact.knownGap.reason);
		}
		return status("fail", "no download URL exists for this artifact");
	}
	if (published.status === "fail") {
		return status("fail", published.detail, { url: artifact.downloadUrl });
	}
	if (!remote) {
		return status("unknown", "remote URL was not checked", {
			url: artifact.downloadUrl,
		});
	}
	return status(remote.status, remote.detail, {
		checkedAt: remote.checkedAt,
		httpStatus: remote.httpStatus,
		url: artifact.downloadUrl,
	});
}

function bundleClosureCheck(
	model: CatalogModel,
	remote: LifecycleBundleRemoteCheck | undefined,
): LifecycleCheck {
	if (!model.bundleManifestFile) {
		return status("skipped", "model does not use an Eliza-1 bundle manifest");
	}
	if (!remote) {
		return status("unknown", "bundle manifest closure was not checked");
	}
	return status(remote.status, remote.detail, {
		checkedAt: remote.checkedAt,
		url: remote.manifestUrl,
	});
}

function installedCheck(
	installed: InstalledModel | undefined,
	localFile: LifecycleLocalFileCheck | null,
): LifecycleCheck {
	if (!installed) {
		return status("unknown", "bundle is not installed in this state dir");
	}
	if (localFile?.status === "missing") {
		return status("fail", localFile.detail, { path: localFile.path });
	}
	if (localFile?.status === "error") {
		return status("warn", localFile.detail, { path: localFile.path });
	}
	return status("pass", "bundle is installed locally", {
		path: installed.path,
	});
}

function loadRunCheck(
	installed: InstalledModel | undefined,
	loadRun: LifecycleLoadRunCheck | undefined,
): LifecycleCheck {
	if (loadRun) {
		const throughput =
			loadRun.tokensPerSecond !== undefined
				? ` (${loadRun.tokensPerSecond} tok/s decode on ${loadRun.backend ?? "unknown backend"})`
				: loadRun.backend
					? ` (backend: ${loadRun.backend})`
					: "";
		return status(loadRun.status, `${loadRun.detail}${throughput}`, {
			checkedAt: loadRun.checkedAt,
		});
	}
	if (!installed) {
		return status(
			"skipped",
			"no installed bundle on this host, so load/run evidence is absent",
		);
	}
	if (!installed.bundleVerifiedAt) {
		return status(
			"fail",
			"bundle is installed but missing bundleVerifiedAt on-device verification",
		);
	}
	return status(
		"pass",
		`bundle passed on-device verification at ${installed.bundleVerifiedAt}`,
	);
}

function backendPolicyCheck(
	deviceBackends: ReadonlyArray<Eliza1Backend>,
	supportedBackends: ReadonlyArray<Eliza1Backend>,
	expectedBackend: Eliza1Backend,
): LifecycleCheck {
	if (expectedBackend === "cpu") {
		const detectedAccelerators = ACCELERATED_BACKEND_ORDER.filter((backend) =>
			deviceBackends.includes(backend),
		);
		if (detectedAccelerators.length === 0) {
			return status(
				"skipped",
				"no accelerated backend was detected; CPU fallback is allowed",
			);
		}
		return status(
			"skipped",
			`detected accelerators (${detectedAccelerators.join(", ")}) are not supported by this model tier (supported: ${supportedBackends.join(", ")}); CPU fallback is allowed`,
		);
	}
	return status(
		"pass",
		`accelerated backend ${expectedBackend} is available and supported; CPU must not be the default (device backends: ${deviceBackends.join(", ")}, supported: ${supportedBackends.join(", ")})`,
	);
}

function rowBlockers(row: LocalModelLifecycleRow): string[] {
	return Object.entries(row.checks)
		.filter(([, check]) => check.status === "fail")
		.map(([name, check]) => `${name}: ${check.detail}`);
}

function buildSummary(
	rows: LocalModelLifecycleRow[],
): LocalModelLifecycleMatrix["summary"] {
	const blockers = Array.from(
		new Set(rows.flatMap((row) => row.blockers.map((b) => `${row.key}: ${b}`))),
	);
	return {
		totalRows: rows.length,
		failingRows: rows.filter((row) => row.blockers.length > 0).length,
		unknownRows: rows.filter((row) =>
			Object.values(row.checks).some((check) => check.status === "unknown"),
		).length,
		installedRows: rows.filter((row) => row.local.installed).length,
		verifiedRows: rows.filter(
			(row) => row.checks.loadsAndRunsOnDevice.status === "pass",
		).length,
		pendingPublishRows: rows.filter((row) => row.publishStatus === "pending")
			.length,
		blockers,
	};
}

export function buildLocalModelLifecycleMatrix(
	options: BuildLocalModelLifecycleMatrixOptions,
): LocalModelLifecycleMatrix {
	const catalog = options.catalog ?? MODEL_CATALOG;
	const observedAt = options.observedAt ?? new Date().toISOString();
	const byInstalledId = installedById(options.installed);
	const caps = deviceCapsFromProbe(options.hardware);
	const deviceBackends = [...caps.availableBackends];
	const primaryBackend = expectedPrimaryBackend(deviceBackends);
	const artifacts = listLocalModelLifecycleArtifacts(catalog);
	const rows: LocalModelLifecycleRow[] = artifacts.map((artifact) => {
		const model = catalog.find((entry) => entry.id === artifact.modelId);
		if (!model) {
			throw new Error(
				`catalog model disappeared while building ${artifact.key}`,
			);
		}
		const supportedBackends = supportedBackendsForModel(model);
		const rowPrimaryBackend = expectedPrimaryBackend(
			deviceBackends,
			supportedBackends,
		);
		const installed = byInstalledId.get(model.id);
		const componentPath = installed
			? componentPathFor(installed, artifact)
			: null;
		const fileCheck = componentPath
			? (options.localFileChecks?.[artifact.key] ?? null)
			: null;
		// A publish-pending known gap is a per-component pending publish, even
		// when the tier itself is published (e.g. 2b/4b MTP drafters) — count
		// it in `pendingPublishRows` like the pending 9b/27b tiers.
		const publishStatus =
			artifact.knownGap?.kind === "publish-pending"
				? "pending"
				: (model.publishStatus ?? eliza1TierPublishStatus(model.id));
		const implemented = implementedCheck(artifact);
		const integrated = integratedCheck(artifact, implemented);
		const deployable = deployableCheck(artifact, implemented);
		const published = publishedCheck(artifact, publishStatus);
		const downloadable = downloadableCheck(
			artifact,
			options.remoteChecks?.[artifact.key],
			published,
		);
		const bundleCheck = options.bundleChecks?.[model.id];
		const bundleClosure = bundleClosureCheck(model, bundleCheck);
		const servedByAlternate =
			artifact.knownGap?.kind === "served-by-alternate-runtime";
		const installedStatus = servedByAlternate
			? status("skipped", artifact.knownGap?.reason ?? "")
			: installedCheck(installed, fileCheck);
		const loadRun = servedByAlternate
			? status("skipped", artifact.knownGap?.reason ?? "")
			: loadRunCheck(
					installed,
					artifact.component === "text"
						? options.loadRunChecks?.[model.id]
						: undefined,
				);
		const backend = backendPolicyCheck(
			deviceBackends,
			supportedBackends,
			rowPrimaryBackend,
		);
		const row: LocalModelLifecycleRow = {
			...artifact,
			publishStatus,
			quantization:
				artifact.component === "text" ? quantizationForModel(model) : null,
			runtime: {
				preferredBackend: model.runtime?.preferredBackend ?? null,
				requiredKernels: model.runtime?.optimizations?.requiresKernel ?? [],
				supportedBackends,
				deviceBackends,
				expectedPrimaryBackend: rowPrimaryBackend,
				cpuFallbackAllowed: rowPrimaryBackend === "cpu",
			},
			local: {
				installed: Boolean(installed),
				assignedSlots: assignedSlotsForModel(options.assignments, model.id),
				modelPath: installed?.path ?? null,
				bundleRoot: installed?.bundleRoot ?? null,
				manifestPath: installed?.manifestPath ?? null,
				bundleVerifiedAt: installed?.bundleVerifiedAt ?? null,
				componentPath,
				componentFile: fileCheck,
			},
			bundle: bundleCheck
				? {
						manifestUrl: bundleCheck.manifestUrl,
						fileCount: bundleCheck.fileCount,
						failingFiles: bundleCheck.failingFiles,
					}
				: null,
			checks: {
				implemented,
				integrated,
				deployable,
				published,
				downloadable,
				bundleClosure,
				installed: installedStatus,
				loadsAndRunsOnDevice: loadRun,
				backendPolicy: backend,
			},
			blockers: [],
		};
		row.blockers = rowBlockers(row);
		return row;
	});
	return {
		schemaVersion: 1,
		issue: 10727,
		observedAt,
		host: {
			platform: options.hardware.platform,
			arch: options.hardware.arch,
			totalRamGb: options.hardware.totalRamGb,
			freeRamGb: options.hardware.freeRamGb,
			gpuBackend: options.hardware.gpu?.backend ?? null,
			deviceBackends,
			expectedPrimaryBackend: primaryBackend,
			cpuFallbackAllowed: primaryBackend === "cpu",
			openvinoAsrDevice:
				options.hardware.openvino?.recommendedAsrDevice ?? null,
		},
		rows,
		summary: buildSummary(rows),
	};
}

export async function collectLocalLifecycleFileChecks(
	artifacts: ReadonlyArray<LocalModelLifecycleArtifact>,
	installed: ReadonlyArray<InstalledModel>,
): Promise<Record<string, LifecycleLocalFileCheck>> {
	const byInstalledId = installedById(installed);
	const checks: Record<string, LifecycleLocalFileCheck> = {};
	for (const artifact of artifacts) {
		const model = byInstalledId.get(artifact.modelId);
		if (!model) continue;
		const componentPath = componentPathFor(model, artifact);
		if (!componentPath) continue;
		try {
			const stat = await fs.stat(componentPath);
			checks[artifact.key] = {
				status: stat.isFile() ? "present" : "missing",
				detail: stat.isFile()
					? `component file present (${stat.size} bytes)`
					: "component path exists but is not a file",
				path: componentPath,
				sizeBytes: stat.isFile() ? stat.size : undefined,
			};
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			checks[artifact.key] = {
				status: code === "ENOENT" ? "missing" : "error",
				detail:
					code === "ENOENT"
						? "component file is missing from the installed bundle"
						: `could not stat component file: ${error instanceof Error ? error.message : String(error)}`,
				path: componentPath,
			};
		}
	}
	return checks;
}

function escapeMarkdownCell(value: string): string {
	return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function compactCheck(check: LifecycleCheck): string {
	return `${check.status}: ${check.detail}`;
}

export function formatLocalModelLifecycleMatrixMarkdown(
	matrix: LocalModelLifecycleMatrix,
): string {
	const lines: string[] = [
		"# Local Model Lifecycle Matrix (#10727)",
		"",
		`Observed: ${matrix.observedAt}`,
		`Host: ${matrix.host.platform}-${matrix.host.arch}, RAM ${matrix.host.totalRamGb} GB, GPU ${matrix.host.gpuBackend ?? "none"}, expected backend ${matrix.host.expectedPrimaryBackend}`,
		"",
		"## Summary",
		"",
		`- Rows: ${matrix.summary.totalRows}`,
		`- Failing rows: ${matrix.summary.failingRows}`,
		`- Rows with unknown evidence: ${matrix.summary.unknownRows}`,
		`- Installed rows: ${matrix.summary.installedRows}`,
		`- On-device verified rows: ${matrix.summary.verifiedRows}`,
		`- Pending publish rows: ${matrix.summary.pendingPublishRows}`,
		"",
		"## Matrix",
		"",
		"| Model | Component | Publish | Download | Bundle | Installed | Load/run | Backend | Blockers |",
		"| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
	];

	for (const row of matrix.rows) {
		lines.push(
			[
				row.modelId,
				row.knownGap
					? `${row.component} (${row.knownGap.kind})`
					: row.component,
				compactCheck(row.checks.published),
				compactCheck(row.checks.downloadable),
				compactCheck(row.checks.bundleClosure),
				compactCheck(row.checks.installed),
				compactCheck(row.checks.loadsAndRunsOnDevice),
				`${row.runtime.expectedPrimaryBackend}${row.runtime.cpuFallbackAllowed ? " (CPU allowed)" : ""}`,
				row.blockers.length > 0 ? row.blockers.join("; ") : "none",
			]
				.map(escapeMarkdownCell)
				.join(" | ")
				.replace(/^/, "| ")
				.replace(/$/, " |"),
		);
	}

	if (matrix.summary.blockers.length > 0) {
		lines.push("", "## Blockers", "");
		for (const blocker of matrix.summary.blockers) {
			lines.push(`- ${blocker}`);
		}
	}

	return `${lines.join("\n")}\n`;
}
