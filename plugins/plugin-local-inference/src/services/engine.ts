/**
 * Standalone llama.cpp engine.
 *
 * Fronts the in-process FFI backend (fused `libelizainference`, or the
 * libllama + eliza-llama-shim fallback) via the `BackendDispatcher`. At most
 * one model is loaded at a time — model swap is unload-then-load so we never
 * double-allocate VRAM.
 *
 * Two consumption paths:
 *   1. The Model Hub UI calls `load()` / `unload()` to make "Activate" work.
 *   2. The agent runtime calls `generate()` via the registered
 *      `ModelType.TEXT_SMALL` / `TEXT_LARGE` handlers (see
 *      `ensure-local-inference-handler.ts`).
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import {
	logger,
	type ResponseSkeleton,
	ResponseSkeletonStreamExtractor,
} from "@elizaos/core";
import { isMobilePlatform } from "@elizaos/shared";
import type { LocalInferenceLoadArgs } from "./active-model";
import {
	bundleHasAsrModelFiles,
	readBundleAsrProvenanceBlockers,
} from "./asr-provenance";
import { readEffectiveAssignments } from "./assignments";
import type {
	GenerateArgs as BackendGenerateArgs,
	BackendPlan,
	LocalGenerateWithUsageResult,
	LocalRuntimeLoadConfig,
} from "./backend";
import { BackendDispatcher } from "./backend";
import {
	ELIZA_1_PLACEHOLDER_IDS,
	type Eliza1TierId,
	findCatalogModel,
} from "./catalog";
import {
	type ConversationHandle,
	conversationRegistry,
} from "./conversation-registry";
import { desktopFusedFfiBackendRuntime } from "./desktop-fused-ffi-backend-runtime";
import { FfiStreamingBackend } from "./ffi-streaming-backend";
import { estimateDecodeTokens, recordDecodeThroughput } from "./live-signals";
import { MemoryMonitor } from "./memory-monitor";
import { listInstalledModels } from "./registry";
import { resolveDefaultPoolSize } from "./session-pool";
import type { InstalledModel } from "./types";
import type { CoordinatorRuntime } from "./voice/cancellation-coordinator";
import {
	createKokoroSpeakerPreset,
	createKokoroTtsBackend,
	EngineVoiceBridge,
	type EngineVoiceBridgeOptions,
	VoiceStartupError,
} from "./voice/engine-bridge";
import type { AsrWordTiming } from "./voice/ffi-bindings";
import { resolveKokoroEngineConfig } from "./voice/kokoro/kokoro-engine-discovery";
import {
	readVoiceBackendModeFromEnv,
	selectVoiceBackend,
} from "./voice/kokoro/runtime-selection";
import type { VoicePipelineEvents } from "./voice/pipeline";
import { type MtpTextRunner, mtpTextRunner } from "./voice/pipeline-impls";
import {
	createEvictableModelRole,
	SharedResourceRegistry,
} from "./voice/shared-resources";
import { getSharedVoiceProfileStore } from "./voice/speaker/profile-store-factory";
import type {
	RejectedTokenRange,
	TextToken,
	TranscriptionAudio,
	VerifierStreamEvent,
} from "./voice/types";

/**
 * Default MTP draft window per round for voice turns. Small (≤8) so a
 * rollback is cheap (AGENTS.md §4 — "small chunk = low latency cost on
 * rollback"). Overridable per call via `runVoiceTurn({ maxDraftTokens })`.
 */
const DEFAULT_VOICE_MAX_DRAFT_TOKENS = 8;
export interface LocalUsageBlock {
	[key: string]: unknown;
	input_tokens: number;
	output_tokens: number;
	cache_creation_input_tokens: number;
	cache_read_input_tokens: number;
	mtp_drafted_tokens?: number;
	mtp_accepted_tokens?: number;
	mtp_acceptance_rate?: number;
	cache_hit_rate?: number;
}
const DEFAULT_VOICE_SKELETON_STREAM_FIELDS = new Set([
	"replyText",
	"text",
	"messageToUser",
]);

function resolveVoiceSkeletonStreamFields(
	skeleton: ResponseSkeleton | undefined,
): string[] {
	if (!skeleton) return [];
	const fields: string[] = [];
	const seen = new Set<string>();
	for (const span of skeleton.spans) {
		const key = span.key;
		if (
			span.kind === "free-string" &&
			key &&
			DEFAULT_VOICE_SKELETON_STREAM_FIELDS.has(key) &&
			!seen.has(key)
		) {
			seen.add(key);
			fields.push(key);
		}
	}
	return fields;
}

function skeletonHasFreeStringKey(
	skeleton: ResponseSkeleton | undefined,
	key: string,
): boolean {
	return (
		skeleton?.spans.some(
			(span) => span.kind === "free-string" && span.key === key,
		) ?? false
	);
}

/**
 * Idle-unload timeout (J3). After this long with no `useModel` activity
 * (text generation, embeddings, voice turns) the engine unloads the active
 * text model so its weights are reclaimed when the agent is quiet; the next
 * `useModel` lazy-reloads via the runtime handler. `0` disables it. Default
 * 15 minutes. Override via `ELIZA_LOCAL_IDLE_UNLOAD_MS`.
 */
const DEFAULT_IDLE_UNLOAD_MS = 15 * 60 * 1000;
/** How often the idle-unload timer checks the activity clock. */
const IDLE_UNLOAD_CHECK_INTERVAL_MS = 60 * 1000;
const BYTES_PER_MIB = 1024 * 1024;
const GIB_PER_GB = 1024;
const TEXT_RESIDENT_OVERHEAD_MB = 512;

export function resolveIdleUnloadMs(): number {
	const raw = process.env.ELIZA_LOCAL_IDLE_UNLOAD_MS?.trim();
	if (raw === undefined) return DEFAULT_IDLE_UNLOAD_MS;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_IDLE_UNLOAD_MS;
	return parsed;
}

/**
 * Cap on how many speculative voice responses the turn-controller (W9) may
 * have in flight at once — derived from the running server's slot count
 * (each speculative response needs a slot's KV) but never more than half of
 * them (the other half stays available for confirmed turns + tool calls).
 * Floors at 1. Override via `ELIZA_LOCAL_MAX_SPECULATIVE_RESPONSES`.
 */
export function resolveMaxConcurrentSpeculativeResponses(
	parallelSlots: number,
): number {
	const raw = process.env.ELIZA_LOCAL_MAX_SPECULATIVE_RESPONSES?.trim();
	if (raw) {
		const parsed = Number.parseInt(raw, 10);
		if (Number.isFinite(parsed) && parsed >= 1) return parsed;
	}
	return Math.max(1, Math.floor(parallelSlots / 2));
}

// Re-export of backend.ts's canonical GenerateArgs shape, including the
// optional `cacheKey` for prefix reuse via the session pool.
export type GenerateArgs = BackendGenerateArgs;

/**
 * Resolve the active Eliza-1 bundle (root dir + tier id) from an
 * `InstalledModel`, or `null` when the model is not an Eliza-1 bundle. An
 * Eliza-1 InstalledModel carries `bundleRoot` and an `eliza-1-<tier>` id
 * (the catalog seed ids). Drives the local-embedding route.
 */
interface ActiveEliza1Bundle {
	root: string;
	tierId: Eliza1TierId;
}

function resolveActiveEliza1Bundle(
	target: InstalledModel | undefined,
): ActiveEliza1Bundle | null {
	if (!target?.bundleRoot) return null;
	if (!ELIZA_1_PLACEHOLDER_IDS.has(target.id)) return null;
	return {
		root: target.bundleRoot,
		tierId: target.id as Eliza1TierId,
	};
}

function resolveDirectEliza1Bundle(
	args: LocalInferenceLoadArgs | undefined,
): ActiveEliza1Bundle | null {
	if (!args?.modelId || !ELIZA_1_PLACEHOLDER_IDS.has(args.modelId)) return null;
	return {
		root: path.dirname(path.dirname(args.modelPath)),
		tierId: args.modelId as Eliza1TierId,
	};
}

function estimateTextResidentMb(
	installed: InstalledModel | undefined,
	catalog: ReturnType<typeof findCatalogModel>,
): number {
	const installedMb =
		typeof installed?.sizeBytes === "number" && installed.sizeBytes > 0
			? Math.ceil(installed.sizeBytes / BYTES_PER_MIB)
			: 0;
	const catalogMb =
		typeof catalog?.sizeGb === "number" && catalog.sizeGb > 0
			? Math.ceil(catalog.sizeGb * GIB_PER_GB)
			: 0;
	const baseMb = Math.max(installedMb, catalogMb);
	return baseMb > 0 ? baseMb + TEXT_RESIDENT_OVERHEAD_MB : 0;
}

function stagedLitertModelPath(
	bundleRoot: string,
	modelId: string | undefined,
): string | undefined {
	const textDir = path.join(bundleRoot, "text");
	if (!existsSync(textDir) || !statSync(textDir).isDirectory()) {
		return undefined;
	}

	if (modelId?.startsWith("eliza-1-")) {
		const expected = path.join(textDir, `${modelId}.litertlm`);
		if (existsSync(expected) && statSync(expected).isFile()) {
			return expected;
		}
	}

	const candidates = readdirSync(textDir)
		.filter((name) => name.endsWith(".litertlm"))
		.sort();
	if (candidates.length === 1) {
		const candidate = path.join(textDir, candidates[0]);
		if (statSync(candidate).isFile()) return candidate;
	}
	return undefined;
}

/**
 * Project a fully-resolved `LocalInferenceLoadArgs` onto the subset that
 * the dispatcher cares about. Keeps `BackendLoadOverrides` framework-free
 * (no dependency on active-model.ts here) so backend.ts and engine.ts stay
 * cycle-free.
 */
