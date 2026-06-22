/**
 * Per-ModelType model assignment store.
 *
 * Separate from the "active loaded model" concept in `ActiveModelCoordinator`.
 * Assignments are a *policy* — the user's declared intent that
 * `ModelType.TEXT_SMALL` should be served by model X and `TEXT_LARGE` by
 * model Y. The runtime's model handlers lazy-load whichever assignment
 * fires; the coordinator handles the actual swap in and out of memory.
 *
 * Stored in `$ELIZA_STATE_DIR/local-inference/assignments.json`. Cheap
 * enough to rewrite on every change — we never mutate in place.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { findCatalogModel, isDefaultEligibleId } from "./catalog";
import { CapacitorExplicitModelPathLoader } from "./generic-gguf-backend";
import { localInferenceRoot } from "./paths";
import { listInstalledModels } from "./registry";
import {
	type AgentModelSlot,
	classifyInstalledModelRuntimeClass,
	type InstalledModel,
	type ModelAssignments,
	type RuntimeClass,
} from "./types";

const ASSIGNMENTS_FILENAME = "assignments.json";

/**
 * Raised when a slot assignment names a model the current platform's engine
 * cannot serve. Carries a typed reason so the route layer can surface a clean
 * 4xx instead of a deferred lazy-load failure with no UI signal.
 */
export class AssignmentNotServableError extends Error {
	readonly code = "ASSIGNMENT_NOT_SERVABLE" as const;
	readonly slot: AgentModelSlot;
	readonly modelId: string;
	readonly runtimeClass: RuntimeClass;
	constructor(args: {
		slot: AgentModelSlot;
		modelId: string;
		runtimeClass: RuntimeClass;
		message: string;
	}) {
		super(args.message);
		this.name = "AssignmentNotServableError";
		this.slot = args.slot;
		this.modelId = args.modelId;
		this.runtimeClass = args.runtimeClass;
	}
}

/**
 * Raised when a slot assignment is outside the curated Eliza-1 catalog.
 * Generic GGUF installs may still be visible to lower-level tooling, but the
 * agent assignment policy is deliberately Eliza-1-only.
 */
export class AssignmentRejectedError extends Error {
	readonly code = "ASSIGNMENT_REJECTED" as const;
	readonly slot: AgentModelSlot;
	readonly modelId: string;
	constructor(args: {
		slot: AgentModelSlot;
		modelId: string;
		message: string;
	}) {
		super(args.message);
		this.name = "AssignmentRejectedError";
		this.slot = args.slot;
		this.modelId = args.modelId;
	}
}

/**
 * Whether the current platform can serve a model of the given runtime class.
 * Fused Eliza-1 bundles are servable everywhere a fused libelizainference is
 * present (the engine's own load gate enforces the build requirement).
 * Generic single-file GGUF needs the explicit-`modelPath` binding, which ships
 * on mobile (`llama-cpp-capacitor`) but is not built into the desktop
 * libelizainference — so a desktop host cannot serve a generic model until
 * that binding is rebuilt in.
 */
export function canServeRuntimeClassOnHost(
	runtimeClass: RuntimeClass,
	loader: {
		available(): boolean | Promise<boolean>;
	} = new CapacitorExplicitModelPathLoader(),
): boolean | Promise<boolean> {
	if (runtimeClass === "fused-eliza1") return true;
	return loader.available();
}

interface AssignmentsFile {
	version: 1;
	assignments: ModelAssignments;
}

function assignmentsPath(): string {
	return path.join(localInferenceRoot(), ASSIGNMENTS_FILENAME);
}

function isCuratedEliza1AssignmentId(modelId: string): boolean {
	const catalog = findCatalogModel(modelId);
	return (
		!!catalog &&
		!catalog.hiddenFromCatalog &&
		catalog.runtimeRole !== "mtp-drafter" &&
		isDefaultEligibleId(catalog.id)
	);
}

function sanitizeAssignments(assignments: ModelAssignments): ModelAssignments {
	const next: ModelAssignments = {};
	for (const [slot, modelId] of Object.entries(assignments) as Array<
		[AgentModelSlot, string | undefined]
	>) {
		if (!modelId || !isCuratedEliza1AssignmentId(modelId)) continue;
		next[slot] = modelId;
	}
	return next;
}

async function ensureRoot(): Promise<void> {
	await fs.mkdir(localInferenceRoot(), { recursive: true });
}

