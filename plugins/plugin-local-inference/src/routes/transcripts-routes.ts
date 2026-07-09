/**
 * Transcript HTTP routes (#8789) — `/api/transcripts*`, served as rawPath plugin
 * routes (on `runtime.routes`, dispatched by both the upstream agent server and
 * app-core) so the Transcripts view + the recording pipeline have a backend.
 * Audio is served by the existing content-addressed media store via each
 * record's `audioUrl`, so no separate audio route is needed.
 *
 * Private routes: the host dispatcher answers 401 for unauthenticated callers.
 */

import type {
	ArtifactShareGrantMode,
	Route,
	RouteHandlerContext,
	RouteHandlerResult,
	UUID,
} from "@elizaos/core";
import { isAdminRank } from "@elizaos/core";
import {
	type MeetingArtifact,
	type Transcript,
	type TranscriptScope,
	type TranscriptSegment,
	type TranscriptSource,
	transcriptDurationMs,
	transcriptSpeakerCount,
	validateMeetingArtifact,
} from "@elizaos/shared";
import {
	TranscriptService,
	type TranscriptServiceRuntime,
} from "../services/voice/transcript-service.js";
import { TranscriptStore } from "../services/voice/transcript-store.js";
import { persistTranscriptAudioWav } from "./transcript-audio-store.js";

function service(ctx: RouteHandlerContext): TranscriptService {
	return new TranscriptService(ctx.runtime as TranscriptServiceRuntime);
}

function store(ctx: RouteHandlerContext): TranscriptStore {
	return new TranscriptStore(ctx.runtime as TranscriptServiceRuntime);
}

/** The body a recording session POSTs to create a transcript record. */
export interface CreateTranscriptRequest {
	/** Optional — the route derives these from the agent context when absent (the
	 *  shell client doesn't carry world/room/entity ids). */
	worldId?: UUID;
	roomId?: UUID;
	entityId?: UUID;
	title?: string;
	source?: TranscriptSource;
	scope?: TranscriptScope;
	segments: TranscriptSegment[];
	audioUrl?: string;
	audioContentType?: string;
	/** Base64 WAV bytes — persisted to the media store; sets audioUrl. */
	audioBase64?: string;
	metadata?: Record<string, unknown>;
	/**
	 * Canonical meeting artifact persisted into transcript metadata after validation.
	 * Forward contract (#12487): the schema + validated write path exist, but no
	 * capture adapter (Zoom/Meet/local) emits this field yet, so it is optional and
	 * `undefined` skips validation — the existing transcript-create path is unchanged
	 * until a producer is wired.
	 */
	meetingArtifact?: MeetingArtifact;
	createdAt?: number;
}

/**
 * Build a full {@link Transcript} from a create request — derives duration +
 * speaker count from the segments, defaults title/scope/status. Pure (id + now
 * injected) so it is unit-testable.
 */
export function buildTranscriptFromRequest(
	body: CreateTranscriptRequest,
	id: string,
	now: number,
): Transcript {
	const segments = Array.isArray(body.segments) ? body.segments : [];
	const createdAt = body.createdAt ?? now;
	const metadata =
		body.meetingArtifact || body.metadata
			? {
					...(body.metadata ?? {}),
					...(body.meetingArtifact
						? { meetingArtifact: body.meetingArtifact }
						: {}),
				}
			: undefined;
	return {
		id,
		title: body.title?.trim() || defaultTitle(createdAt),
		createdAt,
		endedAt: now,
		durationMs: transcriptDurationMs(segments),
		audioUrl: body.audioUrl,
		audioContentType: body.audioContentType,
		segments,
		source: body.source ?? "voice-session",
		scope: body.scope ?? "owner-private",
		status: "ready",
		speakerCount: transcriptSpeakerCount(segments),
		...(metadata ? { metadata } : {}),
	};
}

function defaultTitle(createdAt: number): string {
	return `Recording ${new Date(createdAt).toLocaleString()}`;
}

