/**
 * Public facade for the local-inference service.
 *
 * Single entry point used by the API routes, the settings UI, and any
 * future orchestration code. Holds singleton instances of the downloader
 * and active-model coordinator so subscribers receive the same event
 * stream across the process.
 */

import type { AgentRuntime } from "@elizaos/core";
import {
	ActiveModelCoordinator,
	type LocalInferenceLoadOverrides,
} from "./active-model";
import { readEffectiveAssignments, setAssignment } from "./assignments";
import { registerBundledModels } from "./bundled-models";
import type { CacheStatsEntry } from "./cache-bridge";
import { MODEL_CATALOG } from "./catalog";
import { dflashLlamaServer, getDflashRuntimeStatus } from "./dflash-server";
import { Downloader } from "./downloader";
import { localInferenceEngine } from "./engine";
import { probeHardware } from "./hardware";
import { createVisionCapabilityRegistration } from "./vision";
import type {
	VisionDescribeBackend,
	VisionDescribeRequest,
	VisionDescribeResult,
} from "./vision/types";
import { searchHuggingFaceGguf, searchModelHubGguf } from "./hf-search";
import {
	MemoryArbiter,
	setMemoryArbiter,
	tryGetMemoryArbiter,
} from "./memory-arbiter";
import {
	capacitorPressureSource,
	compositePressureSource,
	type MemoryPressureSource,
	nodeOsPressureSource,
} from "./memory-pressure";
import { buildTextGenerationReadiness } from "./readiness";
import {
	chooseSmallerFallbackModel,
	type RecommendedModelSelection,
	selectRecommendedModelForSlot,
	selectRecommendedModels,
} from "./recommendation";
import {
	listInstalledModels,
	removeElizaModel,
	upsertElizaModel,
} from "./registry";
import type {
	ActiveModelState,
	AgentModelSlot,
	CatalogModel,
	DownloadEvent,
	DownloadJob,
	HardwareProbe,
	LocalInferenceReadiness,
	ModelAssignments,
	ModelHubSnapshot,
	TextGenerationSlot,
} from "./types";
import { type VerifyResult, verifyInstalledModel } from "./verify";
import { verifyBundleOnDevice } from "./verify-on-device";

export class LocalInferenceService {
	// The downloader runs the engine-backed on-device verify pass
	// (`packages/inference/AGENTS.md` §7: load → 1-token text → 1-phrase voice
	// → barge-in cancel) after a bundle's bytes check out; a bundle that does
	// not pass does not auto-fill an empty default slot.
	private readonly downloader = new Downloader({
		verifyOnDevice: verifyBundleOnDevice,
	});
	private readonly activeModel = new ActiveModelCoordinator();
	private bundledBootstrap: Promise<void> | null = null;
	/**
	 * Memory Arbiter (WS1). Lazily created on first access so the heavy
	 * pressure-source machinery doesn't run for processes that never load
	 * a local model (CI, dev shells, etc.). Once created, the arbiter is
	 * also published via `setMemoryArbiter` so cross-plugin consumers
	 * (plugin-vision, plugin-image-gen) can use `getMemoryArbiter()`.
	 */
	private memoryArbiter: MemoryArbiter | null = null;
	/**
	 * Mobile pressure bridge — populated by the Capacitor host (iOS / Android
	 * onTrimMemory) so a native pressure callback can reach the arbiter.
	 * Stays null on desktop until WS2/WS8 wire the native side.
	 */
	private mobilePressureBridge: ReturnType<
		typeof capacitorPressureSource
	> | null = null;

	getCatalog() {
		return MODEL_CATALOG.filter((model) => !model.hiddenFromCatalog);
	}

	/**
	 * Register any bundled GGUF files staged by the AOSP build (or any
	 * other install path that drops a `manifest.json` next to the model
	 * files) into the registry. Runs at most once per process; the
	 * promise is cached so concurrent first callers wait on the same
	 * work.
	 */
	private bootstrapBundled(): Promise<void> {
		if (!this.bundledBootstrap) {
			this.bundledBootstrap = registerBundledModels()
				.then(() => undefined)
				.catch(() => undefined);
		}
		return this.bundledBootstrap;
	}

	async getInstalled() {
		await this.bootstrapBundled();
		return listInstalledModels();
	}

	async getHardware(): Promise<HardwareProbe> {
		return probeHardware();
	}

	getDownloads(): DownloadJob[] {
		return this.downloader.snapshot();
	}

	getActive(): ActiveModelState {
		return this.activeModel.snapshot();
	}

	async getAssignments(): Promise<ModelAssignments> {
		return readEffectiveAssignments();
	}

	async setSlotAssignment(
		slot: AgentModelSlot,
		modelId: string | null,
	): Promise<ModelAssignments> {
		await setAssignment(slot, modelId);
		return readEffectiveAssignments();
	}

