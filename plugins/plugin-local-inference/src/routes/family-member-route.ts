/**
 * Voice first-run route: create a family-member voice profile.
 *
 * Route:
 *   POST /v1/voice/first-run/family-member
 *     Body (JSON):
 *       {
 *         audioBase64: string,   // raw base64-encoded audio (webm/wav/ogg)
 *         durationMs: number,    // client-measured capture length
 *         displayName: string,   // e.g. "Alex"
 *         relationship: string,  // free-form label, e.g. "spouse", "colleague"
 *         ownerEntityId?: string // optional — stored on the profile for edge creation
 *       }
 *     Response:
 *       {
 *         profileId: string,    // content-addressed vp_<sha> id
 *         entityId: string,     // freshly minted UUID for the family-member entity
 *         displayName: string,
 *         relationship: string,
 *         relationshipTag: "family_of"
 *       }
 *
 * Audio pipeline (mirrors voice-first-run-routes.ts):
 *   1. Decode base64 → Buffer → Float32 PCM (assumes 16 kHz, mono).
 *   2. Encode via the fused `FusedSpeakerEncoder` → 256-dim centroid.
 *   3. Store in VoiceProfileStore (non-OWNER entity binding).
 *
 * Graceful degradation: when the fused libelizainference (or its speaker ABI)
 * is unavailable the route returns a 503. The client-side adapter
 * (`VoiceProfilesClient`) falls back to a client-side pending profile so the UI
 * flow is not blocked.
 *
 * The `family_of` relationship edge is recorded in profile metadata so a
 * runtime-level consumer (e.g. voice-first-run-complete handler) can create
 * the real Entity + Relationship rows after the runtime is up. The route
 * itself does not call IAgentRuntime because HTTP route handlers in this
 * plugin do not hold a runtime reference.
 */

import crypto from "node:crypto";
import type * as http from "node:http";
import path from "node:path";
import {
	logger,
	readJsonBody,
	resolveStateDir,
	sendJson,
	sendJsonError,
} from "@elizaos/core";
import { resolveFusedLibraryPath } from "../services/desktop-fused-ffi-backend-runtime.js";
import { loadElizaInferenceFfi } from "../services/voice/ffi-bindings.js";
import { VoiceProfileStore } from "../services/voice/profile-store.js";
import {
	type SpeakerEncoder,
	SpeakerEncoderUnavailableError,
	WESPEAKER_EMBEDDING_DIM,
	WESPEAKER_MIN_SAMPLES,
	WESPEAKER_RESNET34_LM_INT8_MODEL_ID,
	WESPEAKER_SAMPLE_RATE,
} from "../services/voice/speaker/encoder.js";
import { FusedSpeakerEncoder } from "../services/voice/speaker/encoder-fused.js";

// ---------------------------------------------------------------------------
// Injectable test hooks (mirrors voice-first-run-routes.ts)
// ---------------------------------------------------------------------------

export type FamilyMemberEncoderFactory = () => Promise<SpeakerEncoder>;

let encoderFactoryOverride: FamilyMemberEncoderFactory | null = null;
let cachedEncoder: SpeakerEncoder | null = null;

export function setFamilyMemberEncoderFactory(
	factory: FamilyMemberEncoderFactory | null,
): void {
	encoderFactoryOverride = factory;
	cachedEncoder = null;
}

let profileStoreOverride: VoiceProfileStore | null = null;

export function setFamilyMemberProfileStore(
	store: VoiceProfileStore | null,
): void {
	profileStoreOverride = store;
}

// ---------------------------------------------------------------------------
// Loader helpers
// ---------------------------------------------------------------------------

async function loadEncoder(): Promise<SpeakerEncoder> {
	if (cachedEncoder) return cachedEncoder;
	if (encoderFactoryOverride) {
		cachedEncoder = await encoderFactoryOverride();
		return cachedEncoder;
	}
	cachedEncoder = await loadFusedSpeakerEncoder();
	return cachedEncoder;
}