const listRoute: Route = {
	type: "GET",
	path: "/api/transcripts",
	rawPath: true,
	routeHandler: async (ctx): Promise<RouteHandlerResult> => {
		const roomId = (ctx.query.roomId as string | undefined) || undefined;
		const transcripts = await service(ctx).list(
			roomId as UUID | undefined,
			undefined,
			ctx.accessContext,
		);
		return { status: 200, body: { transcripts } };
	},
};

const getRoute: Route = {
	type: "GET",
	path: "/api/transcripts/:id",
	rawPath: true,
	routeHandler: async (ctx): Promise<RouteHandlerResult> => {
		const transcript = await service(ctx).get(
			ctx.params.id as UUID,
			ctx.accessContext,
		);
		if (!transcript) return { status: 404, body: { error: "not found" } };
		return { status: 200, body: { transcript } };
	},
};

const deleteRoute: Route = {
	type: "DELETE",
	path: "/api/transcripts/:id",
	rawPath: true,
	routeHandler: async (ctx): Promise<RouteHandlerResult> => {
		const transcript = await service(ctx).get(
			ctx.params.id as UUID,
			ctx.accessContext,
		);
		if (!transcript) return { status: 404, body: { error: "not found" } };
		if (transcript.redacted) {
			return {
				status: 403,
				body: { error: "redacted transcript views cannot be deleted" },
			};
		}
		await service(ctx).delete(ctx.params.id as UUID);
		return { status: 200, body: { ok: true } };
	},
};

/** The body a transcript editor PUTs to persist a user edit. */
export interface UpdateTranscriptRequest {
	worldId?: UUID;
	roomId?: UUID;
	entityId?: UUID;
	title?: string;
	segments?: TranscriptSegment[];
}

export interface ShareTranscriptRequest {
	entityId?: UUID;
	mode?: ArtifactShareGrantMode;
}

const updateRoute: Route = {
	type: "PUT",
	path: "/api/transcripts/:id",
	rawPath: true,
	routeHandler: async (ctx): Promise<RouteHandlerResult> => {
		const body = (ctx.body ?? {}) as UpdateTranscriptRequest;
		if (body.title === undefined && body.segments === undefined) {
			return { status: 400, body: { error: "title or segments is required" } };
		}
		if (body.segments !== undefined && !Array.isArray(body.segments)) {
			return { status: 400, body: { error: "segments must be an array" } };
		}
		const existing = await service(ctx).get(
			ctx.params.id as UUID,
			ctx.accessContext,
		);
		if (!existing) return { status: 404, body: { error: "not found" } };
		if (existing.redacted) {
			return {
				status: 403,
				body: { error: "redacted transcript views cannot be edited" },
			};
		}
		const agentId = ctx.runtime.agentId as UUID;
		const updated = await service(ctx).update(ctx.params.id as UUID, {
			worldId: (body.worldId ?? agentId) as UUID,
			roomId: (body.roomId ?? agentId) as UUID,
			entityId: (body.entityId ?? agentId) as UUID,
			patch: { title: body.title, segments: body.segments },
		});
		if (!updated) return { status: 404, body: { error: "not found" } };
		return { status: 200, body: { transcript: updated } };
	},
};