function toBackendLoadOverrides(
	args: LocalInferenceLoadArgs,
): BackendPlan["overrides"] {
	const overrides: BackendPlan["overrides"] = {};
	if (args.contextSize !== undefined) overrides.contextSize = args.contextSize;
	if (args.cacheTypeK !== undefined) overrides.cacheTypeK = args.cacheTypeK;
	if (args.cacheTypeV !== undefined) overrides.cacheTypeV = args.cacheTypeV;
	if (args.gpuLayers !== undefined) overrides.gpuLayers = args.gpuLayers;
	if (args.kvOffload !== undefined) overrides.kvOffload = args.kvOffload;
	if (args.flashAttention !== undefined) {
		overrides.flashAttention = args.flashAttention;
	}
	if (args.mmap !== undefined) overrides.mmap = args.mmap;
	if (args.mlock !== undefined) overrides.mlock = args.mlock;
	if (args.useGpu !== undefined) overrides.useGpu = args.useGpu;
	if (args.mmprojPath !== undefined) overrides.mmprojPath = args.mmprojPath;
	if (args.draftModelPath !== undefined) {
		overrides.draftModelPath = args.draftModelPath;
	}
	if (args.modelId?.startsWith("eliza-1-")) {
		const bundleRoot = path.dirname(path.dirname(args.modelPath));
		overrides.bundleRoot = bundleRoot;
		overrides.manifestPath = path.join(bundleRoot, "eliza-1.manifest.json");
		const litertModelPath = stagedLitertModelPath(bundleRoot, args.modelId);
		if (litertModelPath) overrides.litertModelPath = litertModelPath;
	}
	return overrides;
}

/**
 * Public engine facade.
 *
 * Pre-existing API: `load(modelPath)`, `unload()`, `generate(args)`,
 * plus the activity probes used by router/handler/active-model code. The
 * implementation now sits behind the backend dispatcher; the
 * shape is preserved so callers (active-model, router-handler, the agent
 * runtime handler) keep working unchanged.
 *
 * MTP now lives in the normal optimized llama.cpp backend path. The
 * dispatcher's decision tree picks `llama-cpp` when a kernel is required
 * or when the catalog prefers optimized llama.cpp.
 */
export class LocalInferenceEngine {
	/**
	 * In-process FFI backend — the sole text runtime, served by the FUSED
	 * `libelizainference` (`desktop-fused-ffi-backend-runtime.ts`). Text gen,
	 * MTP speculative decoding, KV-cache quant, native tokenization,
	 * and vision-describe all run through the one fused lib the voice subsystem
	 * already loads (ABI v9). libllama has been retired: a fused lib that is
	 * absent or lacks the v9 capabilities is a loud `LocalInferenceUnavailable`
	 * error, never a silent fallback. There is no server fallback for Eliza-1.
	 */
	private readonly ffiBackend = new FfiStreamingBackend(
		desktopFusedFfiBackendRuntime,
	);
	private readonly dispatcher = new BackendDispatcher(
		this.ffiBackend,
		() => desktopFusedFfiBackendRuntime.supported(),
		() => null,
	);
	/**
	 * Active voice-streaming bridge (`EngineVoiceBridge`). Only set when an
	 * Eliza-1 bundle has been activated AND `startVoice()` has succeeded —
	 * see `packages/inference/AGENTS.md` §3 + §4. The engine never lazily
	 * stands up a voice session: callers either start it explicitly or get
	 * a hard error.
	 */
	private voiceBridge: EngineVoiceBridge | null = null;
	private voiceReadyPromise: Promise<EngineVoiceBridge> | null = null;
	private asrReadyPromise: Promise<EngineVoiceBridge> | null = null;

	/**
	 * The general onload/offload coordinator (W10 / J5). One registry per
	 * engine: text + voice both ref-count their shared resources against it,
	 * and every resident model role registers an `EvictableModelRole` here so
	 * the `MemoryMonitor` can walk them ascending-priority under RAM pressure.
	 * The voice bridge gets this passed in (see `startVoice`) so it doesn't
	 * spin up a private one.
	 */
	private readonly sharedResources = new SharedResourceRegistry({
		logger: {
			debug: (m) => console.debug(m),
			warn: (m) => console.warn(m),
			info: (m) => console.info(m),
		},
	});

	/**
	 * RAM-pressure monitor (J2). Started when a model loads, stopped when the
	 * engine unloads. Evicts the lowest-priority resident role when free RAM
	 * crosses the low-water line.
	 */
	private readonly memoryMonitor = new MemoryMonitor({
		registry: this.sharedResources,
		logger: {
			info: (m) => console.info(m),
			warn: (m) => console.warn(m),
			debug: (m) => console.debug(m),
		},
	});

	/** Wall-clock ms of the last `useModel`-style activity. */
	private lastActivityMs = Date.now();
	/** Idle-unload timer (J3); null when disabled or no model loaded. */
	private idleUnloadTimer: NodeJS.Timeout | null = null;
	/** Evictable text-target role id registered on `sharedResources`, or null. */
	private textTargetRoleId: string | null = null;
	/**
	 * Ids of evictable roles THIS engine registered on `sharedResources`
	 * (text-target today). `getResidentFootprintMb()` sums only these so the
	 * arbiter never double-counts its own vision/image-gen registry roles.
	 */
	private readonly ownedEvictableRoleIds = new Set<string>();
	/** Best-effort resident footprint for the active text bundle, in MiB. */
	private textTargetEstimatedMb = 0;
	/** Evictable drafter role id registered on `sharedResources`, or null. */

	/**
	 * The active Eliza-1 bundle (root dir + tier id), resolved at `load()`
	 * from the InstalledModel path/id. `null` when the loaded model is not an
	 * Eliza-1 bundle (a user-installed custom). Drives bundle-relative voice
	 * resolution — the Kokoro TTS root and the per-tier EOT turn-detector
	 * revision.
	 */
	private activeEliza1Bundle: ActiveEliza1Bundle | null = null;

	/**
	 * The general onload/offload coordinator for this engine. Exposed so the
	 * voice lifecycle, the embedding route, and any other resident model role
	 * can register an `EvictableModelRole` against the same registry the
	 * `MemoryMonitor` walks under pressure.
	 */
	getSharedResources(): SharedResourceRegistry {
		return this.sharedResources;
	}

	/**
	 * Resident RAM footprint (MB) of the model weights this engine owns on the
	 * shared registry — the active text/embedding bundle today, plus any future
	 * engine-registered role (drafter, voice). This is the term `service.ts`
	 * feeds into the `MemoryArbiter` as `externalFootprintMb` so the arbiter's
	 * proactive `evictToFit` path accounts for the dominant resident consumer
	 * (the text target) instead of seeing only its own vision/image-gen handles
	 * and never tripping (#8809 AC#1). Summed by role id so it never
	 * double-counts the arbiter's own registry roles (vision/image-gen), which
	 * the arbiter already counts in its resident map.
	 */
	getResidentFootprintMb(): number {
		if (this.ownedEvictableRoleIds.size === 0) return 0;
		let mb = 0;
		for (const role of this.sharedResources.evictableRoles()) {
			if (this.ownedEvictableRoleIds.has(role.id)) {
				mb += role.estimatedResidentMb();
			}
		}
		return mb;
	}

	/** The RAM-pressure monitor. Exposed for diagnostics / tests. */
	getMemoryMonitor(): MemoryMonitor {
		return this.memoryMonitor;
	}

	/** Record `useModel`-style activity so the idle-unload timer stays armed. */
	private markActivity(): void {
		this.lastActivityMs = Date.now();
	}

	/**
	 * Once a model is resident: register the text target as an evictable role,
	 * start the memory monitor, and arm the idle-unload timer. Idempotent.
	 */
	private startBackgroundManagement(): void {
		this.markActivity();
		this.registerResidentRoles();
		if (!this.memoryMonitor.isRunning()) this.memoryMonitor.start();
		this.armIdleUnloadTimer();
	}

	/** Stop the memory monitor + idle timer and deregister evictable roles. */
	private async stopBackgroundManagement(): Promise<void> {
		if (this.idleUnloadTimer) {
			clearInterval(this.idleUnloadTimer);
			this.idleUnloadTimer = null;
		}
		this.memoryMonitor.stop();
		await this.deregisterResidentRoles();
	}

	private registerResidentRoles(): void {
		if (this.textTargetRoleId === null) {
			const role = createEvictableModelRole({
				role: "text-target",
				estimatedMb: this.textTargetEstimatedMb,
				isResident: () => this.hasLoadedModel(),
				evict: async () => {
					// Last thing to go. Evicting the text target = unload it; the
					// next `useModel` lazy-reloads via the runtime handler.
					await this.unload();
				},
			});
			this.sharedResources.acquire(role);
			this.textTargetRoleId = role.id;
			this.ownedEvictableRoleIds.add(role.id);
		}
	}

	private async deregisterResidentRoles(): Promise<void> {
		const ids = [this.textTargetRoleId].filter(
			(id): id is string => id !== null,
		);
		this.textTargetRoleId = null;
		for (const id of ids) {
			this.ownedEvictableRoleIds.delete(id);
			try {
				await this.sharedResources.release(id);
			} catch {
				// Already released (e.g. unload→release ran twice) — fine.
			}
		}
	}

