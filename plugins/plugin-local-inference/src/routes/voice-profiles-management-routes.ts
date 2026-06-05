/**
 * Voice-profile management routes — `/api/voice/profiles*`.
 *
 * These back the `VoiceProfilesClient` / `VoiceProfileSection` UI: list,
 * rename / relationship / retention edits, delete, bulk delete, merge, split,
 * export, sample-audio preview, and entity binding. They operate on the
 * `VoiceProfileStore` (recognized-speaker centroids), mapping each record to
 * the UI's `VoiceProfile` DTO.
 *
 * Distinct from `/v1/voice/profiles` (the OmniVoice TTS preset catalog in
 * `services/voice/voice-profile-routes.ts`). The OWNER is the profile bound to
 * `ELIZA_ADMIN_ENTITY_ID`.
 *
 * Routes:
 *   GET    /api/voice/profiles                 → { profiles: VoiceProfileDto[] }
 *   PATCH  /api/voice/profiles/:id             { displayName?, relationshipLabel?, retentionDays? }
 *   DELETE /api/voice/profiles/:id             → { deleted }
 *   DELETE /api/voice/profiles[?includeOwner=] → { deleted: number }
 *   POST   /api/voice/profiles/:id/merge       { intoId }
 *   POST   /api/voice/profiles/:id/split       { utteranceIds }
 *   POST   /api/voice/profiles/:id/bind        { entityId, label? }
 *   POST   /api/voice/profiles/:id/unbind
 *   POST   /api/voice/profiles/export          → { downloadUrl }
 *   GET    /api/voice/profiles/:id/sample      → audio/wav (consent-gated; 404 if absent)
 *
 * Route handlers in this plugin do not hold an `IAgentRuntime`, so bind here
 * persists `entityId` at the profile level. The relationship-graph edge is
 * materialised separately via the `VOICE_TURN_OBSERVED` → merge-engine seam
 * (see runtime/voice-entity-binding.ts and the IDENTIFY_SPEAKER action).
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
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
	VoiceProfileStore,
	type VoiceProfileRecord,
} from "../services/voice/profile-store.js";

// ---------------------------------------------------------------------------
// Store wiring (injectable for tests)
// ---------------------------------------------------------------------------

let profileStoreOverride: VoiceProfileStore | null = null;

export function setVoiceProfilesManagementStore(
	store: VoiceProfileStore | null,
): void {
	profileStoreOverride = store;
}

function voiceProfilesRoot(): string {
	return path.join(resolveStateDir(process.env), "voice-profiles");
}

async function getStore(): Promise<VoiceProfileStore> {
	if (profileStoreOverride) return profileStoreOverride;
	const store = new VoiceProfileStore({ rootDir: voiceProfilesRoot() });
	await store.init();
	return store;
}

function ownerEntityId(): string | null {
	const raw = process.env.ELIZA_ADMIN_ENTITY_ID;
	return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

// ---------------------------------------------------------------------------
// DTO mapping
// ---------------------------------------------------------------------------

type Cohort = "owner" | "family" | "guest" | "unknown";
type Source = "first-run" | "auto-clustered" | "manual";

export interface VoiceProfileDto {
	id: string;
	entityId: string | null;
	displayName: string;
	relationshipLabel: string | null;
	isOwner: boolean;
	embeddingCount: number;
	firstHeardAtMs: number;
	lastHeardAtMs: number;
	cohort: Cohort;
	source: Source;
	retentionDays: number | null;
	samplePreviewUri: string | null;
}

function metaString(meta: Record<string, unknown> | undefined, key: string): string | null {
	const v = meta?.[key];
	return typeof v === "string" && v.length > 0 ? v : null;
}

function asCohort(value: unknown): Cohort | null {
	return value === "owner" || value === "family" || value === "guest" || value === "unknown"
		? value
		: null;
}

function asSource(value: unknown): Source | null {
	return value === "first-run" || value === "auto-clustered" || value === "manual"
		? value
		: null;
}

function sampleWavPath(rootDir: string, profileId: string): string | null {
	const dir = path.join(rootDir, "audio", profileId);
	if (!fs.existsSync(dir)) return null;
	try {
		const wav = fs
			.readdirSync(dir)
			.filter((f) => f.toLowerCase().endsWith(".wav"))
			.sort()[0];
		return wav ? path.join(dir, wav) : null;
	} catch {
		return null;
	}
}

function toDto(
	record: VoiceProfileRecord,
	owner: string | null,
	rootDir: string,
): VoiceProfileDto {
	const meta = record.metadata;
	const isOwner = Boolean(owner) && record.entityId === owner;
	const cohort: Cohort = isOwner
		? "owner"
		: (asCohort(meta?.cohort) ?? (record.entityId ? "guest" : "unknown"));
	const hasSample =
		(record.audioRefs?.length ?? 0) > 0 &&
		sampleWavPath(rootDir, record.profileId) !== null;
	return {
		id: record.profileId,
		entityId: record.entityId,
		displayName:
			metaString(meta, "displayName") ?? metaString(meta, "label") ?? record.profileId,
		relationshipLabel:
			metaString(meta, "relationship") ?? metaString(meta, "relationshipLabel"),
		isOwner,
		embeddingCount: record.sampleCount,
		firstHeardAtMs: Date.parse(record.firstObservedAt) || 0,
		lastHeardAtMs: Date.parse(record.lastObservedAt) || 0,
		cohort,
		source: asSource(meta?.source) ?? "auto-clustered",
		retentionDays:
			typeof meta?.retentionDays === "number" ? meta.retentionDays : null,
		samplePreviewUri: hasSample
			? `/api/voice/profiles/${encodeURIComponent(record.profileId)}/sample`
			: null,
	};
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

const PROFILE_ID_RE = /^[A-Za-z0-9._-]+$/;
const ID_SUB = /^\/api\/voice\/profiles\/([^/]+)(?:\/(merge|split|bind|unbind|sample))?$/;

function validId(id: string): boolean {
	return PROFILE_ID_RE.test(id);
}

export async function handleVoiceProfilesManagementRoutes(
	req: http.IncomingMessage,
	res: http.ServerResponse,
): Promise<boolean> {
	const method = (req.method ?? "GET").toUpperCase();
	const url = new URL(req.url ?? "/", "http://localhost");
	const pathname = url.pathname;

	if (!pathname.startsWith("/api/voice/profiles")) return false;

	// Collection-level routes.
	if (pathname === "/api/voice/profiles") {
		if (method === "GET") return listProfiles(res);
		if (method === "DELETE") {
			return deleteAll(res, url.searchParams.get("includeOwner") === "true");
		}
		return false;
	}
	if (pathname === "/api/voice/profiles/export" && method === "POST") {
		return exportAll(res);
	}

	const m = ID_SUB.exec(pathname);
	if (!m) return false;
	const id = decodeURIComponent(m[1] ?? "");
	const sub = m[2];
	if (!validId(id)) {
		sendJsonError(res, `invalid profile id: ${id}`, 400);
		return true;
	}

	if (!sub) {
		if (method === "PATCH") return patchProfile(req, res, id);
		if (method === "DELETE") return deleteProfile(res, id);
		return false;
	}
	if (sub === "sample" && method === "GET") return serveSample(res, id);
	if (sub === "merge" && method === "POST") return mergeProfile(req, res, id);
	if (sub === "split" && method === "POST") return splitProfile(req, res, id);
	if (sub === "bind" && method === "POST") return bindProfile(req, res, id);
	if (sub === "unbind" && method === "POST") return unbindProfile(res, id);
	return false;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function listProfiles(res: http.ServerResponse): Promise<true> {
	const store = await getStore();
	const owner = ownerEntityId();
	const root = voiceProfilesRoot();
	const records = await store.list();
	sendJson(res, { profiles: records.map((r) => toDto(r, owner, root)) });
	return true;
}

async function patchProfile(
	req: http.IncomingMessage,
	res: http.ServerResponse,
	id: string,
): Promise<true> {
	const body = await readJsonBody<Record<string, unknown>>(req, res);
	if (!body) return true;
	const patch: Record<string, unknown> = {};
	if ("displayName" in body) {
		patch.displayName =
			typeof body.displayName === "string" ? body.displayName.trim() : null;
	}
	if ("relationshipLabel" in body) {
		patch.relationship =
			typeof body.relationshipLabel === "string" && body.relationshipLabel.trim()
				? body.relationshipLabel.trim()
				: null;
	}
	if ("retentionDays" in body) {
		patch.retentionDays =
			typeof body.retentionDays === "number" && body.retentionDays > 0
				? Math.round(body.retentionDays)
				: null;
	}
	const store = await getStore();
	const updated = await store.updateMetadata(id, patch);
	if (!updated) {
		sendJsonError(res, `profile not found: ${id}`, 404);
		return true;
	}
	sendJson(res, toDto(updated, ownerEntityId(), voiceProfilesRoot()));
	return true;
}

async function deleteProfile(
	res: http.ServerResponse,
	id: string,
): Promise<true> {
	const store = await getStore();
	const record = await store.get(id);
	if (!record) {
		sendJsonError(res, `profile not found: ${id}`, 404);
		return true;
	}
	const owner = ownerEntityId();
	if (owner && record.entityId === owner) {
		sendJsonError(res, "the OWNER profile cannot be deleted", 409);
		return true;
	}
	await store.deleteProfile({ profileId: id, allowBoundEntity: true });
	sendJson(res, { deleted: id });
	return true;
}

async function deleteAll(
	res: http.ServerResponse,
	includeOwner: boolean,
): Promise<true> {
	const store = await getStore();
	const owner = ownerEntityId();
	const records = await store.list();
	let deleted = 0;
	for (const record of records) {
		if (!includeOwner && owner && record.entityId === owner) continue;
		await store.deleteProfile({ profileId: record.profileId, allowBoundEntity: true });
		deleted += 1;
	}
	sendJson(res, { deleted });
	return true;
}

async function mergeProfile(
	req: http.IncomingMessage,
	res: http.ServerResponse,
	id: string,
): Promise<true> {
	const body = await readJsonBody<Record<string, unknown>>(req, res);
	if (!body) return true;
	const intoId = typeof body.intoId === "string" ? body.intoId.trim() : "";
	if (!intoId || !validId(intoId)) {
		sendJsonError(res, "intoId is required", 400);
		return true;
	}
	const store = await getStore();
	let merged: VoiceProfileRecord | null;
	try {
		merged = await store.mergeProfiles({
			sourceId: id,
			targetId: intoId,
			allowEntityOverwrite: body.allowEntityOverwrite === true,
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : "merge failed";
		sendJsonError(res, message, /conflict/i.test(message) ? 409 : 400);
		return true;
	}
	if (!merged) {
		sendJsonError(res, "one or both profiles not found", 404);
		return true;
	}
	sendJson(res, toDto(merged, ownerEntityId(), voiceProfilesRoot()));
	return true;
}

async function splitProfile(
	req: http.IncomingMessage,
	res: http.ServerResponse,
	id: string,
): Promise<true> {
	const body = await readJsonBody<Record<string, unknown>>(req, res);
	if (!body) return true;
	const utteranceIds = Array.isArray(body.utteranceIds)
		? body.utteranceIds.filter((v): v is string => typeof v === "string")
		: [];
	if (utteranceIds.length === 0) {
		sendJsonError(res, "utteranceIds is required", 400);
		return true;
	}
	const store = await getStore();
	let result: Awaited<ReturnType<VoiceProfileStore["splitProfile"]>>;
	try {
		result = await store.splitProfile({ profileId: id, sampleIds: utteranceIds });
	} catch (err) {
		sendJsonError(res, err instanceof Error ? err.message : "split failed", 400);
		return true;
	}
	if (!result) {
		sendJsonError(res, `profile not found: ${id}`, 404);
		return true;
	}
	const owner = ownerEntityId();
	const root = voiceProfilesRoot();
	sendJson(res, {
		original: toDto(result.original, owner, root),
		split: toDto(result.split, owner, root),
	});
	return true;
}

async function bindProfile(
	req: http.IncomingMessage,
	res: http.ServerResponse,
	id: string,
): Promise<true> {
	const body = await readJsonBody<Record<string, unknown>>(req, res);
	if (!body) return true;
	const entityId = typeof body.entityId === "string" ? body.entityId.trim() : "";
	if (!entityId) {
		sendJsonError(res, "entityId is required", 400);
		return true;
	}
	const label =
		typeof body.label === "string" && body.label.trim() ? body.label.trim() : undefined;
	const store = await getStore();
	const updated = await store.bindEntity({ profileId: id, entityId, label });
	if (!updated) {
		sendJsonError(res, `profile not found: ${id}`, 404);
		return true;
	}
	sendJson(res, toDto(updated, ownerEntityId(), voiceProfilesRoot()));
	return true;
}

async function unbindProfile(
	res: http.ServerResponse,
	id: string,
): Promise<true> {
	const store = await getStore();
	const updated = await store.unbindEntity(id);
	if (!updated) {
		sendJsonError(res, `profile not found: ${id}`, 404);
		return true;
	}
	sendJson(res, toDto(updated, ownerEntityId(), voiceProfilesRoot()));
	return true;
}

async function exportAll(res: http.ServerResponse): Promise<true> {
	const store = await getStore();
	const owner = ownerEntityId();
	const root = voiceProfilesRoot();
	const records = await store.list();
	const payload = {
		schema: "eliza.voice_profiles_export.v1",
		exportedAt: new Date().toISOString(),
		ownerEntityId: owner,
		profiles: records.map((r) => toDto(r, owner, root)),
	};
	// Self-contained data URL — no temp files, no extra serving route.
	const json = JSON.stringify(payload, null, 2);
	const downloadUrl = `data:application/json;base64,${Buffer.from(json, "utf8").toString("base64")}`;
	sendJson(res, { downloadUrl });
	return true;
}

async function serveSample(
	res: http.ServerResponse,
	id: string,
): Promise<true> {
	const wav = sampleWavPath(voiceProfilesRoot(), id);
	if (!wav) {
		sendJsonError(res, "no sample audio for this profile", 404);
		return true;
	}
	try {
		const bytes = await fsp.readFile(wav);
		res.writeHead(200, {
			"content-type": "audio/wav",
			"content-length": String(bytes.byteLength),
			"cache-control": "private, max-age=60",
		});
		res.end(bytes);
	} catch (err) {
		logger.error({ err, id }, "[voice-profiles-route] failed to read sample wav");
		sendJsonError(res, "failed to read sample audio", 500);
	}
	return true;
}
