/**
 * Public facade for the local-inference service.
 *
 * Single entry point used by the API routes, settings UI, and orchestration
 * code. Holds singleton instances of the downloader
 * and active-model coordinator so subscribers receive the same event
 * stream across the process.
 */

import { existsSync } from "node:fs";
import { totalmem } from "node:os";
import { join as pathJoin } from "node:path";
import {
	type AgentRuntime,
	logger,
	renderMessageHandlerStablePrefix,
	type UUID,
} from "@elizaos/core";
import {
	ActiveModelCoordinator,
	type LocalInferenceLoadOverrides,
} from "./active-model";
import { readEffectiveAssignments, setAssignment } from "./assignments";
import { registerBundledModels } from "./bundled-models";
import { MODEL_CATALOG } from "./catalog";
import { Downloader } from "./downloader";
import { localInferenceEngine } from "./engine";
import { probeHardware } from "./hardware";
import { searchHuggingFaceGguf, searchModelHubGguf } from "./hf-search";
import {
	createImageGenCapabilityRegistration,
	type ImageGenBackend,
	type ImageGenLoadArgs,
	loadAospImageGenBackend,
	loadCoreMlImageGenBackend,
	loadMfluxImageGenBackend,
	loadSdCppImageGenBackend,
	loadTensorRtImageGenBackend,
	resolveDefaultImageGenModel,
	selectImageGenBackends,
} from "./imagegen";
import { isImageGenUnavailable } from "./imagegen/errors";
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
import { ramHeadroomReserveMb } from "./ram-budget";
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
import {
	type RoutingPreferences,
	readRoutingPreferences,
	writeRoutingPreferences,
} from "./routing-preferences";
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
import { createVisionCapabilityRegistration } from "./vision";
import type {
	VisionDescribeBackend,
	VisionDescribeRequest,
	VisionDescribeResult,
} from "./vision/types";
import { prewarmLocalVoiceStackForModel } from "./voice-prewarm";

const SYSTEM_PREFIX_CONVERSATION_ID = "__system_prefix__";
const LOCAL_INFERENCE_PROVIDER_ID = "eliza-local-inference";
const ACTIVATED_TEXT_ROUTING_SLOTS: AgentModelSlot[] = [
	"TEXT_SMALL",
	"TEXT_LARGE",
];
const LEGACY_LOCAL_ROUTING_PROVIDERS = new Set([
	"capacitor-llama",
	"eliza-device-bridge",
	"eliza-aosp-llama",
]);

function shouldRouteActivatedModelToLocal(
	provider: string | undefined,
): boolean {
	return (
		!provider ||
		provider === LOCAL_INFERENCE_PROVIDER_ID ||
		LEGACY_LOCAL_ROUTING_PROVIDERS.has(provider)
	);
}

