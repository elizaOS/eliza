/**
 * Orchestrator for the on-device artifact bundle the local-only / local
 * runtime needs to operate: embedding, TTS, STT, and (when the user is not
 * signed into Eliza Cloud) the text model. Called from:
 *
 *   - `runtime/ensure-local-inference-handler.ts` — fire-and-forget at agent
 *     boot whenever the resolved runtime mode is `local` or `local-only`.
 *   - `ui/src/onboarding/auto-download-recommended.ts` — when the user picks
 *     "Local" in the onboarding runtime gate, after the local agent's
 *     `/api/health` reports ready.
 *   - `POST /api/local-inference/ensure` — on-demand re-trigger from the
 *     settings UI / a CLI.
 *
 * Today every Eliza-1 tier ships every component (text + voice + asr +
 * embedding + dflash drafter + cache) as one HuggingFace bundle. The
 * orchestrator picks a tier per artifact kind (always the same tier today —
 * tier resolution is centralised on the recommender) and triggers parallel
 * `service.startDownload(modelId)` calls per kind. The downloader is
 * idempotent on the same `modelId`, so when the same tier covers multiple
 * kinds we end up with one bundle download and a per-kind audit trail.
 *
 * When the architecture later splits the bundle into separately addressable
 * sub-archives (per `packages/inference/AGENTS.md` §2 future work), the
 * per-kind selection in {@link modelIdForKind} is where the per-modality
 * model id would diverge — the rest of the orchestrator already wraps each
 * artifact in its own `Promise.allSettled` slot.
 *
 * `signedInCloud === true` skips the `text` artifact: cloud-routed inference
 * handles TEXT_LARGE / TEXT_SMALL, and we don't want a multi-gig text weight
 * download imposed on a user who chose cloud routing. Embedding / TTS / STT
 * always download — the local runtime serves those locally regardless of
 * whether the text model is cloud-routed.
 */

import type { RuntimeMode } from "../../../../packages/app-core/src/runtime/mode/runtime-mode";
import type { Eliza1Tier } from "./manifest";
import {
	classifyRecommendationPlatform,
	selectRecommendedModelForSlot,
} from "./recommendation";
import type { LocalInferenceService } from "./service";
import type { CatalogModel, HardwareProbe, InstalledModel } from "./types";

/**
 * Resolve the default service facade lazily. Static-importing
 * `localInferenceService` from `./service` would instantiate the
 * `LocalInferenceService` (and its inner `ActiveModelCoordinator`) at
 * module-load time, which is heavier than this orchestrator needs and
 * breaks any test that mocks `./active-model` without re-exporting
 * `ActiveModelCoordinator`. The dynamic import keeps the runtime-default
 * path while leaving test injection as the lighter-weight option.
 */
async function defaultService(): Promise<LocalInferenceService> {
	const mod = await import("./service");
	return mod.localInferenceService;
}

/**
 * Artifact kinds the orchestrator can trigger. The label is consumer-facing
 * (logs / API responses) and is intentionally distinct from the catalog's
 * `ModelCategory` — the catalog labels a full chat tier as `"chat"`, while
 * here we describe the on-device modality the artifact serves.
 */
export type EnsureLocalArtifactKind = "embedding" | "tts" | "stt" | "text";

export type EnsureLocalArtifactStatus =
	| "started"
	| "already-installed"
	| "skipped"
	| "failed";

export interface EnsureLocalArtifactOutcome {
	kind: EnsureLocalArtifactKind;
	modelId: string;
	status: EnsureLocalArtifactStatus;
	/** Free-text disambiguation. Populated for skipped / failed outcomes. */
	reason?: string;
}

export interface EnsureLocalArtifactsArgs {
	/** Resolved runtime mode (local | local-only | cloud | remote). */
	mode: RuntimeMode;
	/** Optional tier override; if omitted, picked from the device hardware probe. */
	tier?: Eliza1Tier;
	/** True when the user is signed into Eliza Cloud. Suppresses the text artifact. */
	signedInCloud: boolean;
	/** Optional service facade override (tests). */
	service?: LocalInferenceService;
	/** Optional logger. */
	logger?: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void };
}

