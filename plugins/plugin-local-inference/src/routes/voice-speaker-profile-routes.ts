/**
 * Speaker voice-profile binding routes.
 *
 * These operate on the `VoiceProfileStore` — the content-addressed store of
 * WeSpeaker centroids that the attribution pipeline matches against (one
 * `vp_<sha>` record per recognized voice). This is a *different* surface from
 * the OmniVoice preset catalog in `services/voice/voice-profile-routes.ts`
 * (which manages TTS preset `.bin` files under `/v1/voice/profiles`).
 *
 * The attribution pipeline can resolve *which* voice is speaking, but a freshly
 * clustered profile carries `entityId: null` until something binds it to a real
 * elizaOS `Entity`. Without a binding the speaker is never persisted to the
 * relationship graph and the OWNER-crown in the UI never lights up outside
 * tests. The store already supports `bindEntity` / `unbindEntity`; these routes
 * are the runtime path that calls them.
 *
 * Routes:
 *   GET  /v1/voice/speaker-profiles
 *     → { profiles: SpeakerProfileSummary[] }
 *
 *   POST /v1/voice/speaker-profiles/:id/bind
 *     Body (JSON): { entityId: string, label?: string }
 *     → SpeakerProfileSummary  (entityId now non-null)
 *
 *   POST /v1/voice/speaker-profiles/:id/unbind
 *     → SpeakerProfileSummary  (entityId now null)
 *
 * The caller supplies the `entityId` of an existing elizaOS entity (e.g. a
 * contact the user picks in the voice-management UI, or the OWNER entity from
 * first-run). These handlers do not mint entities or relationship rows: route
 * handlers in this plugin do not hold an `IAgentRuntime` reference (see
 * `family-member-route.ts`). They bind the speaker centroid to an entity id the
 * store persists, which the attribution pipeline then resolves on the next
 * recognition.
 */

import type * as http from "node:http";
import path from "node:path";
import {
	logger,
	readJsonBody,
	resolveStateDir,
	sendJson,
	sendJsonError,
} from "@elizaos/core";
import {
	type VoiceProfileRecord,
	VoiceProfileStore,
} from "../services/voice/profile-store.js";

// ---------------------------------------------------------------------------
// Injectable test hook (mirrors family-member-route.ts)
// ---------------------------------------------------------------------------

let profileStoreOverride: VoiceProfileStore | null = null;

export function setVoiceSpeakerProfileStore(
	store: VoiceProfileStore | null,
): void {
	profileStoreOverride = store;
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
// Response shape
// ---------------------------------------------------------------------------

export interface SpeakerProfileSummary {
	profileId: string;
	entityId: string | null;
	label: string | null;
	embeddingModel: string;
	sampleCount: number;
	confidence: number;
	firstObservedAt: string;
	lastObservedAt: string;
}

function summarize(record: VoiceProfileRecord): SpeakerProfileSummary {
	const label =
		typeof record.metadata?.label === "string" ? record.metadata.label : null;
	return {
		profileId: record.profileId,
		entityId: record.entityId,
		label,
		embeddingModel: record.embeddingModel,
		sampleCount: record.sampleCount,
		confidence: record.confidence,
		firstObservedAt: record.firstObservedAt,
		lastObservedAt: record.lastObservedAt,
	};
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

const PROFILE_ID_RE = /^[A-Za-z0-9._-]+$/;
const BIND_RE = /^\/v1\/voice\/speaker-profiles\/([^/]+)\/bind$/;
const UNBIND_RE = /^\/v1\/voice\/speaker-profiles\/([^/]+)\/unbind$/;

/**
 * Handle `/v1/voice/speaker-profiles*` requests.
 *
 * Returns `true` when the request was handled (success or error response
 * written), `false` when the path does not match so the caller can fall
 * through to the next handler.
 */
export async function handleVoiceSpeakerProfileRoutes(
	req: http.IncomingMessage,
	res: http.ServerResponse,
): Promise<boolean> {
	const method = (req.method ?? "GET").toUpperCase();
	const url = new URL(req.url ?? "/", "http://localhost");
	const pathname = url.pathname;

	if (!pathname.startsWith("/v1/voice/speaker-profiles")) return false;

	// GET /v1/voice/speaker-profiles — list recognized speaker profiles.
	if (method === "GET" && pathname === "/v1/voice/speaker-profiles") {
		const store = await getProfileStore();
		const records = await store.list();
		sendJson(res, { profiles: records.map(summarize) });
		return true;
	}

	// POST /v1/voice/speaker-profiles/:id/bind { entityId, label? }
	const bindMatch = BIND_RE.exec(pathname);
	if (method === "POST" && bindMatch) {
		const profileId = decodeURIComponent(bindMatch[1] ?? "");
		if (!PROFILE_ID_RE.test(profileId)) {
			sendJsonError(res, `invalid profile id: ${profileId}`, 400);
			return true;
		}
		const body = await readJsonBody<Record<string, unknown>>(req, res);
		if (!body) return true; // readJsonBody already sent a 4xx
		const entityId =
			typeof body.entityId === "string" ? body.entityId.trim() : "";
		if (!entityId) {
			sendJsonError(res, "entityId is required", 400);
			return true;
		}
		const label =
			typeof body.label === "string" && body.label.trim().length > 0
				? body.label.trim()
				: undefined;

		const store = await getProfileStore();
		let updated: VoiceProfileRecord | null;
		try {
			updated = await store.bindEntity({ profileId, entityId, label });
		} catch (err) {
			logger.error(
				{ err, profileId, entityId },
				"[voice-speaker-profile-route] bindEntity failed",
			);
			sendJsonError(
				res,
				err instanceof Error ? err.message : "failed to bind entity",
				500,
			);
			return true;
		}
		if (!updated) {
			sendJsonError(res, `profile not found: ${profileId}`, 404);
			return true;
		}
		sendJson(res, summarize(updated));
		return true;
	}

	// POST /v1/voice/speaker-profiles/:id/unbind
	const unbindMatch = UNBIND_RE.exec(pathname);
	if (method === "POST" && unbindMatch) {
		const profileId = decodeURIComponent(unbindMatch[1] ?? "");
		if (!PROFILE_ID_RE.test(profileId)) {
			sendJsonError(res, `invalid profile id: ${profileId}`, 400);
			return true;
		}
		const store = await getProfileStore();
		const updated = await store.unbindEntity(profileId);
		if (!updated) {
			sendJsonError(res, `profile not found: ${profileId}`, 404);
			return true;
		}
		sendJson(res, summarize(updated));
		return true;
	}

	return false;
}