const createRoute: Route = {
	type: "POST",
	path: "/api/transcripts",
	rawPath: true,
	routeHandler: async (ctx): Promise<RouteHandlerResult> => {
		const body = ctx.body as CreateTranscriptRequest | undefined;
		if (!body || !Array.isArray(body.segments) || body.segments.length === 0) {
			return { status: 400, body: { error: "segments are required" } };
		}
		if (body.meetingArtifact !== undefined) {
			const validation = validateMeetingArtifact(body.meetingArtifact);
			if (!validation.valid) {
				return {
					status: 400,
					body: {
						error: "meetingArtifact is invalid",
						errors: validation.errors,
					},
				};
			}
		}
		// The shell client doesn't carry world/room/entity ids — default them to
		// the agent context (single-user local) when not supplied.
		const agentId = ctx.runtime.agentId as UUID;
		// Persist the recorded session WAV into the served media store so the
		// player has audio to scrub. The shell sends base64 (it can't write files).
		if (body.audioBase64 && !body.audioUrl) {
			body.audioUrl = persistTranscriptAudioWav(
				Buffer.from(body.audioBase64, "base64"),
			);
			body.audioContentType = "audio/wav";
		}
		const transcript = buildTranscriptFromRequest(
			body,
			crypto.randomUUID(),
			Date.now(),
		);
		const saved = await service(ctx).create({
			worldId: (body.worldId ?? agentId) as UUID,
			roomId: (body.roomId ?? agentId) as UUID,
			entityId: (body.entityId ?? agentId) as UUID,
			transcript,
		});
		return { status: 201, body: { transcript: saved } };
	},
};

const shareRoute: Route = {
	type: "POST",
	path: "/api/transcripts/:id/share",
	rawPath: true,
	routeHandler: async (ctx): Promise<RouteHandlerResult> => {
		const body = (ctx.body ?? {}) as ShareTranscriptRequest;
		const entityId =
			typeof body.entityId === "string" && body.entityId.trim().length > 0
				? (body.entityId.trim() as UUID)
				: null;
		const mode = body.mode ?? "redacted";
		if (!entityId) {
			return { status: 400, body: { error: "entityId is required" } };
		}
		if (mode !== "full" && mode !== "redacted") {
			return { status: 400, body: { error: "mode must be full or redacted" } };
		}
		if (mode === "full" && !isAdminRank(ctx.accessContext?.role)) {
			return {
				status: 403,
				body: { error: "full transcript sharing requires ADMIN" },
			};
		}

		const transcript = await service(ctx).get(
			ctx.params.id as UUID,
			ctx.accessContext,
		);
		if (!transcript) return { status: 404, body: { error: "not found" } };
		if (transcript.redacted) {
			return {
				status: 403,
				body: { error: "redacted transcript views cannot be re-shared" },
			};
		}

		let variantId: string | undefined;
		const transcriptStore = store(ctx);
		if (mode === "redacted") {
			const variant = await transcriptStore.createRedactedVariant({
				originalId: ctx.params.id as UUID,
				redactedBy: ctx.accessContext?.requesterEntityId,
			});
			variantId = variant.id;
		}
		await transcriptStore.share({
			transcriptId: ctx.params.id as UUID,
			entityId,
			mode,
			grantedBy: ctx.accessContext?.requesterEntityId,
			grantedAtMs: Date.now(),
		});
		return {
			status: 200,
			body: {
				ok: true,
				transcriptId: ctx.params.id,
				entityId,
				mode,
				...(variantId ? { variantId } : {}),
			},
		};
	},
};

const revokeShareRoute: Route = {
	type: "DELETE",
	path: "/api/transcripts/:id/share/:entityId",
	rawPath: true,
	routeHandler: async (ctx): Promise<RouteHandlerResult> => {
		const transcript = await service(ctx).get(
			ctx.params.id as UUID,
			ctx.accessContext,
		);
		if (!transcript) return { status: 404, body: { error: "not found" } };
		if (transcript.redacted) {
			return {
				status: 403,
				body: { error: "redacted transcript views cannot revoke grants" },
			};
		}
		await store(ctx).revokeShare({
			transcriptId: ctx.params.id as UUID,
			entityId: ctx.params.entityId as UUID,
		});
		return {
			status: 200,
			body: {
				ok: true,
				transcriptId: ctx.params.id,
				entityId: ctx.params.entityId,
			},
		};
	},
};

export const transcriptsRoutes: Route[] = [
	listRoute,
	createRoute,
	getRoute,
	shareRoute,
	revokeShareRoute,
	updateRoute,
	deleteRoute,
];