/**
 * Load the fused speaker encoder through the `eliza_inference_speaker_*` ABI —
 * the sole on-device speaker runtime. Probes the speaker ABI up front: a build
 * that lacks it raises a structured `SpeakerEncoderUnavailableError` (the route
 * surfaces a 503) rather than degrading silently. No standalone-lib fallback.
 */
async function loadFusedSpeakerEncoder(): Promise<SpeakerEncoder> {
	const bundleRoot = path.join(resolveStateDir(), "voice-profiles");
	const libPath = resolveFusedLibraryPath(bundleRoot);
	if (!libPath) {
		throw new SpeakerEncoderUnavailableError(
			"library-missing",
			"[family-member-route] fused libelizainference not found. Set $ELIZA_INFERENCE_LIBRARY (exact path) or $ELIZA_INFERENCE_LIB_DIR, or build it via packages/app-core/scripts/build-llama-cpp-mtp.mjs.",
		);
	}
	const ffi = loadElizaInferenceFfi(libPath);
	if (!FusedSpeakerEncoder.isSupported(ffi)) {
		throw new SpeakerEncoderUnavailableError(
			"native-missing",
			`[family-member-route] the fused libelizainference at ${libPath} (ABI v${ffi.libraryAbiVersion}) lacks the speaker ABI (eliza_inference_speaker_supported() == 0). Rebuild with the WeSpeaker forward graph linked in.`,
		);
	}
	const ctx = ffi.create(bundleRoot);
	return FusedSpeakerEncoder.load({ ffi, ctx });
}

async function getProfileStore(): Promise<VoiceProfileStore> {
	if (profileStoreOverride) return profileStoreOverride;
	const store = new VoiceProfileStore({
		rootDir: path.join(resolveStateDir(), "voice-profiles"),
	});
	await store.init();
	return store;
}

// ---------------------------------------------------------------------------
// Request body validation
// ---------------------------------------------------------------------------

interface FamilyMemberBody {
	audioBase64: string;
	durationMs: number;
	displayName: string;
	relationship: string;
	ownerEntityId?: string | null;
}

function parseFamilyMemberBody(
	raw: Record<string, unknown>,
): FamilyMemberBody | string {
	const audioBase64 =
		typeof raw.audioBase64 === "string" ? raw.audioBase64.trim() : null;
	if (!audioBase64) return "audioBase64 is required";

	const durationMs =
		typeof raw.durationMs === "number" && raw.durationMs > 0
			? raw.durationMs
			: null;
	if (durationMs === null) return "durationMs must be a positive number";

	const displayName =
		typeof raw.displayName === "string" && raw.displayName.trim().length > 0
			? raw.displayName.trim()
			: null;
	if (!displayName) return "displayName is required";

	const relationship =
		typeof raw.relationship === "string" && raw.relationship.trim().length > 0
			? raw.relationship.trim()
			: "family";

	const ownerEntityId =
		typeof raw.ownerEntityId === "string" && raw.ownerEntityId.trim()
			? raw.ownerEntityId.trim()
			: null;

	return { audioBase64, durationMs, displayName, relationship, ownerEntityId };
}

// ---------------------------------------------------------------------------
// PCM decode
// ---------------------------------------------------------------------------