export interface EnsureLocalArtifactsResult {
	artifacts: EnsureLocalArtifactOutcome[];
	/**
	 * True iff every required artifact is now either installed or actively
	 * downloading. False when any artifact slot failed; the per-artifact
	 * outcome carries the reason.
	 */
	complete: boolean;
}

const LOG_TAG = "[ensureLocalArtifacts]";

interface ResolvedLogger {
	info: (...a: unknown[]) => void;
	warn: (...a: unknown[]) => void;
}

function resolveLogger(
	provided?: EnsureLocalArtifactsArgs["logger"],
): ResolvedLogger {
	if (provided) return provided;
	return {
		info: (...a: unknown[]) => console.info(LOG_TAG, ...a),
		warn: (...a: unknown[]) => console.warn(LOG_TAG, ...a),
	};
}

/**
 * Map the recommender's selection for `TEXT_LARGE` (the canonical first-run
 * slot) onto a tier id. The recommender already biases toward the smallest
 * tier that fits the device's memory budget — that bundle is what carries
 * the embedding / TTS / STT artifacts for the local runtime.
 *
 * Returns null when the recommender has no fitting catalog entry — usually
 * means the device is below every tier's RAM floor. The caller falls back
 * to recording a skipped outcome per artifact so the user sees an audited
 * no-op rather than a silent miss.
 */
function tierFromRecommendation(
	hardware: HardwareProbe,
): { model: CatalogModel; tier: Eliza1Tier } | null {
	const selection = selectRecommendedModelForSlot("TEXT_LARGE", hardware);
	const model = selection.model;
	if (!model) return null;
	const tier = tierFromCatalogId(model.id);
	if (!tier) return null;
	return { model, tier };
}

/** "eliza-1-2b" → "2b"; null if the id is not an Eliza-1 tier shape. */
function tierFromCatalogId(id: string): Eliza1Tier | null {
	if (!id.startsWith("eliza-1-")) return null;
	const slug = id.slice("eliza-1-".length) as Eliza1Tier;
	return slug;
}

/** "0_8b" → "eliza-1-0_8b" — inverse of {@link tierFromCatalogId}. */
function catalogIdFromTier(tier: Eliza1Tier): string {
	return `eliza-1-${tier}`;
}

/**
 * The orchestrator picks a single bundle id today (each Eliza-1 tier ships
 * embedding / voice / asr / drafter as one HF bundle). Each artifact "kind"
 * therefore resolves to the same `modelId`; the downloader's idempotency
 * collapses parallel `startDownload(modelId)` calls into one job.
 *
 * If the architecture later splits the bundle, this helper is where each
 * kind would diverge to its own id — the orchestrator already wraps each
 * kind in its own `Promise.allSettled` slot, so no surrounding code has to
 * change.
 */
function modelIdForKind(
	tier: Eliza1Tier,
	_kind: EnsureLocalArtifactKind,
): string {
	return catalogIdFromTier(tier);
}

interface ArtifactPlan {
	kind: EnsureLocalArtifactKind;
	modelId: string;
}

function planArtifacts(
	tier: Eliza1Tier,
	signedInCloud: boolean,
): ArtifactPlan[] {
	const plan: ArtifactPlan[] = [
		{ kind: "embedding", modelId: modelIdForKind(tier, "embedding") },
		{ kind: "tts", modelId: modelIdForKind(tier, "tts") },
		{ kind: "stt", modelId: modelIdForKind(tier, "stt") },
	];
	if (!signedInCloud) {
		plan.push({ kind: "text", modelId: modelIdForKind(tier, "text") });
	}
	return plan;
}

/**
 * Run one artifact slot: skip when already installed, otherwise trigger the
 * download via the service facade. Never throws — errors are folded into the
 * outcome record so {@link Promise.allSettled} stays a no-op safety net.
 */
async function runArtifact(
	plan: ArtifactPlan,
	service: LocalInferenceService,
	installedIds: Set<string>,
	logger: ResolvedLogger,
): Promise<EnsureLocalArtifactOutcome> {
	if (installedIds.has(plan.modelId)) {
		logger.info(
			`${plan.kind} model ${plan.modelId} is already installed; nothing to do`,
		);
		return {
			kind: plan.kind,
			modelId: plan.modelId,
			status: "already-installed",
		};
	}
	try {
		await service.startDownload(plan.modelId);
		logger.info(`${plan.kind} model ${plan.modelId} download started`);
		return { kind: plan.kind, modelId: plan.modelId, status: "started" };
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		logger.warn(
			`${plan.kind} model ${plan.modelId} download failed to start:`,
			reason,
		);
		return {
			kind: plan.kind,
			modelId: plan.modelId,
			status: "failed",
			reason,
		};
	}
}