	async snapshot(): Promise<ModelHubSnapshot> {
		const [installed, hardware, assignments] = await Promise.all([
			this.getInstalled(),
			this.getHardware(),
			this.getAssignments(),
		]);
		const active = this.getActive();
		const downloads = this.getDownloads();
		return {
			catalog: this.getCatalog(),
			installed,
			active,
			downloads,
			hardware,
			assignments,
			textReadiness: buildTextGenerationReadiness({
				assignments,
				installed,
				active,
				downloads,
				catalog: MODEL_CATALOG,
			}),
		};
	}

	async getTextReadiness(): Promise<LocalInferenceReadiness> {
		const [installed, assignments] = await Promise.all([
			this.getInstalled(),
			this.getAssignments(),
		]);
		return buildTextGenerationReadiness({
			assignments,
			installed,
			active: this.getActive(),
			downloads: this.getDownloads(),
			catalog: MODEL_CATALOG,
		});
	}

	async getRecommendedModel(
		slot: TextGenerationSlot,
		hardware?: HardwareProbe,
	): Promise<RecommendedModelSelection> {
		return selectRecommendedModelForSlot(
			slot,
			hardware ?? (await this.getHardware()),
			MODEL_CATALOG,
			{ binaryKernels: this.installedBinaryKernels() },
		);
	}

	async getRecommendedModels(
		hardware?: HardwareProbe,
	): Promise<Record<TextGenerationSlot, RecommendedModelSelection>> {
		return selectRecommendedModels(
			hardware ?? (await this.getHardware()),
			MODEL_CATALOG,
			{ binaryKernels: this.installedBinaryKernels() },
		);
	}

	/**
	 * Pull the kernels map from CAPABILITIES.json next to the installed
	 * llama-server binary. Null when the file is absent or when DFlash isn't
	 * enabled. Surfaces to the recommender so we don't recommend a model the
	 * installed binary can't actually run.
	 */
	private installedBinaryKernels(): Partial<Record<string, boolean>> | null {
		const caps = getDflashRuntimeStatus().capabilities;
		return caps?.kernels ?? null;
	}

	async startDownload(
		modelIdOrSpec: string | CatalogModel,
	): Promise<DownloadJob> {
		return this.downloader.start(modelIdOrSpec);
	}

	async startSmallerFallbackDownload(
		currentModelId: string,
		slot: TextGenerationSlot = "TEXT_LARGE",
		hardware?: HardwareProbe,
	): Promise<{ model: CatalogModel; job: DownloadJob } | null> {
		const model = chooseSmallerFallbackModel(
			currentModelId,
			hardware ?? (await this.getHardware()),
			slot,
			MODEL_CATALOG,
		);
		if (!model) return null;
		return {
			model,
			job: await this.startDownload(model.id),
		};
	}

	async searchHuggingFace(
		query: string,
		limit?: number,
	): Promise<CatalogModel[]> {
		return searchHuggingFaceGguf(query, limit);
	}

	async searchModelHub(
		query: string,
		hub: "huggingface" | "modelscope",
		limit?: number,
	): Promise<CatalogModel[]> {
		return searchModelHubGguf(query, hub, limit);
	}

	/**
	 * Verify an installed model's file integrity. When the model was a
	 * Eliza-download and there was no stored sha256 yet (legacy entry), the
	 * computed hash is persisted so subsequent verifies have a baseline.
	 */
	async verifyModel(id: string): Promise<VerifyResult> {
		const installed = await listInstalledModels();
		const model = installed.find((m) => m.id === id);
		if (!model) {
			throw new Error(`Model not installed: ${id}`);
		}
		const result = await verifyInstalledModel(model);

		// Self-heal: when a Eliza-owned legacy entry has no sha256 yet and
		// the file passes the structural GGUF check, pin the computed hash as
		// the baseline. External models are never mutated.
		if (
			result.state === "unknown" &&
			result.currentSha256 &&
			model.source === "eliza-download"
		) {
			await upsertElizaModel({
				...model,
				sha256: result.currentSha256,
				lastVerifiedAt: new Date().toISOString(),
			});
			return {
				...result,
				state: "ok",
				expectedSha256: result.currentSha256,
			};
		}
		if (result.state === "ok" && model.source === "eliza-download") {
			await upsertElizaModel({
				...model,
				lastVerifiedAt: new Date().toISOString(),
			});
		}
		return result;
	}

	cancelDownload(modelId: string): boolean {
		return this.downloader.cancel(modelId);
	}

	subscribeDownloads(listener: (event: DownloadEvent) => void): () => void {
		return this.downloader.subscribe(listener);
	}

	subscribeActive(listener: (state: ActiveModelState) => void): () => void {
		return this.activeModel.subscribe(listener);
	}

	async setActive(
		runtime: AgentRuntime | null,
		modelId: string,
		overrides?: LocalInferenceLoadOverrides,
	): Promise<ActiveModelState> {
		const installed = (await this.getInstalled()).find((m) => m.id === modelId);
		if (!installed) {
			throw new Error(`Model not installed: ${modelId}`);
		}
		return this.activeModel.switchTo(runtime, installed, overrides);
	}