	private armIdleUnloadTimer(): void {
		if (this.idleUnloadTimer) return;
		const idleMs = resolveIdleUnloadMs();
		if (idleMs <= 0) return;
		const timer = setInterval(() => {
			if (!this.hasLoadedModel()) return;
			if (Date.now() - this.lastActivityMs < idleMs) return;
			console.info(
				`[local-inference] No useModel activity for >${Math.round(idleMs / 1000)}s — unloading the active text model to reclaim RAM. It will reload on the next request.`,
			);
			void this.unload().catch((err) => {
				console.warn(
					`[local-inference] idle-unload failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			});
		}, IDLE_UNLOAD_CHECK_INTERVAL_MS);
		timer.unref();
		this.idleUnloadTimer = timer;
	}

	/**
	 * Cap on concurrent speculative voice responses (W9 / J4): derived from
	 * the running server's slot count (each speculative response needs a KV
	 * slot), never more than half of them, floored at 1. The voice
	 * turn-controller reads this before kicking a speculative response.
	 */
	maxConcurrentSpeculativeResponses(): number {
		return resolveMaxConcurrentSpeculativeResponses(this.activeParallel());
	}

	/**
	 * Auto-tune the running server's `--parallel` (J4): when the conversation
	 * high-water mark has outgrown the configured slot count AND there's RAM
	 * headroom for the extra KV slots, resize/restart llama.cpp with the larger
	 * value so new conversations get their own slot instead of thrashing.
	 * Returns `true` when a resize was performed. No-op when the FFI backend
	 * isn't loaded. Best-effort: a failed restart leaves the old `--parallel`
	 * in place and logs.
	 */
	async maybeAutoResizeParallel(): Promise<boolean> {
		if (this.activeBackendId() !== "llama-cpp") return false;
		if (!this.dispatcher.hasLoadedModel()) return false;
		const running = this.dispatcher.parallelSlots();
		const recommended = conversationRegistry.recommendedParallel(running);
		if (recommended <= running) return false;
		// Only grow when free RAM is comfortably above the low-water line —
		// adding KV slots under pressure would just trigger the monitor.
		const sample = await this.memoryMonitor.sample();
		if (this.memoryMonitor.isUnderPressure(sample)) {
			console.warn(
				`[local-inference] Conversation high-water mark wants --parallel ${recommended} (running ${running}) but RAM is tight (free ${sample.effectiveFreeMb} MB) — not resizing. Slot thrashing may occur; consider a smaller tier or more RAM.`,
			);
			return false;
		}
		try {
			const resized = await this.dispatcher.resizeParallel(recommended);
			if (resized) {
				console.info(
					`[local-inference] Resized llama.cpp --parallel ${running} → ${recommended} (conversation high-water mark grew).`,
				);
			}
			return resized;
		} catch (err) {
			console.warn(
				`[local-inference] --parallel resize to ${recommended} failed: ${err instanceof Error ? err.message : String(err)}`,
			);
			return false;
		}
	}

	async available(): Promise<boolean> {
		return this.dispatcher.available();
	}

	currentModelPath(): string | null {
		return this.dispatcher.currentModelPath();
	}

	hasLoadedModel(): boolean {
		return this.dispatcher.hasLoadedModel();
	}

	activeBackendId(): "llama-cpp" | null {
		return this.dispatcher.activeBackendId();
	}

	currentRuntimeLoadConfig(): LocalRuntimeLoadConfig | null {
		if (this.activeBackendId() !== "llama-cpp") return null;
		return this.dispatcher.currentRuntimeLoadConfig();
	}

	private async disposeVoiceBridge(bridge: EngineVoiceBridge): Promise<void> {
		try {
			await bridge.disarm();
			await bridge.settle();
		} finally {
			bridge.dispose();
			if (this.voiceBridge === bridge) this.voiceBridge = null;
		}
	}

	async unload(): Promise<void> {
		// Stop the memory monitor + idle timer and deregister evictable roles
		// before anything else — they reference the model that's about to go.
		await this.stopBackgroundManagement();
		this.activeEliza1Bundle = null;
		this.textTargetEstimatedMb = 0;
		const bridge = this.voiceBridge;
		if (bridge) {
			// Drop voice resources before tearing down text. Disarm is a
			// no-op when the lifecycle is already in voice-off, so this is
			// safe even if the caller never called startVoice().
			await this.disposeVoiceBridge(bridge);
		}
		await this.dispatcher.unload();
	}

	async load(
		modelPath: string,
		resolved?: LocalInferenceLoadArgs,
	): Promise<void> {
		const installed = await listInstalledModels();
		const target = installed.find((m) => m.path === modelPath);
		const modelId = target?.id ?? resolved?.modelId;
		const catalog = modelId ? findCatalogModel(modelId) : undefined;
		this.textTargetEstimatedMb = estimateTextResidentMb(target, catalog);

		// Resolve the active Eliza-1 bundle (root + tier) so voice setup can
		// find the bundle-relative Kokoro TTS root and the per-tier EOT
		// turn-detector revision. An Eliza-1 InstalledModel carries a
		// `bundleRoot` and an `eliza-1-<tier>` id. Reset on every load — a
		// non-Eliza-1 model clears it.
		this.activeEliza1Bundle =
			resolveActiveEliza1Bundle(target) ?? resolveDirectEliza1Bundle(resolved);

		// Resolved args (when provided) carry the merged catalog defaults +
		// per-load overrides from the active-model coordinator. Project them
		// onto the dispatcher-level overrides shape — engine.load is also
		// called directly by legacy callers that pass only a `modelPath`,
		// in which case `resolved` is undefined and we keep the historical
		// behaviour of trusting catalog defaults inside the backend.
		const overrides = resolved ? toBackendLoadOverrides(resolved) : undefined;

		const plan: BackendPlan = {
			modelPath,
			modelId,
			catalog,
			overrides,
		};

		// The local stack is Eliza-1 only: the dispatcher routes every load to the
		// fused libelizainference runtime. A load failure surfaces directly.
		await this.dispatcher.load(plan);
		this.startBackgroundManagement();
	}

	async generate(args: GenerateArgs): Promise<string> {
		this.markActivity();
		const streaming = this.voiceStreamingArgs(args);
		const startedAt = Date.now();
		const text = await this.dispatcher.generate(streaming.args);
		// Decode-throughput routing signal. `generate()` returns only text, so the
		// decoded-token count is approximated from the output length (the exact
		// usage block is only available on the `generateInConversation` path).
		recordDecodeThroughput({
			tokens: estimateDecodeTokens(text),
			elapsedMs: Date.now() - startedAt,
		});
		await streaming.finish(text);
		return text;
	}

	/**
	 * Vision describe via the running llama.cpp mtmd path. Requires the FFI
	 * backend with an mmproj-loaded bundle. The mmproj GGUF must have been
	 * declared by the active catalog tier and present on disk under the
	 * bundle root; if not, the active backend throws.
	 *
	 * No fallback: Florence-2 / Transformers.js was the previous fallback
	 * and has been removed (see VISION_MIGRATION.md).
	 */
	async describeImage(args: {
		bytes: Uint8Array;
		mimeType?: string;
		prompt?: string;
		maxTokens?: number;
		temperature?: number;
		signal?: AbortSignal;
		/** Per-token callback for streaming vision describe (ABI v13). */
		onTextChunk?: (chunk: string) => void | Promise<void>;
		maxTokensPerStep?: number;
	}): Promise<{
		text: string;
		projectorMs?: number;
		decodeMs?: number;
	}> {
		this.markActivity();
		// The dispatcher throws an actionable error if the active backend
		// doesn't implement describeImage (e.g. an FFI backend without mmproj
		// parity). No need for a pre-check.
		return this.dispatcher.describeImage(args);
	}

	/** True when the active server can serve vision describe (mmproj loaded). */
	canDescribeImages(): boolean {
		if (this.activeBackendId() !== "llama-cpp") return false;
		if (!this.dispatcher.hasLoadedModel()) return false;
		return this.dispatcher.currentMmprojPath() !== null;
	}

	/**
	 * Diagnostic snapshot of an in-process JS session pool. Always null on the
	 * FFI runtime — its KV slots live in the native backend (C), not in a JS
	 * session pool. Retained so the API cache-stats panel keeps a stable shape.
	 */
	describeSessionPool(): {
		size: number;
		maxSize: number;
		keys: string[];
	} | null {
		return null;
	}

	/**
	 * Reserve a slot for a long-lived conversation. Subsequent
	 * `generateInConversation` calls reuse the same slot, so the prefix
	 * KV survives across turns regardless of hash collisions with other
	 * concurrent conversations.
	 *
	 * Idempotent for the same (conversationId, modelId): repeated open
	 * calls return the same handle. The runtime side should call this
	 * lazily on the first turn of a conversation and `closeConversation`
	 * when the chat session ends.
	 */
	openConversation(args: {
		conversationId: string;
		modelId: string;
		ttlMs?: number;
	}): ConversationHandle {
		const parallel = this.activeParallel();
		const handle = conversationRegistry.open({
			conversationId: args.conversationId,
			modelId: args.modelId,
			parallel,
			ttlMs: args.ttlMs,
		});
		// Lazy-restore previously-persisted KV state for this conversation.
		// Fire-and-forget — a missing or unreadable file just means the
		// conversation cold-prefills on the next request, which is the
		// pre-restore default. Only meaningful once the FFI backend is loaded.
		if (this.activeBackendId() === "llama-cpp") {
			void this.dispatcher
				.restoreConversationKv(args.conversationId, handle.slotId)
				.catch(() => {
					// KV restore failures must never break the open call — the
					// conversation just doesn't get its old prefix back.
				});
		}
		return handle;
	}

	/**
	 * Run one generation pinned to a previously-opened conversation
	 * handle. Cache key, slot id, and (for optimized llama.cpp) kv-restore are
	 * all owned by the registry — callers don't need to thread them.
	 *
	 * Returns the Anthropic-shape `LocalUsageBlock` alongside the text so
	 * agentic callers can surface cache-hit telemetry without re-scraping
	 * `/metrics` themselves.
	 */
	async generateInConversation(
		handle: ConversationHandle,
		args: Omit<GenerateArgs, "cacheKey">,
	): Promise<{ text: string; usage: LocalUsageBlock; slotId: number }> {
		if (handle.closed) {
			throw new Error(
				`[local-inference] Conversation ${handle.conversationId} has been closed; reopen before generating`,
			);
		}
		this.markActivity();
		handle.lastUsedMs = Date.now();
		const cacheKey = `conv:${handle.conversationId}`;
		const streaming = this.voiceStreamingArgs(args);
		if (this.activeBackendId() === "llama-cpp") {
			const startedAt = Date.now();
			const result: LocalGenerateWithUsageResult =
				await this.dispatcher.generateWithUsage({
					...streaming.args,
					cacheKey,
					slotId: handle.slotId,
				});
			const elapsedMs = Date.now() - startedAt;
			// Decode-throughput routing signal. Prefer the exact decoded-token count
			// from the backend usage block; estimate from the text only if the
			// backend omitted it.
			const decodedTokens = Number(result.usage?.completion_tokens);
			recordDecodeThroughput({
				tokens:
					Number.isFinite(decodedTokens) && decodedTokens > 0
						? decodedTokens
						: estimateDecodeTokens(result.text),
				elapsedMs,
			});
			await streaming.finish(result.text);
			return {
				text: result.text,
				usage: {
					input_tokens: Number(result.usage?.prompt_tokens ?? 0),
					output_tokens: Number(result.usage?.completion_tokens ?? 0),
					cache_creation_input_tokens: 0,
					cache_read_input_tokens: 0,
					...(result.mtpStats
						? {
								mtp_drafted_tokens: result.mtpStats.drafted,
								mtp_accepted_tokens: result.mtpStats.accepted,
								mtp_acceptance_rate:
									result.mtpStats.acceptanceRate ?? undefined,
							}
						: {}),
				},
				slotId: result.slotId ?? handle.slotId,
			};
		}
		// No FFI backend loaded yet: forward via the dispatcher (which throws an
		// actionable "no backend loaded" error) and synthesize a zero-counter
		// usage block for the shape.
		const text = await this.dispatcher.generate({
			...streaming.args,
			cacheKey,
		});
		await streaming.finish(text);
		return {
			text,
			usage: {
				input_tokens: 0,
				output_tokens: 0,
				cache_creation_input_tokens: 0,
				cache_read_input_tokens: 0,
			},
			slotId: handle.slotId,
		};
	}

	/**
	 * KV-prefill a conversation's pinned slot with a known prompt prefix
	 * (system prompt + provider context + tool/action schema block + the
	 * assistant-turn start), before the real request lands. This is item I1 /
	 * C1 of the voice swarm — fire it the moment a message arrives / STT
	 * starts so the response-handler prompt is already in the slot's KV when
	 * the user's tokens are appended.
	 *
	 * `conversationOrId` may be a `ConversationHandle` (preferred — pins to
	 * the handle's slot) or a raw conversation id (a handle is opened on the
	 * fly so the slot derivation matches the real request). Idempotent /
	 * cheap to call repeatedly: `cache_prompt: true` reuses the prefix so a
	 * second call is a no-op forward pass. Only meaningful once the FFI
	 * backend is loaded — returns false otherwise. Returns true when a
	 * pre-warm request was issued.
	 */
	async prewarmConversation(
		conversationOrId: ConversationHandle | string,
		promptPrefix: string,
		opts: { modelId?: string } = {},
	): Promise<boolean> {
		if (this.activeBackendId() !== "llama-cpp") return false;
		this.markActivity();
		let slotId: number;
		let cacheKey: string;
		if (typeof conversationOrId === "string") {
			const modelId =
				opts.modelId ?? this.currentModelPath() ?? "default-local-model";
			const handle =
				this.conversation(conversationOrId, modelId) ??
				this.openConversation({ conversationId: conversationOrId, modelId });
			slotId = handle.slotId;
			cacheKey = `conv:${handle.conversationId}`;
		} else {
			if (conversationOrId.closed) return false;
			slotId = conversationOrId.slotId;
			cacheKey = `conv:${conversationOrId.conversationId}`;
		}
		return this.dispatcher.prewarmConversation(promptPrefix, {
			slotId,
			cacheKey,
		});
	}

	/**
	 * Close + drop a conversation handle. Persists the final KV state to
	 * disk so a later open with the same id can lazy-restore. Idempotent;
	 * closing an unknown id is a no-op.
	 */
	async closeConversation(handle: ConversationHandle): Promise<void> {
		if (handle.closed) return;
		if (this.activeBackendId() === "llama-cpp") {
			// Snapshot KV before deregistering so the slot id is still valid.
			await this.dispatcher
				.persistConversationKv(handle.conversationId, handle.slotId)
				.catch(() => {
					// A failed save must not block close — the slot will fall back
					// to the in-RAM-only path on next open.
				});
		}
		conversationRegistry.close(handle.conversationId, handle.modelId);
	}

	/**
	 * Read-side accessor for the conversation registry. The runtime handler
	 * uses this to look up an existing handle before opening a new one,
	 * avoiding the need to thread a handle through every layer.
	 */
	conversation(
		conversationId: string,
		modelId: string,
	): ConversationHandle | null {
		return conversationRegistry.get(conversationId, modelId);
	}

	/**
	 * Largest concurrent open-conversation count seen this process lifetime.
	 * The auto-tune-parallel path consults this and warns when it exceeds
	 * the running server's slot count.
	 */
	conversationHighWaterMark(): number {
		return conversationRegistry.highWater();
	}

	/**
	 * Recommended `--parallel` value given the current conversation
	 * high-water mark plus a small headroom (max(2, 25%)), never below the
	 * running slot count. Delegates to `ConversationRegistry.recommendedParallel`
	 * so the math lives in one place. When this exceeds `parallelSlots()` the
	 * engine can grow the running server (`maybeAutoResizeParallel`).
	 */
	recommendedParallel(): number {
		return conversationRegistry.recommendedParallel(this.activeParallel());
	}

	/**
	 * Emit a one-line warning when the running `--parallel` slot count is
	 * below the recommended value (high-water mark + headroom). Returns true
	 * when a warning was emitted. No-op when the FFI backend isn't loaded.
	 * The actual resize is `maybeAutoResizeParallel()`
	 * — kept separate from this hot-path check so a `useModel` call never
	 * blocks on (or is interrupted by) a server restart; the auto-resize is
	 * opted into via `ELIZA_LOCAL_AUTO_RESIZE_PARALLEL=1`, in which case this
	 * also kicks one off fire-and-forget.
	 */
	warnIfParallelTooLow(logger?: { warn: (msg: string) => void }): boolean {
		if (this.activeBackendId() !== "llama-cpp") return false;
		const actual = this.dispatcher.parallelSlots();
		const recommended = conversationRegistry.recommendedParallel(actual);
		if (recommended <= actual) return false;
		const message = `[local-inference] Conversation high-water mark (${conversationRegistry.highWater()}) exceeds running --parallel ${actual}. Recommended: ${recommended}. Restart llama.cpp with ELIZA_LOCAL_PARALLEL=${recommended} or higher (or set ELIZA_LOCAL_AUTO_RESIZE_PARALLEL=1) to avoid slot thrashing.`;
		if (logger?.warn) {
			logger.warn(message);
		} else {
			console.warn(message);
		}
		if (process.env.ELIZA_LOCAL_AUTO_RESIZE_PARALLEL === "1") {
			void this.maybeAutoResizeParallel().catch(() => {
				// Best-effort; the warning above already told the operator what to do.
			});
		}
		return true;
	}

	/**
	 * Start the voice-streaming pipeline against an already-activated
	 * Eliza-1 bundle. Per AGENTS.md §3, voice is mandatory for Eliza-1
	 * tiers — every required artifact (speaker preset, fused FFI when
	 * `useFfiBackend`, bundle root) is checked up front and missing
	 * pieces surface as `VoiceStartupError`. There is no silent fallback
	 * to text-only, no log-and-continue.
	 *
	 * Idempotent guard: starting twice without `stopVoice()` between
	 * surfaces a hard error so callers do not double-allocate the
	 * scheduler.
	 */
	startVoice(opts: EngineVoiceBridgeOptions): EngineVoiceBridge {
		if (this.voiceBridge) {
			throw new VoiceStartupError(
				"already-started",
				"[voice] Voice session is already active. Call stopVoice() before starting a new one.",
			);
		}
		if (opts.useFfiBackend && bundleHasAsrModelFiles(opts.bundleRoot)) {
			const blockers = readBundleAsrProvenanceBlockers(opts.bundleRoot);
			if (blockers.length > 0) {
				throw new VoiceStartupError(
					"blocked-asr-provenance",
					`[voice] Cannot start fused local voice: ${blockers.join("; ")}`,
				);
			}
		}
		// Pass the engine's shared-resource registry through so voice ref-counts
		// against the same canonical resources as text and the `MemoryMonitor`
		// sees voice's evictable roles too. The engine's registry is canonical —
		// callers don't get to substitute their own.
		this.voiceBridge = EngineVoiceBridge.start({
			...opts,
			sharedResources: this.sharedResources,
		});
		return this.voiceBridge;
	}

	/**
	 * True when a voice session is currently active on the engine. Callers
	 * use this to decide whether to lazy-start one (e.g. the TTS model
	 * handler in `ensure-local-inference-handler.ts`, which auto-starts a
	 * Kokoro-only bridge on the first TEXT_TO_SPEECH invocation when the
	 * Kokoro artifacts are on disk and no Eliza-1 bundle has activated).
	 */
	hasActiveVoiceBridge(): boolean {
		return this.voiceBridge !== null;
	}

	/**
	 * Arm the voice lifecycle on the active bridge — lazily loads the TTS
	 * mmap region, optional ASR region when present, voice caches, and
	 * voice scheduler nodes via the shared resource registry. Throws
	 * `VoiceLifecycleError` if any
	 * required artifact is unavailable (RAM pressure, mmap fail, kernel
	 * missing) — see `voice/lifecycle.ts` for the structured codes.
	 *
	 * Required before sustained voice use; `startVoice()` only stands up
	 * the cold scheduler and bridge. Splitting setup from arming lets
	 * the engine keep the voice surface in voice-off (no heavy weights
	 * mapped) until the user actually toggles voice on.
	 */
	async armVoice(): Promise<void> {
		const bridge = this.voiceBridge;
		if (!bridge) {
			throw new VoiceStartupError(
				"not-started",
				"[voice] Cannot arm: no voice session active. Call startVoice() first.",
			);
		}
		await bridge.arm();
	}

	/**
	 * Lazily start + arm voice for the active Eliza-1 bundle. Runtime model
	 * handlers use this when visible chat text needs local speech output; direct
	 * engine callers still use `startVoice()` / `armVoice()` explicitly when they
	 * need custom sinks or test backends.
	 */
	async ensureActiveBundleVoiceReady(): Promise<EngineVoiceBridge> {
		if (this.voiceReadyPromise) return this.voiceReadyPromise;
		this.voiceReadyPromise = this.ensureActiveBundleVoiceReadyOnce();
		try {
			return await this.voiceReadyPromise;
		} finally {
			this.voiceReadyPromise = null;
		}
	}

	private async activateAssignedBundleForVoice(): Promise<void> {
		if (this.activeEliza1Bundle || this.dispatcher.hasLoadedModel()) return;
		try {
			const assignments = await readEffectiveAssignments();
			const textModelId = assignments.TEXT_LARGE ?? assignments.TEXT_SMALL;
			if (!textModelId) return;
			const installed = await listInstalledModels();
			const target = installed.find((m) => m.id === textModelId);
			if (!target) return;
			logger.info(
				`[voice] Pre-loading text model ${textModelId} to activate Eliza-1 bundle for voice`,
			);
			await this.load(target.path);
		} catch (err) {
			logger.warn(
				`[voice] Failed to pre-load text model for bundle activation: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}
	}

	private localAsrBlockersForBundle(bundle: ActiveEliza1Bundle): string[] {
		const blockers: string[] = [];
		if (!bundleHasAsrModelFiles(bundle.root)) {
			blockers.push(
				`files.asr: no ASR model artifacts are staged under ${path.join(
					bundle.root,
					"asr",
				)}`,
			);
		}
		blockers.push(...readBundleAsrProvenanceBlockers(bundle.root));
		return blockers;
	}

	private assertLocalAsrEligible(bundle: ActiveEliza1Bundle): void {
		const blockers = this.localAsrBlockersForBundle(bundle);
		if (blockers.length === 0) return;
		const code = blockers.some((blocker) => blocker.startsWith("files.asr:"))
			? "missing-asr-model"
			: "blocked-asr-provenance";
		throw new VoiceStartupError(
			code,
			`[voice] Cannot start local Gemma ASR for ${bundle.tierId}: ${blockers.join("; ")}`,
		);
	}

	private async assignedLocalAsrBundle(): Promise<ActiveEliza1Bundle | null> {
		if (this.activeEliza1Bundle) return this.activeEliza1Bundle;
		const assignments = await readEffectiveAssignments();
		const modelId =
			assignments.TRANSCRIPTION ??
			assignments.TEXT_LARGE ??
			assignments.TEXT_SMALL;
		if (!modelId) return null;
		const installed = await listInstalledModels();
		const target = installed.find((m) => m.id === modelId);
		return resolveActiveEliza1Bundle(target);
	}

	async canTranscribeLocally(): Promise<boolean> {
		try {
			const bridge = this.voiceBridge;
			if (bridge?.asrAvailable) return true;
			const bundle = await this.assignedLocalAsrBundle();
			return (
				bundle !== null && this.localAsrBlockersForBundle(bundle).length === 0
			);
		} catch (err) {
			logger.warn(
				`[voice] Local ASR readiness check failed: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
			return false;
		}
	}

	async ensureActiveBundleAsrReady(): Promise<EngineVoiceBridge> {
		if (this.asrReadyPromise) return this.asrReadyPromise;
		this.asrReadyPromise = this.ensureActiveBundleAsrReadyOnce();
		try {
			return await this.asrReadyPromise;
		} finally {
			this.asrReadyPromise = null;
		}
	}

	private async ensureActiveBundleAsrReadyOnce(): Promise<EngineVoiceBridge> {
		await this.activateAssignedBundleForVoice();
		const bundle = this.activeEliza1Bundle;
		if (!bundle) {
			throw new VoiceStartupError(
				"missing-bundle-root",
				"[voice] Cannot start local ASR: no active Eliza-1 bundle is loaded. Install and activate a Gemma ASR-capable Eliza-1 bundle.",
			);
		}
		this.assertLocalAsrEligible(bundle);

		let bridge = this.voiceBridge;
		if (bridge?.asrAvailable) {
			await bridge.arm();
			return bridge;
		}
		if (bridge) {
			await this.disposeVoiceBridge(bridge);
		}

		const bundleKokoroRoot = path.join(bundle.root, "tts", "kokoro");
		const kokoro =
			resolveKokoroEngineConfig(bundleKokoroRoot) ??
			resolveKokoroEngineConfig();
		const kokoroOverrides = kokoro
			? {
					ttsBackendOverride: createKokoroTtsBackend(kokoro, {
						bundleRoot: bundle.root,
					}),
					speakerPresetOverride: createKokoroSpeakerPreset(kokoro),
				}
			: {};
		// Light up speaker attribution on the speak-back loop (#12257): thread
		// the one shared VoiceProfileStore in so the engine-bridge attribution
		// gate opens. The store is shared with Pipeline A (live frames) so both
		// paths resolve the same identities. Absent fused speaker artifacts
		// degrade to attribution-off with a single warn (engine-bridge gate).
		const profileStore = await getSharedVoiceProfileStore();
		bridge = this.startVoice({
			bundleRoot: bundle.root,
			useFfiBackend: true,
			profileStore,
			...kokoroOverrides,
		});
		await bridge.arm();
		return bridge;
	}

	private async ensureActiveBundleVoiceReadyOnce(): Promise<EngineVoiceBridge> {
		let bridge = this.voiceBridge;
		if (!bridge) {
			// If no text model is loaded yet, try to load the assigned one so
			// the Eliza-1 bundle activates before voice needs it. This covers
			// the boot-time warmup race where TTS fires before any text request.
			await this.activateAssignedBundleForVoice();
			const bundle = this.activeEliza1Bundle;
			// Speaker attribution is wired on the fused ASR path
			// (`ensureActiveBundleAsrReadyOnce`), not here: both startVoice calls
			// below take the Kokoro-only TTS path (`useFfiBackend: false`), which
			// has no fused `libelizainference` handle and therefore no speaker
			// runtime. Threading a profileStore here would be inert — the
			// engine-bridge gate needs the fused handle to attribute (#12257).
			if (bundle) {
				const bundleKokoroRoot = path.join(bundle.root, "tts", "kokoro");
				const kokoro =
					resolveKokoroEngineConfig(bundleKokoroRoot) ??
					resolveKokoroEngineConfig();
				const mode = readVoiceBackendModeFromEnv();
				const decision = selectVoiceBackend({
					mode,
					mobile: isMobilePlatform(),
					kokoroAvailable: kokoro !== null,
				});
				logger.info(
					`[voice] Selected ${decision.backend} backend for ${bundle.tierId}: ${decision.reason}`,
				);
				if (!kokoro) {
					throw new VoiceStartupError(
						"missing-bundle-root",
						"[voice] Kokoro was selected but its model artifacts are not staged under <stateDir>/local-inference/models/kokoro/.",
					);
				}
				bridge = this.startVoice({
					bundleRoot: "",
					useFfiBackend: false,
					kokoroOnly: kokoro,
				});
			} else {
				// No Eliza-1 bundle. Fall back to the Kokoro-only path when its
				// artifacts are staged. No silent degrade: when both are absent
				// the error names both staging options.
				const kokoro = resolveKokoroEngineConfig();
				if (!kokoro) {
					throw new VoiceStartupError(
						"missing-bundle-root",
						"[voice] Cannot start local voice: no active Eliza-1 bundle is loaded and no Kokoro artifacts are staged under <stateDir>/local-inference/models/kokoro/. Install an Eliza-1 bundle, or stage the Kokoro ONNX + at least one voice .bin to enable local TTS.",
					);
				}
				bridge = this.startVoice({
					bundleRoot: "",
					useFfiBackend: false,
					kokoroOnly: kokoro,
				});
			}
		}
		await bridge.arm();
		return bridge;
	}

	/**
	 * Assemble + run the full live voice loop on top of `startVoice()` /
	 * `armVoice()`: mic → (`pipeMicToRingBuffer` + `VadDetector.pushFrame`)
	 * per frame → `StreamingTranscriber.feed` (VAD-gated) → `VoiceTurnController`
	 * (speculative-on-pause, abort-on-resume, finalize/promote, barge-in) →
	 * `VoiceScheduler` → TTS → audio sink.
	 *
	 * Gated behind a complete real backend chain (AGENTS.md §3 — no silent
	 * backend-mode "voice"):
	 *   - a `MicSource` (caller-supplied, or `DesktopMicSource` under Electrobun),
	 *   - a Silero v5 GGML VAD (caller-supplied detector, or `createSileroVadDetector()` — runs through libelizainference's native VAD ABI),
	 *   - a working ASR (the bridge's `createStreamingTranscriber` throws
	 *     `AsrUnavailableError` when the fused decoder is unavailable — the
	 *     fused build is the sole on-device ASR runtime),
	 *   - a real TTS backend on the bridge (the `StubTtsBackend`
	 *     is rejected — it emits zeros).
	 * Any missing piece fails loudly with the specific component named.
	 *
	 * `prewarm` defaults to `this.prewarmConversation(roomId, "")` (best-effort
	 * KV-prefill); a caller with the response-handler stable prefix (W6) should
	 * pass its own. `generate` is required — it builds the message and runs the
	 * runtime turn (streaming `replyText` into TTS via this engine's
	 * `generate({ onTextChunk })`, which routes through the voice scheduler).
	 */
	async startVoiceSession(opts: {
		roomId: string;
		/** Mic source. Defaults to a `DesktopMicSource` (Electrobun). */
		micSource?: import("./voice/types").MicSource;
		/** VAD detector. Defaults to `createSileroVadDetector()`. */
		vad?: import("./voice/vad").VadDetector;
		/** Run one turn: build the message + stream `replyText` into TTS. Required. */
		generate: (
			request: import("./voice/turn-controller").VoiceGenerateRequest,
		) => Promise<import("./voice/turn-controller").VoiceTurnOutcome>;
		/**
		 * Semantic turn detector layered with VAD/STT. Defaults to the local
		 * LiveKit ONNX model when installed, otherwise the deterministic heuristic.
		 * Pass `false` only for tests/manual troubleshooting.
		 */
		turnDetector?: import("./voice/eot-classifier").EotClassifier | false;
		/** Optional local LiveKit turn-detector directory override. */
		turnDetectorModelDir?: string;
		/**
		 * Use the already-loaded eliza-1 text model as the EOT classifier — see
		 * `voice/eliza1-eot-scorer.ts`. When set, the runtime skips the
		 * separate LiveKit/Turnsense ONNX and reads P(`<end_of_turn>`) directly
		 * off the live model.
		 *
		 * `"auto"` (default): use eliza-1 EOT when `ELIZA_VOICE_EOT_BACKEND=eliza-1`
		 * or when no bundled LiveKit ONNX is resolvable; otherwise fall
		 * through to the existing LiveKit path. `true` forces eliza-1 EOT
		 * (throws if the active backend is not in-process). `false` forces
		 * the historical LiveKit path.
		 */
		useEliza1Eot?: boolean | "auto";
		/**
		 * Optional path to a fine-tuned EOT LoRA adapter to layer on top of
		 * the drafter at scoring time. The training recipe lives in
		 * `packages/training/scripts/turn_detector/`.
		 */
		eliza1EotLoraPath?: string;
		/** KV-prefill / response-handler-prefix prewarm. Defaults to `prewarmConversation`. */
		prewarm?: (roomId: string) => void | Promise<void>;
		speculatePauseMs?: number;
		events?: import("./voice/turn-controller").VoiceTurnControllerEvents;
		/**
		 * Opt-in openWakeWord hotword gate (local mode only — the
		 * local-inference engine never runs in cloud mode, and the connector
		 * UI hides this surface there per AGENTS.md §5 hide-not-disable).
		 * Disabled by default: voice mode works push-to-talk / VAD-gated
		 * without it. When `enabled` and the bundle ships the openWakeWord
		 * graphs, mic frames are also fanned into an `OpenWakeWordDetector`;
		 * each fresh detection prewarms the conversation and calls `onWake`
		 * (the same place a push-to-talk press would arm a listening window).
		 * Silently inert when the bundle has no wake-word model.
		 */
		wakeWord?: {
			enabled: boolean;
			/** Wake phrase head name (defaults to the bundle's `hey-eliza`). */
			head?: string;
			/** P(wake) firing threshold (openWakeWord default ~0.5). */
			threshold?: number;
			/** Called once per detected utterance (refractory-debounced). */
			onWake?: () => void;
			/**
			 * Forward each fused-wake stage to the renderer (#10351). The host
			 * wires this to its transport, where `emitFusedWake` dispatches the
			 * `eliza:fused-wake` window event so `useWakeController` activates the
			 * bottom bar and starts a turn. A native head-fire maps to the
			 * terminal `head-fired` stage with the firing confidence.
			 */
			onFusedWake?: import("./voice/fused-wake-bridge").FusedWakeSink;
		};
		/**
		 * Runtime reference for cancellation coordination (W3-9 F1).
		 *
		 * @deprecated G5.d: pass `runtime` to `startVoice()` (the
		 * `EngineVoiceBridgeOptions`) instead. The bridge is the canonical
		 * owner of `VoiceCancellationCoordinator` + `OptimisticGenerationPolicy`,
		 * and `startVoiceSession()` now delegates to the bridge's coordinator.
		 * When this field is supplied here without a matching bridge-level
		 * runtime, `startVoiceSession()` logs once and ignores it — the
		 * canonical wiring lives on the bridge.
		 */
		runtime?: CoordinatorRuntime;
	}): Promise<import("./voice/turn-controller").VoiceTurnController> {
		const bridge = this.requireVoiceBridge("start a voice session");
		if (bridge.lifecycle.current().kind !== "voice-on") {
			throw new VoiceStartupError(
				"not-started",
				"[voice] Cannot start a voice session: voice lifecycle is not armed. Call armVoice() first.",
			);
		}
		const backendId = (bridge.backend as { id?: string }).id;
		if (backendId === "stub") {
			throw new VoiceStartupError(
				"missing-fused-build",
				"[voice] Cannot start a live voice session on the StubTtsBackend (it emits silence). Start the bridge with useFfiBackend:true or a real backendOverride.",
			);
		}

		const [
			{ DesktopMicSource, pipeMicToRingBuffer },
			vadMod,
			{ VoiceTurnController },
			{ InMemoryAudioSink },
			eotMod,
			eotGgmlMod,
		] = await Promise.all([
			import("./voice/mic-source"),
			import("./voice/vad"),
			import("./voice/turn-controller"),
			import("./voice/ring-buffer"),
			import("./voice/eot-classifier"),
			import("./voice/eot-classifier-ggml"),
		]);

		const micSource = opts.micSource ?? new DesktopMicSource();
		const vad =
			opts.vad ??
			(await vadMod.createSileroVadDetector({
				bundleRoot: bridge.bundlePath(),
				ffi: bridge.ffi,
				ctx: bridge.ffi
					? () => {
							const ctx = bridge.ffiCtx;
							if (ctx === null) {
								throw new VoiceStartupError(
									"missing-ffi",
									"[voice] Cannot initialize native VAD: fused FFI context is not loaded.",
								);
							}
							return ctx;
						}
					: undefined,
			}));

		// ASR — throws `AsrUnavailableError` when the fused decoder is
		// unavailable (the fused build is the sole on-device ASR runtime). Gated
		// on the VAD so silent frames aren't decoded.
		const transcriber = bridge.createStreamingTranscriber({ vad });
		// Voice Wave 2 (2026-05-14): tier-aware turn-detector revision selection.
		// `2b` (the entry tier) ships the ~66 MB EN-only SmolLM2-135M distill
		// (`v1.2.2-en`); `4b`+ ship the ~396 MB multilingual pruned
		// semantic detector (`v0.4.1-intl`). The on-disk layout is per-tier so the
		// bundle dir already contains the matching ONNX — `revision` here is a
		// telemetry label (the upstream tag the bundle was staged from). When no
		// active bundle is resolvable we omit the hint and the resolver falls
		// back to the upstream-default filename order.
		const activeTier = this.activeEliza1Bundle?.tierId;
		const tierRevision = activeTier
			? eotMod.turnDetectorRevisionForTier(activeTier)
			: undefined;
		const eliza1EotSelected = resolveEliza1EotSelection(
			opts.useEliza1Eot,
			opts.eliza1EotLoraPath,
		);
		const eliza1EotClassifier =
			eliza1EotSelected !== "off" && opts.turnDetector !== false
				? this.tryBuildEliza1EotClassifier(
						eliza1EotSelected,
						opts.eliza1EotLoraPath,
					)
				: null;
		if (eliza1EotSelected === "force" && !eliza1EotClassifier) {
			throw new VoiceStartupError(
				"missing-turn-detector",
				"[voice] useEliza1Eot:true requested but the in-process Eliza-1 EOT scorer is unavailable on the FFI runtime — use the GGUF turn detector by setting useEliza1Eot:false.",
			);
		}
		// Fused end-of-turn scorer (ABI v11): the model-based turn detector now
		// runs in-process through libelizainference — a composite of the fused
		// semantic scorer (P(<end_of_turn>) over the loaded text model) and the
		// heuristic syntactic co-signal. Built only when the loaded fused build
		// wires the v11 EOT symbol; null on a pre-v11 library, in which case the
		// resolver falls through to the heuristic-only classifier.
		const bridgeFfi = bridge.ffi;
		const fusedEot =
			opts.turnDetector === false || !bridgeFfi
				? null
				: eotMod.tryBuildFusedEotClassifier({
						ffi: bridgeFfi,
						getContext: () => {
							const ctx = bridge.ffiCtx;
							if (ctx === null) {
								throw new VoiceStartupError(
									"missing-ffi",
									"[voice] Cannot initialize fused EOT scorer: FFI context is not loaded.",
								);
							}
							return ctx;
						},
					});
		// Resolver order: prefer the fused composite EOT (v11), then the legacy
		// in-process Eliza-1 scorer + GGUF turn detector (both null on the FFI
		// runtime — they needed node-llama controlledEvaluate), then the
		// heuristic. The ONNX path was removed.
		const ggmlTurnDetector =
			opts.turnDetector === false || fusedEot
				? undefined
				: await eotGgmlMod
						.createBundledLiveKitGgmlTurnDetector({
							...(opts.turnDetectorModelDir
								? { modelDir: opts.turnDetectorModelDir }
								: {}),
							...(tierRevision ? { revision: tierRevision } : {}),
						})
						.catch(() => null);
		const turnDetector =
			opts.turnDetector === false
				? undefined
				: (opts.turnDetector ??
					fusedEot ??
					eliza1EotClassifier ??
					ggmlTurnDetector ??
					new eotMod.HeuristicEotClassifier());
		if (turnDetector) {
			try {
				// Warm one short pass while the session is arming, so the first
				// real user pause does not pay model-load latency.
				await turnDetector.score("yes");
			} catch (err) {
				throw new VoiceStartupError(
					"missing-turn-detector",
					`[voice] Cannot initialize semantic turn detector: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}

		// G5.d (Gauntlet cleanup): delegate to the bridge's canonical
		// VoiceCancellationCoordinator. The bridge is the single owner — it
		// constructs the coordinator + policy at `EngineVoiceBridge.start()`
		// when `runtime` is passed in `EngineVoiceBridgeOptions` (see
		// `engine-bridge.ts buildCancellationWiring`). Earlier C0-F wiring
		// built a separate coordinator here; that path is removed.
		//
		// Back-compat: when callers still pass `opts.runtime` to
		// `startVoiceSession()` but did not pass `runtime` to `startVoice()`,
		// the bridge has no coordinator. We log once and proceed — the
		// caller-supplied runtime is ignored because the bridge owns the
		// FFI context that the coordinator targets.
		if (opts.runtime && !bridge.cancellationCoordinatorOrNull()) {
			console.warn(
				"[voice] startVoiceSession({ runtime }) supplied but the bridge has no canonical cancellation coordinator — pass `runtime` to startVoice() instead. Ignoring the session-level runtime.",
			);
		}

		const controller = new VoiceTurnController(
			{
				vad,
				transcriber,
				scheduler: bridge.scheduler,
				...(turnDetector ? { turnDetector } : {}),
				prewarm:
					opts.prewarm ??
					((roomId: string) => {
						void this.prewarmConversation(roomId, "");
					}),
				playFirstAudioFiller: () => this.playFirstAudioFiller(),
				generate: opts.generate,
			},
			{
				roomId: opts.roomId,
				...(opts.speculatePauseMs !== undefined
					? { speculatePauseMs: opts.speculatePauseMs }
					: {}),
			},
			opts.events ?? {},
		);

		// Bind the bridge's BargeInController into the bridge's canonical
		// coordinator (G5.d). No-op when the bridge was constructed without a
		// runtime — returns a no-op unsubscribe so the teardown path stays
		// branchless.
		const unsubCoordinator = bridge.bindBargeInControllerForRoom(opts.roomId);

		// Mic → ring buffer (the buffer the ASR / instrumentation can read from)
		// + per-frame fan-out to the VAD and the streaming transcriber.
		const { unsubscribe: stopMicRing } = pipeMicToRingBuffer(
			micSource,
			new InMemoryAudioSink(),
		);
		// Optional openWakeWord hotword gate (opt-in, local mode). Resolved
		// against the active bundle; absent graphs → silently no wake word.
		let wakeWord: import("./voice/wake-word").OpenWakeWordDetector | null =
			null;
		let feedWakeFrame: ((pcm: Float32Array) => void) | null = null;
		if (opts.wakeWord?.enabled) {
			const {
				isPlaceholderWakeWordHead,
				loadBundledWakeWordModel,
				OPENWAKEWORD_DEFAULT_HEAD,
				OpenWakeWordDetector,
			} = await import("./voice/wake-word");
			const { bridgeDetectorToFusedWake } = await import(
				"./voice/fused-wake-bridge"
			);
			const headName = opts.wakeWord.head?.trim() || OPENWAKEWORD_DEFAULT_HEAD;
			if (isPlaceholderWakeWordHead(headName)) {
				console.warn(
					`[voice] wake word head '${headName}' is a PLACEHOLDER (the upstream openWakeWord "hey jarvis" head, renamed) — it fires on "hey jarvis", not the Eliza-1 wake phrase. Experimental, opt-in only; see packages/inference/reports/porting/2026-05-11/wakeword-head-plan.md.`,
				);
			}
			if (!bridge.ffi) {
				throw new VoiceStartupError(
					"missing-ffi",
					"[voice] Cannot initialize wake-word detector: fused libelizainference FFI is not loaded. Wake-word detection requires the native GGUF runtime (eliza_inference_wakeword_* symbols).",
				);
			}
			const ffiCtxResolver = () => {
				const ctx = bridge.ffiCtx;
				if (ctx === null) {
					throw new VoiceStartupError(
						"missing-ffi",
						"[voice] Cannot initialize wake-word detector: fused FFI context is not loaded.",
					);
				}
				return ctx;
			};
			const model = await loadBundledWakeWordModel({
				ffi: bridge.ffi,
				ctx: ffiCtxResolver,
				bundleRoot: bridge.bundlePath(),
				...(opts.wakeWord.head ? { head: opts.wakeWord.head } : {}),
			});
			if (model) {
				const forwardFusedWake = opts.wakeWord.onFusedWake
					? bridgeDetectorToFusedWake(opts.wakeWord.onFusedWake)
					: null;
				const detector = new OpenWakeWordDetector({
					model,
					...(opts.wakeWord.threshold !== undefined
						? { config: { threshold: opts.wakeWord.threshold } }
						: {}),
					onWake: (info) => {
						void this.prewarmConversation(opts.roomId, "");
						opts.wakeWord?.onWake?.();
						// Bridge the real native firing to the renderer (#10351):
						// the bar activates and a turn starts via useWakeController.
						forwardFusedWake?.(info);
					},
				});
				wakeWord = detector;
				// The mic frame size need not match the openWakeWord frame size
				// (1280 samples = 80 ms @ 16 kHz); re-buffer into exact frames.
				const need = model.frameSamples;
				let acc = new Float32Array(0);
				feedWakeFrame = (pcm: Float32Array) => {
					const merged = new Float32Array(acc.length + pcm.length);
					merged.set(acc);
					merged.set(pcm, acc.length);
					let off = 0;
					while (merged.length - off >= need) {
						const slice = merged.slice(off, off + need);
						off += need;
						void detector.pushFrame(slice);
					}
					acc = merged.slice(off);
				};
			} else {
				console.info(
					"[voice] wake word requested but no openWakeWord model in this bundle — running VAD-gated only",
				);
			}
		}

		const unsubFrame = micSource.onFrame((frame) => {
			// The VAD forward pass is serialized internally; fire-and-forget so a
			// slow frame doesn't backpressure the mic (the VAD records overruns).
			void vad.pushFrame(frame);
			transcriber.feed(frame);
			feedWakeFrame?.(frame.pcm);
		});

		controller.start();
		await micSource.start();

		// Single teardown knob: stopping the controller stops the mic chain too.
		const origStop = controller.stop.bind(controller);
		controller.stop = () => {
			origStop();
			unsubFrame();
			stopMicRing();
			void micSource.stop();
			transcriber.dispose();
			wakeWord?.reset();
			// G5.d: tear down only the per-room barge-in binding. The bridge
			// owns the coordinator lifecycle and disposes it in
			// `EngineVoiceBridge.dispose()` — we must not dispose it here or
			// we would cancel armed tokens for other concurrent rooms.
			unsubCoordinator();
		};
		return controller;
	}

	/**
	 * Disarm the voice lifecycle — drains the ring buffer, settles the
	 * scheduler, and drops TTS/ASR weights from RAM via `evictPages()`
	 * (madvise / VirtualUnlock equivalent — see voice/engine-bridge.ts).
	 * No-op when not armed.
	 */
	async disarmVoice(): Promise<void> {
		const bridge = this.voiceBridge;
		if (!bridge) return;
		await bridge.disarm();
	}

	/**
	 * Tear down the active voice bridge. Idempotent; calling when no
	 * voice session is active is a no-op. Disarms the lifecycle first
	 * (drops voice weights via `evictPages`), then settles any in-flight
	 * TTS so audio committed to the ring buffer surfaces to the sink
	 * before the bridge is dropped.
	 */
	async stopVoice(): Promise<void> {
		const bridge = this.voiceBridge;
		if (!bridge) return;
		try {
			await bridge.disarm();
			await bridge.settle();
		} finally {
			bridge.dispose();
			if (this.voiceBridge === bridge) this.voiceBridge = null;
		}
	}

	async synthesizeSpeech(
		text: string,
		signal?: AbortSignal,
	): Promise<Uint8Array> {
		this.markActivity();
		const bridge = this.requireVoiceBridge("synthesize speech");
		if ((bridge.backend as { id?: string }).id === "stub") {
			throw new VoiceStartupError(
				"missing-fused-build",
				"[voice] Cannot synthesize speech with StubTtsBackend (it emits silence). Start voice with useFfiBackend:true or inject a real backend.",
			);
		}
		return bridge.synthesizeTextToWav(text, signal);
	}

	async prewarmVoicePhrases(
		texts: ReadonlyArray<string>,
		opts: { concurrency?: number } = {},
	): Promise<{ warmed: number; cached: number }> {
		return this.requireVoiceBridge("prewarm voice phrases").prewarmPhrases(
			texts,
			opts,
		);
	}

	/**
	 * Idle-time auto-prewarm: synthesize the canonical common-phrase seed so
	 * the phrase cache is warm before the next turn. No-op unless a real TTS
	 * backend is present and voice is armed. Callers (the voice bridge /
	 * connector) invoke this when the loop is idle.
	 */
	async prewarmIdleVoicePhrases(
		opts: { concurrency?: number } = {},
	): Promise<{ warmed: number; cached: number }> {
		return this.requireVoiceBridge(
			"prewarm idle voice phrases",
		).prewarmIdlePhrases(opts);
	}

	/**
	 * Play the first-audio filler (a short cached acknowledgement) — the seam
	 * W9's turn controller calls the instant VAD fires `speech-start` to mask
	 * first-token latency. Returns the played filler text, or `null` if none
	 * was played. No-op without a real TTS backend / armed voice.
	 */
	playFirstAudioFiller(): string | null {
		return this.requireVoiceBridge(
			"play first-audio filler",
		).playFirstAudioFiller();
	}

	async transcribePcm(
		args: TranscriptionAudio,
		signal?: AbortSignal,
		onPartial?: (delta: string) => void,
	): Promise<string> {
		this.markActivity();
		if (signal?.aborted) {
			throw signal.reason instanceof Error
				? signal.reason
				: new DOMException("Aborted", "AbortError");
		}
		const transcript = await this.requireVoiceBridge(
			"transcribe audio",
		).transcribePcm(args, signal, onPartial);
		if (signal?.aborted) {
			throw signal.reason instanceof Error
				? signal.reason
				: new DOMException("Aborted", "AbortError");
		}
		return transcript;
	}

	/** Transcribe + per-word timings (fused ASR v12) through the voice bridge. */
	async transcribePcmTimed(
		args: TranscriptionAudio,
		signal?: AbortSignal,
	): Promise<{ text: string; words: AsrWordTiming[] }> {
		this.markActivity();
		if (signal?.aborted) {
			throw signal.reason instanceof Error
				? signal.reason
				: new DOMException("Aborted", "AbortError");
		}
		return this.requireVoiceBridge("transcribe audio").transcribePcmTimed(
			args,
			signal,
		);
	}

	/**
	 * Run one fused mic→speech voice turn through the overlapped
	 * `VoicePipeline`: ASR → {MTP drafts ∥ target verifies} → phrase
	 * chunker → OmniVoice → PCM ring buffer, with rollback-on-reject and
	 * barge-in cancel. Requires `startVoice()` + `armVoice()` first.
	 *
	 * `opts.textRunner` lets a host that runs its own text engine in-process
	 * (the iOS/Android FFI path or the desktop FFI runtime) supply its own
	 * {@link MtpTextRunner}. When omitted, the active local dispatcher is
	 * used.
	 *
	 * Production caller: the on-device device bridge, via `runDeviceVoiceTurn`
	 * (`adapters/capacitor-llama/voice-turn.ts`), which wraps the loaded
	 * `CapacitorLlamaContext` in an `MtpTextRunner` and passes it here so the
	 * draft/verify loop runs on the on-device text model. The native mic
	 * capture hands `runDeviceVoiceTurn` the PCM; everything downstream is
	 * in-process JS + the fused FFI (no HTTP, no second voice path).
	 *
	 * Resolves with the turn's exit reason (`done` / `token-cap` /
	 * `cancelled`). A missing ASR region in voice mode surfaces as a
	 * `VoiceStartupError` — no silent cloud fallback (AGENTS.md §3).
	 */
	async runVoiceTurn(
		audio: TranscriptionAudio,
		opts: {
			maxDraftTokens?: number;
			maxGeneratedTokens?: number;
			events?: VoicePipelineEvents;
			/**
			 * In-process text runner for the mobile FFI path. Must implement the
			 * same `MtpTextRunner` contract (`hasDrafter()` +
			 * `generateWithVerifierEvents()`); the AOSP/Capacitor bridge wraps
			 * its libllama-context-backed speculative loop in one.
			 */
			textRunner?: MtpTextRunner;
		} = {},
	): Promise<"done" | "token-cap" | "cancelled"> {
		this.markActivity();
		const bridge = this.requireVoiceBridge("run a voice turn");
		return bridge.runVoiceTurn(
			audio,
			opts.textRunner ?? mtpTextRunner(this.dispatcher),
			{
				maxDraftTokens: opts.maxDraftTokens ?? DEFAULT_VOICE_MAX_DRAFT_TOKENS,
				maxGeneratedTokens: opts.maxGeneratedTokens,
			},
			opts.events,
		);
	}

	/**
	 * Active voice bridge, or null when voice mode is not running.
	 * Callers (router, UI, agent runtime) read this to decide whether to
	 * forward verifier events. Voice is mandatory for Eliza-1 tiers but
	 * the bridge is still created lazily — `startVoice()` MUST be called
	 * before `voice()` returns non-null.
	 */
	voice(): EngineVoiceBridge | null {
		return this.voiceBridge;
	}

	private requireVoiceBridge(action: string): EngineVoiceBridge {
		const bridge = this.voiceBridge;
		if (!bridge) {
			throw new VoiceStartupError(
				"not-started",
				`[voice] Cannot ${action}: no voice session active. Call startVoice() and armVoice() first.`,
			);
		}
		return bridge;
	}

	private voiceStreamingArgs<T extends Omit<GenerateArgs, "cacheKey">>(
		args: T,
	): {
		args: T;
		finish: (finalText: string) => Promise<void>;
	} {
		const bridge = this.voiceBridge;
		const voiceOn = bridge?.lifecycle.current().kind === "voice-on";
		const structuredVoiceFields =
			args.streamStructured === true
				? resolveVoiceSkeletonStreamFields(args.responseSkeleton)
				: [];
		const hasShouldRespondGate =
			args.streamStructured === true &&
			skeletonHasFreeStringKey(args.responseSkeleton, "shouldRespond");
		const extractorStreamFields =
			hasShouldRespondGate && !structuredVoiceFields.includes("shouldRespond")
				? ["shouldRespond", ...structuredVoiceFields]
				: structuredVoiceFields;
		const userVisibleVoice =
			args.voiceOutput === "user-visible" ||
			(args.voiceOutput === undefined &&
				(typeof args.onTextChunk === "function" ||
					structuredVoiceFields.length > 0));
		if (!voiceOn || !bridge || !userVisibleVoice) {
			return {
				args,
				finish: async () => {},
			};
		}

		// Barge-in → LLM/drafter abort. A `hard-stop` from the scheduler's
		// barge-in controller (ASR-confirmed words, or `triggerBargeIn()`)
		// aborts this controller; we hand its signal to `dispatcher.generate`
		// so generation stops at the next kernel boundary — not just TTS
		// (AGENTS.md §4 / brief item 2). Composed with the caller's signal so
		// an external cancel still works.
		const bargeAbort = new AbortController();
		const detachBarge = bridge.scheduler.bargeIn.onSignal((signal) => {
			if (signal.type === "hard-stop" && !bargeAbort.signal.aborted) {
				bargeAbort.abort();
			}
		});
		const callerSignal = args.signal;
		if (callerSignal) {
			if (callerSignal.aborted) bargeAbort.abort();
			else
				callerSignal.addEventListener(
					"abort",
					() => {
						if (!bargeAbort.signal.aborted) bargeAbort.abort();
					},
					{ once: true },
				);
		}

		let nextIndex = 0;
		let streamedAny = false;
		let verifierHandled = false;
		const callerOnTextChunk = args.onTextChunk;
		const callerOnVerifierEvent = args.onVerifierEvent;
		let structuredVoicePush = Promise.resolve();
		let shouldRespondText = "";
		let shouldRespondAllowsVoice: boolean | null = hasShouldRespondGate
			? null
			: true;
		const pendingStructuredReplyChunks: string[] = [];
		const pushStructuredVoiceChunk = (chunk: string) => {
			streamedAny = true;
			const token: TextToken = { index: nextIndex++, text: chunk };
			structuredVoicePush = structuredVoicePush.then(() =>
				bridge.pushAcceptedToken(token),
			);
		};
		const structuredVoiceExtractor =
			structuredVoiceFields.length > 0 && args.responseSkeleton
				? new ResponseSkeletonStreamExtractor({
						skeleton: args.responseSkeleton,
						streamFields: extractorStreamFields,
						abortSignal: bargeAbort.signal,
						onChunk: (chunk: string, field?: string) => {
							if (chunk.length === 0) return;
							if (field === "shouldRespond") {
								shouldRespondText += chunk;
								const normalized = shouldRespondText
									.trim()
									.toUpperCase()
									.replace(/^[^A-Z]+/, "");
								if (
									normalized.startsWith("IG") ||
									normalized.startsWith("ST")
								) {
									shouldRespondAllowsVoice = false;
									pendingStructuredReplyChunks.length = 0;
								} else if (normalized.startsWith("RE")) {
									shouldRespondAllowsVoice = true;
									for (const pending of pendingStructuredReplyChunks.splice(
										0,
									)) {
										pushStructuredVoiceChunk(pending);
									}
								}
								return;
							}
							if (hasShouldRespondGate) {
								if (shouldRespondAllowsVoice === false) return;
								if (shouldRespondAllowsVoice !== true) {
									pendingStructuredReplyChunks.push(chunk);
									return;
								}
							}
							pushStructuredVoiceChunk(chunk);
						},
					})
				: null;
		const wrapped = {
			...args,
			signal: bargeAbort.signal,
			onVerifierEvent: async (event: VerifierStreamEvent) => {
				if (structuredVoiceExtractor) {
					await callerOnVerifierEvent?.(event);
					return;
				}
				verifierHandled = true;
				if (event.kind === "accept" && event.tokens.length > 0) {
					streamedAny = true;
					const last = event.tokens[event.tokens.length - 1];
					nextIndex = Math.max(nextIndex, last.index + 1);
				}
				await this.pushVerifierEvent(event);
				await callerOnVerifierEvent?.(event);
			},
			onTextChunk: async (chunk: string) => {
				if (structuredVoiceExtractor) {
					structuredVoiceExtractor.push(chunk);
					await callerOnTextChunk?.(chunk);
					return;
				}
				if (chunk.length > 0 && !verifierHandled) {
					streamedAny = true;
					const token: TextToken = { index: nextIndex++, text: chunk };
					await bridge.pushAcceptedToken(token);
				}
				await callerOnTextChunk?.(chunk);
			},
		} as T;

		return {
			args: wrapped,
			finish: async (finalText: string) => {
				try {
					if (structuredVoiceExtractor) {
						if (!streamedAny && finalText.length > 0) {
							structuredVoiceExtractor.push(finalText);
						}
						structuredVoiceExtractor.flush();
						await structuredVoicePush;
					}
					if (
						!structuredVoiceExtractor &&
						!streamedAny &&
						finalText.length > 0 &&
						!bargeAbort.signal.aborted
					) {
						await bridge.pushAcceptedToken({
							index: nextIndex++,
							text: finalText,
						});
					}
					await bridge.settle();
				} finally {
					detachBarge();
				}
			},
		};
	}

	/**
	 * Forward a verifier-stream event into the voice scheduler. Accepted tokens flow into the
	 * phrase chunker; rejected ranges trigger the rollback queue. No-op
	 * when voice is not active so callers can fan out events
	 * unconditionally.
	 *
	 * When MTP produces an accepted text token, the phrase chunker MUST hand
	 * the chunk to TTS within the same scheduler tick.
	 */
	async pushVerifierEvent(event: VerifierStreamEvent): Promise<void> {
		const bridge = this.voiceBridge;
		if (!bridge) return;
		if (event.kind === "accept") {
			const now = Date.now();
			for (const tok of event.tokens) {
				await bridge.pushAcceptedToken(tok, now);
			}
			return;
		}
		if (event.tokens.length === 0) return;
		const range: RejectedTokenRange = {
			fromIndex: event.tokens[0].index,
			toIndex: event.tokens[event.tokens.length - 1].index,
		};
		await bridge.pushRejectedRange(range);
	}

	/**
	 * Mic VAD → barge-in. Per AGENTS.md §4, the PCM ring buffer MUST
	 * drain immediately and any in-flight TTS forward pass MUST be
	 * cancelled at the next kernel boundary. The scheduler enforces both
	 * — this is a thin pass-through.
	 */
	triggerBargeIn(): void {
		this.voiceBridge?.triggerBargeIn();
	}

	/**
	 * Test surface: fan an accepted-token list into the bridge in one
	 * call. Production callers should prefer `pushVerifierEvent` so the
	 * accept/reject discriminator stays explicit; this exists so the
	 * voice integration test can drive the scheduler without
	 * reconstructing `VerifierStreamEvent` boilerplate.
	 */
	async pushAcceptedTokens(tokens: ReadonlyArray<TextToken>): Promise<void> {
		await this.pushVerifierEvent({ kind: "accept", tokens: [...tokens] });
	}

	/**
	 * Active llama.cpp parallel slot count from the running FFI backend, or
	 * the configured default pool size when no model is loaded yet.
	 */
	private activeParallel(): number {
		if (this.activeBackendId() === "llama-cpp") {
			return this.dispatcher.parallelSlots();
		}
		return resolveDefaultPoolSize(process.env.ELIZA_LOCAL_SESSION_POOL_SIZE);
	}

	/**
	 * The in-process `Eliza1EotClassifier` required a node-bound `LlamaModel`
	 * forward pass, which the FFI runtime does not expose. Always null now —
	 * callers fall through to the GGUF (FFI) turn-detector and then the
	 * heuristic chain.
	 */
	private tryBuildEliza1EotClassifier(
		_mode: "prefer" | "force",
		_loraPath: string | undefined,
	): import("./voice/eot-classifier").Eliza1EotClassifier | null {
		return null;
	}
}

/**
 * Resolve which EOT classifier to build for a voice session. Precedence:
 *   1. Explicit `opts.useEliza1Eot` (`true` → `"force"`; `false` → `"off"`;
 *      `"auto"` or unset → step 2).
 *   2. `ELIZA_VOICE_EOT_BACKEND` env var (`eliza-1` → `"force"`, anything
 *      else like `livekit`/`turnsense`/`heuristic` → `"off"`; unset →
 *      step 3).
 *   3. Default `"prefer"` — we try eliza-1 first when available and fall
 *      back to LiveKit/Heuristic when the in-process backend is unavailable.
 *
 * Returns:
 *   - `"force"`  — must build; throw if preconditions fail.
 *   - `"prefer"` — try; on null, fall through to the LiveKit chain.
 *   - `"off"`    — skip eliza-1 entirely.
 */
function resolveEliza1EotSelection(
	optsValue: boolean | "auto" | undefined,
	_loraPath: string | undefined,
): "force" | "prefer" | "off" {
	if (optsValue === true) return "force";
	if (optsValue === false) return "off";
	const envValue = process.env.ELIZA_VOICE_EOT_BACKEND?.trim().toLowerCase();
	if (envValue === "eliza-1" || envValue === "eliza1") return "force";
	if (
		envValue === "livekit" ||
		envValue === "turnsense" ||
		envValue === "heuristic"
	)
		return "off";
	return "prefer";
}

export const localInferenceEngine = new LocalInferenceEngine();