/**
 * Build the no-op result for `cloud` / `remote` modes. Kept structurally
 * identical to the local-mode result so callers don't have to branch on the
 * runtime mode just to read the response.
 */
function noopResult(): EnsureLocalArtifactsResult {
	return { artifacts: [], complete: true };
}

/**
 * Trigger the parallel downloads of every artifact the local runtime needs
 * to operate on this device. See the module docstring for the per-mode /
 * per-cloud-state contract.
 */
export async function ensureLocalArtifacts(
	args: EnsureLocalArtifactsArgs,
): Promise<EnsureLocalArtifactsResult> {
	const logger = resolveLogger(args.logger);
	const service = args.service ?? (await defaultService());

	// Cloud / remote modes never need on-device artifacts — the runtime
	// routes through cloud (cloud) or controls another local instance
	// (remote). Either way the local artifact pipeline is irrelevant.
	if (args.mode === "cloud" || args.mode === "remote") {
		logger.info(`mode is ${args.mode}; no on-device artifacts to download`);
		return noopResult();
	}

	// Resolve the tier. Caller may pin one (settings override / test); else
	// we project the hardware probe through the recommender's TEXT_LARGE
	// ladder so the chosen tier matches what the user would have selected
	// via the model hub. When the recommender returns null (no fitting
	// catalog entry — device below every tier's floor) we record skipped
	// outcomes for every kind so the caller sees a clear, audited no-op
	// rather than a silent miss.
	let tier: Eliza1Tier | null = args.tier ?? null;
	let recommendedModelLabel: string | null = null;
	if (!tier) {
		const hardware = await service.getHardware();
		const recommendation = tierFromRecommendation(hardware);
		if (recommendation) {
			tier = recommendation.tier;
			recommendedModelLabel = recommendation.model.id;
			logger.info(
				`tier ${tier} selected from recommender for platform ${classifyRecommendationPlatform(hardware)}`,
			);
		}
	}

	if (!tier) {
		const reason =
			"no Eliza-1 tier fits the device hardware probe; nothing to download";
		logger.warn(reason);
		const skipped: EnsureLocalArtifactOutcome[] = (
			["embedding", "tts", "stt"] as EnsureLocalArtifactKind[]
		).map((kind) => ({
			kind,
			modelId: "",
			status: "skipped",
			reason,
		}));
		if (!args.signedInCloud) {
			skipped.push({
				kind: "text",
				modelId: "",
				status: "skipped",
				reason,
			});
		}
		return { artifacts: skipped, complete: false };
	}

	if (recommendedModelLabel) {
		logger.info(
			`targeting bundle ${recommendedModelLabel} for tier ${tier}, signedInCloud=${args.signedInCloud}`,
		);
	} else {
		logger.info(
			`targeting tier ${tier} (override), signedInCloud=${args.signedInCloud}`,
		);
	}

	// Read installed bundles once — every artifact runs through the same
	// set, and the facade returns a fresh list each call.
	let installed: ReadonlyArray<InstalledModel> = [];
	try {
		installed = await service.getInstalled();
	} catch (err) {
		logger.warn(
			"failed to enumerate installed models; assuming nothing is installed:",
			err instanceof Error ? err.message : String(err),
		);
	}
	const installedIds = new Set(installed.map((m) => m.id));

	const plan = planArtifacts(tier, args.signedInCloud);
	const settled = await Promise.allSettled(
		plan.map((entry) => runArtifact(entry, service, installedIds, logger)),
	);

	const artifacts: EnsureLocalArtifactOutcome[] = settled.map((result, idx) => {
		if (result.status === "fulfilled") return result.value;
		const reason =
			result.reason instanceof Error
				? result.reason.message
				: String(result.reason);
		return {
			kind: plan[idx].kind,
			modelId: plan[idx].modelId,
			status: "failed",
			reason,
		};
	});

	const complete = artifacts.every(
		(a) => a.status === "started" || a.status === "already-installed",
	);

	return { artifacts, complete };
}