	async clearActive(runtime: AgentRuntime | null): Promise<ActiveModelState> {
		return this.activeModel.unload(runtime);
	}

	/**
	 * Diagnostic snapshot of the local prefix-cache state. Returns:
	 *   - `dflash`: per-slot files persisted by the out-of-process
	 *     llama-server (size + mtime + age in ms).
	 *   - `engine`: in-process session-pool size and live cache keys.
	 * Used by the API layer to render a "local cache" debug panel.
	 */
	async getLocalCacheStats(): Promise<{
		dflash: {
			modelHash: string | null;
			slotDir: string | null;
			parallel: number;
			files: CacheStatsEntry[];
		};
		engine: { size: number; maxSize: number; keys: string[] } | null;
	}> {
		return {
			dflash: await dflashLlamaServer.describeCache(),
			engine: localInferenceEngine.describeSessionPool(),
		};
	}

	/**
	 * Memory Arbiter (WS1). Returns the process-wide arbiter, creating it on
	 * first call. The arbiter is constructed against the engine's existing
	 * `SharedResourceRegistry` so eviction policy is consistent across the
	 * voice/text paths and the cross-plugin handles.
	 *
	 * The pressure source is a composite of:
	 *   - `nodeOsPressureSource()` — desktop polling at 5 s.
	 *   - A `capacitorPressureSource()` bridge — populated by the Capacitor
	 *     host on iOS/Android. The native side calls `dispatchMobilePressure`
	 *     when the OS hands it a memory-warning callback.
	 */
	getMemoryArbiter(): MemoryArbiter {
		if (this.memoryArbiter) return this.memoryArbiter;
		const existing = tryGetMemoryArbiter();
		if (existing) {
			this.memoryArbiter = existing;
			return existing;
		}
		this.mobilePressureBridge = capacitorPressureSource();
		const desktopSource = nodeOsPressureSource();
		const composite: MemoryPressureSource = compositePressureSource([
			desktopSource,
			this.mobilePressureBridge,
		]);
		const arbiter = new MemoryArbiter({
			registry: localInferenceEngine.getSharedResources(),
			pressureSource: composite,
		});
		arbiter.start();
		setMemoryArbiter(arbiter);
		this.memoryArbiter = arbiter;
		// WS2: register the vision-describe capability so plugin-vision and
		// the IMAGE_DESCRIPTION runtime handler dispatch through llama.cpp's
		// mtmd path (the running llama-server's `--mmproj`-loaded projector).
		// The backend is a thin wrapper over `localInferenceEngine.describeImage`
		// — there is no separate model load: the projector is co-resident with
		// the active text bundle and lives or dies with it. Florence-2 has been
		// removed entirely (see VISION_MIGRATION.md).
		arbiter.registerCapability(
			createVisionCapabilityRegistration({
				arbiterCache: arbiter,
				estimatedMb: 600,
				loader: async () => {
					const backend: VisionDescribeBackend = {
						id: "llama-server",
						async describe(
							request: VisionDescribeRequest,
						): Promise<VisionDescribeResult> {
							const { resolveImageBytes } = await import("./vision/hash");
							const { bytes, mimeType } = resolveImageBytes(request.image);
							const result = await localInferenceEngine.describeImage({
								bytes,
								mimeType,
								prompt: request.prompt,
								maxTokens: request.maxTokens,
								temperature: request.temperature,
								signal: request.signal,
							});
							const trimmed = result.text.trim();
							if (!trimmed) {
								throw new Error(
									"[vision/llama-server] describe returned empty text",
								);
							}
							const title =
								trimmed.split(/[.!?]/, 1)[0]?.trim() || "Image";
							return {
								title,
								description: trimmed,
								projectorMs: result.projectorMs,
								decodeMs: result.decodeMs,
								cacheHit: false,
							};
						},
						async dispose() {
							// Lifetime owned by the engine; nothing to free here.
						},
					};
					return backend;
				},
			}),
		);
		return arbiter;
	}

	/**
	 * Capacitor bridge entrypoint. The mobile host (iOS / Android) calls
	 * this from the native pressure callback. Safe to call before the
	 * arbiter has been created — we create it on demand.
	 */
	dispatchMobilePressure(
		level: "nominal" | "low" | "critical",
		freeMb?: number,
	): void {
		this.getMemoryArbiter();
		this.mobilePressureBridge?.dispatch(level, freeMb);
	}

	async uninstall(
		modelId: string,
	): Promise<{ removed: boolean; reason?: "external" | "not-found" }> {
		// If the user is uninstalling the active model, unload it first so we
		// don't leave the plugin holding a handle to a deleted file.
		if (this.activeModel.snapshot().modelId === modelId) {
			await this.activeModel.unload(null);
		}
		return removeElizaModel(modelId);
	}
}

export const localInferenceService = new LocalInferenceService();
