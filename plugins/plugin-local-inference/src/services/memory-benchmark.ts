/**
 * Plans and measures resident-memory footprints for candidate models against a
 * hardware probe, so the recommender and diagnostics can compare estimated vs.
 * actual RAM cost per tier. Writes benchmark reports and reacts to arbiter
 * events for the currently loaded model.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import {
	ELIZA_1_CONTEXT_TARGET,
	ELIZA_1_KV_QUANT,
	selectBestEliza1Fit,
} from "@elizaos/shared/local-inference";
import type { ArbiterEvent } from "./memory-arbiter";
import type {
	CatalogModel,
	HardwareProbe,
	InstalledModel,
	ModelHubSnapshot,
} from "./types";

const BYTES_PER_MIB = 1024 * 1024;

export interface MemoryBenchmarkModelPlan {
	modelId: string;
	displayName: string;
	installed: boolean;
	path: string | null;
	bundleRoot: string | null;
	bundleSizeMb: number | null;
	fileSizeMb: number | null;
	estimatedResidentMb: number;
	catalogMinRamMb: number | null;
	catalogContextLength: number | null;
	fit: "fits" | "tight" | "wontfit";
	selectedByDeviceFit: boolean;
	plannedContextLength: number | null;
	plannedKvQuant: typeof ELIZA_1_KV_QUANT | null;
}

export interface MemoryBenchmarkLoadResult {
	modelId: string;
	ok: boolean;
	loadMs: number | null;
	generateMs: number | null;
	generatedTokens: number | null;
	generatedTokensPerSec: number | null;
	rssBeforeMb: number;
	rssAfterLoadMb: number | null;
	rssAfterGenerateMb: number | null;
	rssDeltaMb: number | null;
	loadedContextSize: number | null;
	loadedCacheTypeK: string | null;
	loadedCacheTypeV: string | null;
	error: string | null;
}

export interface MemoryBenchmarkReport {
	generatedAt: string;
	host: {
		platform: NodeJS.Platform;
		arch: NodeJS.Architecture;
		totalRamGb: number;
		freeRamGb: number;
		cpuCores: number;
	};
	deviceFit: {
		modelId: string | null;
		contextLength: number | null;
		kvQuant: typeof ELIZA_1_KV_QUANT | null;
		contextDownscaled: boolean;
		reason: string | null;
	};
	models: MemoryBenchmarkModelPlan[];
	loads: MemoryBenchmarkLoadResult[];
	telemetry: {
		modelLoads: number;
		modelUnloads: number;
		evictions: number;
		memoryPressureEvents: number;
		events: ArbiterEvent[];
	};
}

export interface MemoryBenchmarkOptions {
	loadInstalled?: boolean;
	prompt?: string;
	maxTokens?: number;
	outFile?: string;
}

function mbFromBytes(bytes: number | undefined): number | null {
	if (!Number.isFinite(bytes) || !bytes || bytes <= 0) return null;
	return Math.ceil(bytes / BYTES_PER_MIB);
}

function catalogMinRamMb(model: CatalogModel): number | null {
	return typeof model.minRamGb === "number"
		? Math.ceil(model.minRamGb * 1024)
		: null;
}

function estimateResidentMb(
	model: CatalogModel,
	installed: InstalledModel | undefined,
): number {
	const bundleMb = mbFromBytes(installed?.bundleSizeBytes);
	if (bundleMb !== null) return bundleMb;
	const minRamMb = catalogMinRamMb(model);
	if (minRamMb !== null) return minRamMb;
	const fileMb = mbFromBytes(installed?.sizeBytes);
	if (fileMb !== null) return fileMb;
	return Math.ceil((model.sizeGb ?? 0) * 1024);
}

function inferFit(
	hardware: HardwareProbe,
	model: CatalogModel,
): "fits" | "tight" | "wontfit" {
	if (typeof model.minRamGb !== "number") return "wontfit";
	if (hardware.freeRamGb >= model.minRamGb) return "fits";
	if (hardware.totalRamGb >= model.minRamGb) return "tight";
	return "wontfit";
}

export function buildMemoryBenchmarkPlan(snapshot: {
	catalog: CatalogModel[];
	installed: InstalledModel[];
	hardware: HardwareProbe;
}): MemoryBenchmarkModelPlan[] {
	const recommended = selectBestEliza1Fit(snapshot.hardware.freeRamGb);
	const installedById = new Map(
		snapshot.installed.map((model) => [model.id, model]),
	);

	return snapshot.catalog
		.filter((model) => !model.hiddenFromCatalog)
		.map((model) => {
			const installed = installedById.get(model.id);
			const selected = recommended?.tierId === model.id;
			return {
				modelId: model.id,
				displayName: model.displayName,
				installed: Boolean(installed),
				path: installed?.path ?? null,
				bundleRoot: installed?.bundleRoot ?? null,
				bundleSizeMb: mbFromBytes(installed?.bundleSizeBytes),
				fileSizeMb: mbFromBytes(installed?.sizeBytes),
				estimatedResidentMb: estimateResidentMb(model, installed),
				catalogMinRamMb: catalogMinRamMb(model),
				catalogContextLength: model.contextLength ?? null,
				fit: inferFit(snapshot.hardware, model),
				selectedByDeviceFit: selected,
				plannedContextLength: selected
					? recommended.contextLength
					: (model.contextLength ?? ELIZA_1_CONTEXT_TARGET),
				plannedKvQuant: selected ? recommended.kvQuant : ELIZA_1_KV_QUANT,
			};
		});
}

function rssMb(): number {
	return Math.round(process.memoryUsage.rss() / BYTES_PER_MIB);
}

function generatedTokenEstimate(text: string): number {
	const trimmed = text.trim();
	if (!trimmed) return 0;
	return Math.max(1, Math.ceil(trimmed.length / 4));
}

function eventCounts(
	events: ArbiterEvent[],
): MemoryBenchmarkReport["telemetry"] {
	return {
		modelLoads: events.filter((event) => event.type === "model_load").length,
		modelUnloads: events.filter((event) => event.type === "model_unload")
			.length,
		evictions: events.filter((event) => event.type === "eviction").length,
		memoryPressureEvents: events.filter(
			(event) => event.type === "memory_pressure",
		).length,
		events,
	};
}

async function loadAndMeasure(
	model: InstalledModel,
	options: Required<Pick<MemoryBenchmarkOptions, "prompt" | "maxTokens">>,
	deps: {
		service: typeof import("./service").localInferenceService;
		engine: typeof import("./engine").localInferenceEngine;
	},
): Promise<MemoryBenchmarkLoadResult> {
	const before = rssMb();
	const start = performance.now();
	try {
		const state = await deps.service.setActive(null, model.id);
		const afterLoad = rssMb();
		const loadMs = performance.now() - start;
		let generateMs: number | null = null;
		let generatedTokens: number | null = null;
		let generatedTokensPerSec: number | null = null;
		let afterGenerate: number | null = null;

		if (deps.engine.hasLoadedModel()) {
			const generateStart = performance.now();
			const text = await deps.engine.generate({
				prompt: options.prompt,
				maxTokens: options.maxTokens,
				temperature: 0,
			});
			generateMs = performance.now() - generateStart;
			generatedTokens = generatedTokenEstimate(text);
			generatedTokensPerSec =
				generateMs > 0 ? generatedTokens / (generateMs / 1000) : null;
			afterGenerate = rssMb();
		}

		return {
			modelId: model.id,
			ok: state.status === "ready",
			loadMs: Math.round(loadMs),
			generateMs: generateMs === null ? null : Math.round(generateMs),
			generatedTokens,
			generatedTokensPerSec:
				generatedTokensPerSec === null
					? null
					: Number(generatedTokensPerSec.toFixed(2)),
			rssBeforeMb: before,
			rssAfterLoadMb: afterLoad,
			rssAfterGenerateMb: afterGenerate,
			rssDeltaMb: (afterGenerate ?? afterLoad) - before,
			loadedContextSize: state.loadedContextSize ?? null,
			loadedCacheTypeK: state.loadedCacheTypeK ?? null,
			loadedCacheTypeV: state.loadedCacheTypeV ?? null,
			error: state.status === "error" ? (state.error ?? "load failed") : null,
		};
	} catch (err) {
		return {
			modelId: model.id,
			ok: false,
			loadMs: null,
			generateMs: null,
			generatedTokens: null,
			generatedTokensPerSec: null,
			rssBeforeMb: before,
			rssAfterLoadMb: null,
			rssAfterGenerateMb: null,
			rssDeltaMb: null,
			loadedContextSize: null,
			loadedCacheTypeK: null,
			loadedCacheTypeV: null,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

function hostFromHardware(
	hardware: HardwareProbe,
): MemoryBenchmarkReport["host"] {
	return {
		platform: hardware.platform,
		arch: hardware.arch,
		totalRamGb: hardware.totalRamGb,
		freeRamGb: hardware.freeRamGb,
		cpuCores: hardware.cpuCores,
	};
}

function deviceFitFromHardware(
	hardware: HardwareProbe,
): MemoryBenchmarkReport["deviceFit"] {
	const fit = selectBestEliza1Fit(hardware.freeRamGb);
	return {
		modelId: fit?.tierId ?? null,
		contextLength: fit?.contextLength ?? null,
		kvQuant: fit?.kvQuant ?? null,
		contextDownscaled: fit?.contextDownscaled ?? false,
		reason: fit?.reason ?? null,
	};
}

export async function buildMemoryBenchmarkReport(
	snapshot: Pick<ModelHubSnapshot, "catalog" | "installed" | "hardware">,
	events: ArbiterEvent[] = [],
	loads: MemoryBenchmarkLoadResult[] = [],
): Promise<MemoryBenchmarkReport> {
	return {
		generatedAt: new Date().toISOString(),
		host: hostFromHardware(snapshot.hardware),
		deviceFit: deviceFitFromHardware(snapshot.hardware),
		models: buildMemoryBenchmarkPlan(snapshot),
		loads,
		telemetry: eventCounts(events),
	};
}

export async function runMemoryBenchmark(
	options: MemoryBenchmarkOptions = {},
): Promise<MemoryBenchmarkReport> {
	const [{ localInferenceService }, { localInferenceEngine }] =
		await Promise.all([import("./service"), import("./engine")]);
	const events: ArbiterEvent[] = [];
	const arbiter = localInferenceService.getMemoryArbiter();
	const unsubscribe = arbiter.onEvent((event) => {
		events.push(event);
	});

	const snapshot = await localInferenceService.snapshot();
	const loads: MemoryBenchmarkLoadResult[] = [];
	const prompt =
		options.prompt ??
		"Summarize why a curated Eliza-1 local model should choose its own memory profile.";
	const maxTokens = options.maxTokens ?? 32;

	try {
		if (options.loadInstalled) {
			for (const installed of snapshot.installed.filter(
				(model) => model.source === "eliza-download",
			)) {
				loads.push(
					await loadAndMeasure(
						installed,
						{ prompt, maxTokens },
						{ service: localInferenceService, engine: localInferenceEngine },
					),
				);
				await localInferenceService.clearActive(null);
			}
		}
	} finally {
		unsubscribe();
	}

	const report = await buildMemoryBenchmarkReport(snapshot, events, loads);
	if (options.outFile) {
		await mkdir(dirname(options.outFile), { recursive: true });
		await writeFile(options.outFile, `${JSON.stringify(report, null, 2)}\n`);
	}
	return report;
}

export function summarizeMemoryBenchmark(
	report: MemoryBenchmarkReport,
): string {
	const selected = report.deviceFit.modelId
		? `${report.deviceFit.modelId} @ ${report.deviceFit.contextLength} ctx`
		: "cloud fallback";
	const installed = report.models.filter((model) => model.installed).length;
	const loaded = report.loads.filter((load) => load.ok).length;
	return [
		`Eliza-1 memory benchmark (${report.generatedAt})`,
		`Host: ${report.host.platform}/${report.host.arch}, ${report.host.freeRamGb.toFixed(1)} GB free of ${report.host.totalRamGb.toFixed(1)} GB`,
		`Device-fit pick: ${selected}`,
		`Catalog tiers: ${report.models.length}; installed: ${installed}; loaded: ${loaded}`,
		`Telemetry: loads=${report.telemetry.modelLoads}, unloads=${report.telemetry.modelUnloads}, evictions=${report.telemetry.evictions}, pressure=${report.telemetry.memoryPressureEvents}`,
	].join("\n");
}
