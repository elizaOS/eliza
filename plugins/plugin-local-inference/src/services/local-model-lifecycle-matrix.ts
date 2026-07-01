import fs from "node:fs/promises";
import path from "node:path";
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
	checks: {
		implemented: LifecycleCheck;
		integrated: LifecycleCheck;
		deployable: LifecycleCheck;
		published: LifecycleCheck;
		downloadable: LifecycleCheck;
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
	localFileChecks?: Readonly<Record<string, LifecycleLocalFileCheck>>;
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
	backends: ReadonlyArray<Eliza1Backend>,
): Eliza1Backend {
	return (
		ACCELERATED_BACKEND_ORDER.find((backend) => backends.includes(backend)) ??
		"cpu"
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
	if (!artifact.downloadUrl) {
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
	if (!artifact.downloadUrl) {
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

function loadRunCheck(installed: InstalledModel | undefined): LifecycleCheck {
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
	expectedBackend: Eliza1Backend,
): LifecycleCheck {
	if (expectedBackend === "cpu") {
		return status(
			"skipped",
			"no accelerated backend was detected; CPU fallback is allowed",
		);
	}
	return status(
		"pass",
		`accelerated backend ${expectedBackend} is available; CPU must not be the default (device backends: ${deviceBackends.join(", ")})`,
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
		const installed = byInstalledId.get(model.id);
		const componentPath = installed
			? componentPathFor(installed, artifact)
			: null;
		const fileCheck = componentPath
			? (options.localFileChecks?.[artifact.key] ?? null)
			: null;
		const publishStatus =
			model.publishStatus ?? eliza1TierPublishStatus(model.id);
		const implemented = implementedCheck(artifact);
		const integrated = integratedCheck(artifact, implemented);
		const deployable = deployableCheck(artifact, implemented);
		const published = publishedCheck(artifact, publishStatus);
		const downloadable = downloadableCheck(
			artifact,
			options.remoteChecks?.[artifact.key],
			published,
		);
		const installedStatus = installedCheck(installed, fileCheck);
		const loadRun = loadRunCheck(installed);
		const backend = backendPolicyCheck(deviceBackends, primaryBackend);
		const row: LocalModelLifecycleRow = {
			...artifact,
			publishStatus,
			quantization:
				artifact.component === "text" ? quantizationForModel(model) : null,
			runtime: {
				preferredBackend: model.runtime?.preferredBackend ?? null,
				requiredKernels: model.runtime?.optimizations?.requiresKernel ?? [],
				supportedBackends: supportedBackendsForModel(model),
				deviceBackends,
				expectedPrimaryBackend: primaryBackend,
				cpuFallbackAllowed: primaryBackend === "cpu",
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
			checks: {
				implemented,
				integrated,
				deployable,
				published,
				downloadable,
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
		"| Model | Component | Publish | Download | Installed | Load/run | Backend | Blockers |",
		"| --- | --- | --- | --- | --- | --- | --- | --- |",
	];

	for (const row of matrix.rows) {
		lines.push(
			[
				row.modelId,
				row.component,
				compactCheck(row.checks.published),
				compactCheck(row.checks.downloadable),
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