export async function readAssignments(): Promise<ModelAssignments> {
	try {
		const raw = await fs.readFile(assignmentsPath(), "utf8");
		const parsed = JSON.parse(raw) as AssignmentsFile;
		if (parsed?.version !== 1 || !parsed.assignments) return {};
		return sanitizeAssignments(parsed.assignments);
	} catch {
		return {};
	}
}

function pickLargestInstalledModel(
	installed: InstalledModel[],
): InstalledModel | null {
	return (
		installed
			.filter((model) => typeof model.id === "string" && model.id.length > 0)
			.sort((left, right) => right.sizeBytes - left.sizeBytes)[0] ?? null
	);
}

/**
 * Build slot recommendations from currently-installed models.
 *
 * Only default-eligible Eliza-1 downloads are auto-recommended.
 * External-scan blobs and ad-hoc Hugging Face downloads are never assigned to
 * agent slots.
 *
 * Why: external blobs may use newer architectures or quant formats outside
 * the bundled `capacitor-llama` binding's supported set. Auto-loading
 * an external blob the user never selected silently breaks PROACTIVE_AGENT
 * and other background tasks at boot. The user opted into the external
 * tool, not into Eliza loading those weights through llama.cpp.
 */
export function buildRecommendedAssignments(
	installed: InstalledModel[],
): ModelAssignments {
	const ownDownloads = installed.filter(
		(model) =>
			model.source === "eliza-download" &&
			isDefaultEligibleId(model.id) &&
			typeof model.bundleVerifiedAt === "string" &&
			model.bundleVerifiedAt.length > 0,
	);
	const best = pickLargestInstalledModel(ownDownloads);
	if (best) {
		return {
			TEXT_SMALL: best.id,
			TEXT_LARGE: best.id,
			TEXT_TO_SPEECH: best.id,
			TRANSCRIPTION: best.id,
		};
	}

	return {};
}

export async function readEffectiveAssignments(): Promise<ModelAssignments> {
	const [saved, installed] = await Promise.all([
		readAssignments(),
		listInstalledModels(),
	]);
	return {
		...buildRecommendedAssignments(installed),
		...saved,
	};
}

export async function writeAssignments(
	assignments: ModelAssignments,
): Promise<void> {
	await ensureRoot();
	const payload: AssignmentsFile = { version: 1, assignments };
	const tmp = `${assignmentsPath()}.tmp`;
	await fs.writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
	await fs.rename(tmp, assignmentsPath());
}

export async function setAssignment(
	slot: AgentModelSlot,
	modelId: string | null,
): Promise<ModelAssignments> {
	const current = await readAssignments();
	const next: ModelAssignments = { ...current };
	if (modelId) {
		if (!isCuratedEliza1AssignmentId(modelId)) {
			throw new AssignmentRejectedError({
				slot,
				modelId,
				message:
					"Local inference assignments are limited to curated Eliza-1 tiers.",
			});
		}
		await assertAssignmentServable(slot, modelId);
		next[slot] = modelId;
	} else {
		delete next[slot];
	}
	await writeAssignments(next);
	return next;
}

/**
 * Validate at the boundary that the current platform's engine can actually
 * serve `modelId` before persisting the assignment. A non-Eliza-1 GGUF picked
 * on a host without the explicit-`modelPath` binding (desktop today) is
 * rejected with a typed reason — no silent deferred lazy-load failure. An id
 * that is not in the installed registry (e.g. a catalog tier not yet
 * downloaded) is allowed through: assignments are a declared policy and the
 * download/readiness layer surfaces the missing file separately.
 */
async function assertAssignmentServable(
	slot: AgentModelSlot,
	modelId: string,
): Promise<void> {
	const installed = await listInstalledModels();
	const target = installed.find((m) => m.id === modelId);
	if (!target) return;
	const runtimeClass = classifyInstalledModelRuntimeClass(target);
	const servable = await canServeRuntimeClassOnHost(runtimeClass);
	if (servable) return;
	throw new AssignmentNotServableError({
		slot,
		modelId,
		runtimeClass,
		message:
			`Cannot assign "${target.displayName}" to ${slot}: it is a generic single-file GGUF, ` +
			"and this platform has no runtime to serve a non-Eliza-1 model. Generic local models " +
			"need the explicit-modelPath binding (available on mobile; not built into the desktop " +
			"runtime yet). Pick an Eliza-1 model for this slot, or run on a platform with the generic binding.",
	});
}