function decodeBase64ToPcm(audioBase64: string): Float32Array | string {
	let rawBuf: Buffer;
	try {
		rawBuf = Buffer.from(audioBase64, "base64");
	} catch {
		return "failed to decode audioBase64";
	}
	if (rawBuf.byteLength % 4 !== 0) {
		return `PCM buffer length ${rawBuf.byteLength} is not a multiple of 4 (expected raw Float32 PCM)`;
	}
	const out = new Float32Array(rawBuf.byteLength / 4);
	const view = new DataView(
		rawBuf.buffer,
		rawBuf.byteOffset,
		rawBuf.byteLength,
	);
	for (let i = 0; i < out.length; i += 1) {
		out[i] = view.getFloat32(i * 4, true);
	}
	return out;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

/** Relationship tag written to profile metadata and echoed in response. */
export const FAMILY_OF_TAG = "family_of" as const;

export interface FamilyMemberResult {
	profileId: string;
	entityId: string;
	displayName: string;
	relationship: string;
	relationshipTag: typeof FAMILY_OF_TAG;
	ownerEntityId: string | null;
}

/**
 * Handle `POST /v1/voice/first-run/family-member`.
 *
 * Returns `true` when the request was handled (success or error response
 * written), `false` when the path does not match this handler.
 */
export async function handleFamilyMemberRoute(
	req: http.IncomingMessage,
	res: http.ServerResponse,
): Promise<boolean> {
	const method = (req.method ?? "GET").toUpperCase();
	const url = new URL(req.url ?? "/", "http://localhost");
	const pathname = url.pathname;

	if (method !== "POST" || pathname !== "/v1/voice/first-run/family-member") {
		return false;
	}

	const raw = await readJsonBody<Record<string, unknown>>(req, res);
	if (!raw) return true; // readJsonBody already sent a 4xx

	const parsed = parseFamilyMemberBody(raw);
	if (typeof parsed === "string") {
		sendJsonError(res, parsed, 400);
		return true;
	}

	const { audioBase64, durationMs, displayName, relationship, ownerEntityId } =
		parsed;

	// Decode audio.
	const pcmOrError = decodeBase64ToPcm(audioBase64);
	if (typeof pcmOrError === "string") {
		sendJsonError(res, pcmOrError, 400);
		return true;
	}
	const pcm = pcmOrError;

	if (pcm.length < WESPEAKER_MIN_SAMPLES) {
		sendJsonError(
			res,
			`capture too short: ${pcm.length} PCM samples (< ${WESPEAKER_MIN_SAMPLES} required for ${WESPEAKER_SAMPLE_RATE} Hz encoder). Minimum ~${Math.ceil((WESPEAKER_MIN_SAMPLES / WESPEAKER_SAMPLE_RATE) * 1000)}ms.`,
			400,
		);
		return true;
	}

	// Encode via WeSpeaker.
	let encoder: SpeakerEncoder;
	try {
		encoder = await loadEncoder();
	} catch (err) {
		if (err instanceof SpeakerEncoderUnavailableError) {
			sendJsonError(res, err.message, 503);
			return true;
		}
		throw err;
	}

	let centroid: Float32Array;
	try {
		centroid = await encoder.encode(pcm);
	} catch (err) {
		if (err instanceof SpeakerEncoderUnavailableError) {
			sendJsonError(res, err.message, err.code === "invalid-input" ? 400 : 503);
			return true;
		}
		throw err;
	}

	if (centroid.length !== WESPEAKER_EMBEDDING_DIM) {
		sendJsonError(
			res,
			`centroid dim mismatch: ${centroid.length} != ${WESPEAKER_EMBEDDING_DIM}`,
			500,
		);
		return true;
	}

	// Generate a stable entity ID for the family member.
	const entityId = crypto.randomUUID();

	// Store the profile in VoiceProfileStore.
	const store = await getProfileStore();
	let profile: Awaited<ReturnType<VoiceProfileStore["createProfile"]>>;
	try {
		profile = await store.createProfile({
			centroid,
			embeddingModel: WESPEAKER_RESNET34_LM_INT8_MODEL_ID,
			entityId,
			confidence: 0.85,
			durationMs,
			consent: {
				attributionAuthorized: true,
				synthesisAuthorized: false,
				grantedAt: new Date().toISOString(),
				grantedBy: ownerEntityId ?? undefined,
			},
			metadata: {
				displayName,
				relationship,
				cohort: "family",
				source: "first-run",
				relationshipTag: FAMILY_OF_TAG,
				ownerEntityId: ownerEntityId ?? null,
			},
		});
	} catch (err) {
		logger.error(
			{ err, displayName, relationship },
			"[family-member-route] failed to create voice profile",
		);
		sendJsonError(
			res,
			err instanceof Error ? err.message : "failed to create voice profile",
			500,
		);
		return true;
	}

	const result: FamilyMemberResult = {
		profileId: profile.profileId,
		entityId,
		displayName,
		relationship,
		relationshipTag: FAMILY_OF_TAG,
		ownerEntityId: ownerEntityId ?? null,
	};

	sendJson(res, result);
	return true;
}