async function routeActivatedModelToLocalText(): Promise<void> {
	const current = await readRoutingPreferences();
	const next: RoutingPreferences = {
		preferredProvider: { ...current.preferredProvider },
		policy: { ...current.policy },
	};
	let changed = false;

	for (const slot of ACTIVATED_TEXT_ROUTING_SLOTS) {
		const provider = next.preferredProvider[slot];
		if (!shouldRouteActivatedModelToLocal(provider)) continue;
		if (provider !== LOCAL_INFERENCE_PROVIDER_ID) {
			next.preferredProvider[slot] = LOCAL_INFERENCE_PROVIDER_ID;
			changed = true;
		}
		if (next.policy[slot] !== "manual") {
			next.policy[slot] = "manual";
			changed = true;
		}
	}

	if (changed) {
		await writeRoutingPreferences(next);
	}
}

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
	private imageGenCapabilityRegistered = false;

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
	 * Kernel capability probing is now owned by the native FFI runtime. Null
	 * means "no static CAPABILITIES.json probe"; the dispatcher still enforces
	 * runtime-required kernels at load time.
	 */
	private installedBinaryKernels(): Partial<Record<string, boolean>> | null {
		return null;
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
		const state = await this.activeModel.switchTo(
			runtime,
			installed,
			overrides,
		);
		if (state.status === "ready") {
			await routeActivatedModelToLocalText();
		}
		if (runtime && state.status === "ready") {
			void (async () => {
				await this.prewarmActiveVoice(modelId);
				await this.prewarmSystemPrefix(runtime);
			})().catch(() => {
				// Individual prewarm helpers log their own failures; activation
				// should not regress to a blocking path if a best-effort warmup misses.
			});
		}
		return state;
	}

	async prewarmActiveVoice(modelId: string): Promise<boolean> {
		return prewarmLocalVoiceStackForModel(modelId);
	}

	/**
	 * Warm the Stage-1 stable prefix after an explicit model activation.
	 *
	 * `ensureLocalInferenceHandler` also attempts this at runtime boot, but
	 * desktop activation often happens later through `/api/local-inference/active`;
	 * at boot there may be no resident model, so that early warmup correctly
	 * no-ops. Running it here closes that gap without blocking activation.
	 */
	async prewarmSystemPrefix(runtime: AgentRuntime): Promise<boolean> {
		if (!localInferenceEngine.hasLoadedModel()) return false;
		if (localInferenceEngine.activeBackendId() !== "llama-cpp") return false;
		try {
			const fixedRoomId = (runtime.agentId ??
				SYSTEM_PREFIX_CONVERSATION_ID) as UUID;
			const prefix = await renderMessageHandlerStablePrefix(
				runtime,
				fixedRoomId,
			);
			if (!prefix) return false;
			return await localInferenceEngine.prewarmConversation(
				SYSTEM_PREFIX_CONVERSATION_ID,
				prefix,
			);
		} catch (err) {
			logger.debug(
				"[local-inference] activation prewarmSystemPrefix failed (best-effort):",
				err instanceof Error ? err.message : String(err),
			);
			return false;
		}
	}

	async clearActive(runtime: AgentRuntime | null): Promise<ActiveModelState> {
		return this.activeModel.unload(runtime);
	}

	/**
	 * Diagnostic snapshot of the local prefix-cache state. Returns:
	 *   - `engine`: in-process session-pool size and live cache keys.
	 * Used by the API layer to render a "local cache" debug panel.
	 */
	async getLocalCacheStats(): Promise<{
		engine: { size: number; maxSize: number; keys: string[] } | null;
	}> {
		return {
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
			this.registerImageGenCapability(existing);
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
			// Usable RAM for the proactive fit-to-budget LRU path: host RAM
			// minus the OS/runtime headroom reserve. On mobile the OS-pressure
			// bridge is the primary signal; this is the desktop multi-model
			// backstop that evicts the coldest model before an overcommit.
			budgetMb: () =>
				Math.max(
					0,
					Math.floor(totalmem() / (1024 * 1024)) - ramHeadroomReserveMb(),
				),
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
							const title = trimmed.split(/[.!?]/, 1)[0]?.trim() || "Image";
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
		this.registerImageGenCapability(arbiter);
		return arbiter;
	}

	private registerImageGenCapability(arbiter: MemoryArbiter): void {
		if (
			this.imageGenCapabilityRegistered ||
			arbiter.hasCapability("image-gen")
		) {
			this.imageGenCapabilityRegistered = true;
			return;
		}
		arbiter.registerCapability(
			createImageGenCapabilityRegistration({
				estimatedMb: 1100,
				loader: async (modelKey) => this.loadImageGenBackend(modelKey),
			}),
		);
		this.imageGenCapabilityRegistered = true;
	}

	private async loadImageGenBackend(
		modelKey: string,
	): Promise<ImageGenBackend> {
		const loadArgs = await this.resolveImageGenLoadArgs(modelKey);
		const profile = {
			platform: process.platform,
			arch: process.arch,
			gpu: undefined,
			requiredAccelerator: parseImageGenRequiredAccelerator(
				process.env.ELIZA_IMAGEGEN_ACCELERATOR,
			),
			isIos: process.env.ELIZA_PLATFORM === "ios",
			isAndroid:
				process.env.ELIZA_PLATFORM === "android" ||
				process.env.ELIZA_LOCAL_LLAMA === "1",
		} as const;
		const errors: string[] = [];
		for (const choice of selectImageGenBackends(profile)) {
			const args = { ...loadArgs, accelerator: choice.accelerator };
			try {
				switch (choice.backendId) {
					case "aosp":
						return await loadAospImageGenBackend({
							loadArgs: args,
							modelKey: loadArgs.modelKey,
						});
					case "coreml":
						return await loadCoreMlImageGenBackend({
							loadArgs: args,
							modelKey: loadArgs.modelKey,
						});
					case "mflux":
						return await loadMfluxImageGenBackend({
							loadArgs: args,
							modelKey: loadArgs.modelKey,
						});
					case "tensorrt":
						return await loadTensorRtImageGenBackend({
							loadArgs: args,
							modelKey: loadArgs.modelKey,
						});
					case "sd-cpp":
						return await loadSdCppImageGenBackend({
							loadArgs: args,
							modelKey: loadArgs.modelKey,
						});
				}
			} catch (err) {
				if (!isImageGenUnavailable(err)) throw err;
				errors.push(err.message);
			}
		}
		throw new Error(
			`[imagegen] no backend available for ${loadArgs.modelKey}: ${errors.join("; ")}`,
		);
	}

	private async resolveImageGenLoadArgs(
		modelKey: string,
	): Promise<ImageGenLoadArgs & { modelKey: string }> {
		const resolved = resolveDefaultImageGenModel(modelKey);
		if (!resolved) {
			throw new Error(
				`[imagegen] unknown image generation model key: ${modelKey}`,
			);
		}
		const activeId = this.activeModel.snapshot().modelId;
		const installed = await this.getInstalled();
		const active = activeId
			? installed.find((model) => model.id === activeId)
			: undefined;
		const owner =
			active?.bundleRoot &&
			this.imageGenFileExists(active.bundleRoot, resolved.file)
				? active
				: installed.find(
						(model) =>
							Boolean(model.bundleRoot) &&
							this.imageGenFileExists(
								model.bundleRoot as string,
								resolved.file,
							),
					);
		if (!owner?.bundleRoot) {
			throw new Error(
				`[imagegen] ${resolved.modelId} is not installed. Expected ${resolved.file} under the active Eliza-1 bundle root.`,
			);
		}
		const companion = (file: string | undefined): string | undefined => {
			if (!file) return undefined;
			const fullPath = pathJoin(owner.bundleRoot as string, file);
			if (!existsSync(fullPath)) {
				throw new Error(
					`[imagegen] ${resolved.modelId} companion asset is not installed. Expected ${file} under the active Eliza-1 bundle root.`,
				);
			}
			return fullPath;
		};
		return {
			modelKey: resolved.modelId,
			modelPath: pathJoin(owner.bundleRoot, resolved.file),
			splitDiffusionModel: resolved.splitDiffusionModel,
			vae: companion(resolved.vae),
			llm: companion(resolved.llm),
			accelerator: "auto",
		};
	}

	private imageGenFileExists(bundleRoot: string, file: string): boolean {
		return existsSync(pathJoin(bundleRoot, file));
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

function parseImageGenRequiredAccelerator(
	value: string | undefined,
): "cpu" | "cuda" | "vulkan" | "metal" | "coreml" | "tensorrt" | undefined {
	switch (value?.toLowerCase()) {
		case "cpu":
		case "cuda":
		case "vulkan":
		case "metal":
		case "coreml":
		case "tensorrt":
			return value.toLowerCase() as
				| "cpu"
				| "cuda"
				| "vulkan"
				| "metal"
				| "coreml"
				| "tensorrt";
		default:
			return undefined;
	}
}

export const localInferenceService = new LocalInferenceService();