/**
 * Decide which slots a freshly-installed model is a sensible default for.
 *
 * Today the curated catalog tags models with `category` ∈
 * `chat | code | tools | tiny | reasoning` and `bucket` ∈
 * `small | mid | large | xl` — no explicit "embedding" tag, because the
 * default catalog ships only generative models. The defensive check below
 * still recognizes an "embedding" category/bucket for catalog additions and
 * for external-scan models whose ids contain a recognizable
 * embedding-family marker (`nomic-embed`, `bge`, `all-minilm`, `gte`,
 * `e5-`). External GGUFs without a catalog entry default to generative.
 */
export function isEmbeddingModelId(modelId: string): boolean {
	const catalog = findCatalogModel(modelId);
	if (catalog) {
		if ((catalog.category as string) === "embedding") return true;
		if ((catalog.bucket as string) === "embedding") return true;
		return false;
	}
	const lowered = modelId.toLowerCase();
	return (
		lowered.includes("nomic-embed") ||
		lowered.includes("bge-") ||
		lowered.includes("all-minilm") ||
		lowered.includes("gte-") ||
		lowered.includes("e5-")
	);
}

/**
 * Fill empty assignment slots with `modelId`. Idempotent: never overwrites
 * an existing slot. Embedding models only fill `TEXT_EMBEDDING`; generative
 * models only fill `TEXT_SMALL` and `TEXT_LARGE`. Returns the resulting
 * assignment map (read state is `readAssignments()`, not effective +
 * recommended).
 *
 * Wired from the downloader's success path and the runtime boot's
 * "exactly one model installed, no assignments" branch so first-light
 * users land in chat without a Settings detour. The hard error in
 * `ensure-local-inference-handler.ts` only fires when the operator has
 * actively cleared the assignment.
 */
export async function ensureDefaultAssignment(
	modelId: string,
): Promise<ModelAssignments> {
	const current = await readAssignments();
	if (!isDefaultEligibleId(modelId)) return current;

	const next: ModelAssignments = { ...current };

	if (isEmbeddingModelId(modelId)) {
		if (!next.TEXT_EMBEDDING) next.TEXT_EMBEDDING = modelId;
	} else {
		if (!next.TEXT_SMALL) next.TEXT_SMALL = modelId;
		if (!next.TEXT_LARGE) next.TEXT_LARGE = modelId;
		if (!next.TEXT_TO_SPEECH) next.TEXT_TO_SPEECH = modelId;
		if (!next.TRANSCRIPTION) next.TRANSCRIPTION = modelId;
	}

	// Cheap shortcut: skip the rewrite when nothing changed.
	if (
		next.TEXT_SMALL === current.TEXT_SMALL &&
		next.TEXT_LARGE === current.TEXT_LARGE &&
		next.TEXT_EMBEDDING === current.TEXT_EMBEDDING &&
		next.TEXT_TO_SPEECH === current.TEXT_TO_SPEECH &&
		next.TRANSCRIPTION === current.TRANSCRIPTION
	) {
		return current;
	}

	await writeAssignments(next);
	return next;
}

/**
 * Boot-time helper. If exactly one default-eligible Eliza-1 model is
 * installed and no assignment file exists yet, auto-fill its slots so
 * the first session works without the user opening Settings. No-op when
 * assignments are already present or when more than one default-eligible
 * model is installed (we cannot guess intent).
 *
 * External-scan blobs and custom Hugging Face downloads are intentionally
 * excluded - see `buildRecommendedAssignments` for the rationale.
 */
export async function autoAssignAtBoot(
	installed: InstalledModel[],
): Promise<ModelAssignments | null> {
	const ownDownloads = installed.filter(
		(model) =>
			model.source === "eliza-download" &&
			isDefaultEligibleId(model.id) &&
			typeof model.bundleVerifiedAt === "string" &&
			model.bundleVerifiedAt.length > 0,
	);
	if (ownDownloads.length !== 1) return null;
	const current = await readAssignments();
	if (Object.keys(current).length > 0) return null;
	const onlyInstalled = ownDownloads[0];
	if (!onlyInstalled || typeof onlyInstalled.id !== "string") return null;
	return ensureDefaultAssignment(onlyInstalled.id);
}
