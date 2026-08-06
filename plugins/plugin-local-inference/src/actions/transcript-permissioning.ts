/**
 * Agent actions for transcript privacy operations. Transcript bytes stay
 * immutable: redaction creates a linked variant and sharing writes per-entity
 * grants on the original row so routes can disclose full or redacted content
 * through the existing artifact-disclosure predicate.
 */

import {
	type AccessContext,
	type Action,
	type ActionResult,
	type ArtifactShareGrantMode,
	detectPii,
	ElizaError,
	type HandlerCallback,
	hasRoleAccess,
	type IAgentRuntime,
	logger,
	type Memory,
	PII_ENTITY_RECOGNIZER_SERVICE,
	type PiiEntityRecognizer,
	type PiiEntityRecognizerService,
	type ProviderDataRecord,
	type UUID,
} from "@elizaos/core";
import type { PiiTextSpan } from "@elizaos/shared/audio-redaction";
import type {
	Transcript,
	TranscriptCaptureSharingState,
	TranscriptSharingState,
} from "@elizaos/shared/transcripts";
import { transcriptCapturePrivacyState } from "@elizaos/shared/transcripts";
import { TranscriptPrivacyService } from "../services/voice/transcript-privacy.js";
import type { TranscriptServiceRuntime } from "../services/voice/transcript-service.js";
import {
	TranscriptStore,
	type TranscriptStoreRuntime,
	transcriptConsentAllowsSharing,
	transcriptPiiRecognizer,
} from "../services/voice/transcript-store.js";

type RoleName = "USER" | "ADMIN";
const AUDIO_REDACTION_SERVICE_TYPE = "audio-redaction";
const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface HandlerOptions {
	parameters?: Record<string, unknown>;
}

interface TranscriptPermissioningInput {
	transcriptId: UUID;
	entityId?: UUID;
	roomId?: UUID;
	mode?: ArtifactShareGrantMode;
	redactForAll?: boolean;
}

interface AudioRedactionServiceLike {
	redactAndVerify(input: {
		originalAudioUrl: string;
		durationMs: number;
		words: Transcript["segments"][number]["words"];
		piiSpans: readonly PiiTextSpan[];
	}): Promise<{ url: string }>;
}

function paramsFromOptions(options: unknown): Record<string, unknown> {
	const maybe = options as HandlerOptions | undefined;
	return maybe?.parameters && typeof maybe.parameters === "object"
		? maybe.parameters
		: {};
}

function nonEmptyString(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: null;
}

function parseMode(value: unknown): ArtifactShareGrantMode | null {
	return value === "full" || value === "redacted" ? value : null;
}

function parseUuid(value: unknown): UUID | null {
	const text = nonEmptyString(value);
	return text && UUID_PATTERN.test(text) ? (text as UUID) : null;
}

function parseInput(
	parameters: Record<string, unknown>,
	options: {
		allowTarget?: boolean;
		defaultMode?: ArtifactShareGrantMode;
	},
): TranscriptPermissioningInput | null {
	const transcriptId = parseUuid(parameters.transcriptId);
	if (!transcriptId) return null;
	const entityId = parseUuid(parameters.entityId);
	const roomId = parseUuid(parameters.roomId);
	if (parameters.entityId !== undefined && !entityId) return null;
	if (parameters.roomId !== undefined && !roomId) return null;
	if (
		parameters.redactForAll !== undefined &&
		typeof parameters.redactForAll !== "boolean"
	) {
		return null;
	}
	const redactForAll = parameters.redactForAll === true;
	const targetCount =
		Number(Boolean(entityId)) + Number(Boolean(roomId)) + Number(redactForAll);
	if (options.allowTarget && targetCount !== 1) return null;
	if (!options.allowTarget && targetCount !== 0) return null;
	const mode = parseMode(parameters.mode) ?? options.defaultMode;
	if (parameters.mode !== undefined && !parseMode(parameters.mode)) return null;
	return {
		transcriptId: transcriptId as UUID,
		...(entityId ? { entityId: entityId as UUID } : {}),
		...(roomId ? { roomId: roomId as UUID } : {}),
		...(mode ? { mode } : {}),
		...(redactForAll ? { redactForAll: true } : {}),
	};
}

function transcriptStore(runtime: IAgentRuntime): TranscriptStore {
	return new TranscriptStore(runtime as TranscriptStoreRuntime);
}

function runtimePiiRecognizer(
	runtime: IAgentRuntime,
): PiiEntityRecognizer | undefined {
	const service = runtime.getService(
		PII_ENTITY_RECOGNIZER_SERVICE,
	) as Partial<PiiEntityRecognizerService> | null;
	return service?.getRecognizer?.() ?? undefined;
}

async function transcriptPiiSpans(
	transcript: Transcript,
	recognizer?: PiiEntityRecognizer,
): Promise<PiiTextSpan[]> {
	const unique = new Map<string, PiiTextSpan>();
	const corpus = transcript.segments.map((segment) => segment.text).join("\n");
	for (const segment of transcript.segments) {
		for (const match of detectPii(segment.text)) {
			const key = `${match.kind}\u0000${match.value.toLocaleLowerCase()}`;
			unique.set(key, { text: match.value, label: match.kind });
		}
	}
	for (const span of await transcriptPiiRecognizer(
		transcript,
		recognizer,
	).recognize(corpus)) {
		const value = span.value.trim();
		if (!value) continue;
		const key = `${span.kind}\u0000${value.toLocaleLowerCase()}`;
		unique.set(key, { text: value, label: span.kind });
	}
	return [...unique.values()];
}

async function verifiedRedactedAudioUrl(
	runtime: IAgentRuntime,
	transcript: Transcript,
	recognizer?: PiiEntityRecognizer,
): Promise<string | undefined> {
	if (!transcript.audioUrl) return undefined;
	const piiSpans = await transcriptPiiSpans(transcript, recognizer);
	// A redacted grant must never reuse the original capability URL. With no
	// detector verdict there is nothing safe to transform, so audio is withheld.
	if (piiSpans.length === 0) return undefined;
	const service = runtime.getService(
		AUDIO_REDACTION_SERVICE_TYPE,
	) as AudioRedactionServiceLike | null;
	if (!service) {
		throw new ElizaError(
			"verified audio redaction service is unavailable; refusing to create an audio-bearing redacted variant",
			{ code: "AUDIO_REDACTION_VERIFY_UNAVAILABLE" },
		);
	}
	const result = await service.redactAndVerify({
		originalAudioUrl: transcript.audioUrl,
		durationMs: transcript.durationMs,
		words: transcript.segments.flatMap((segment) => segment.words),
		piiSpans,
	});
	return result.url;
}

function isRedactedVariantRow(row: Memory | null | undefined): boolean {
	const metadata = row?.metadata as Record<string, unknown> | undefined;
	return typeof metadata?.redactionOf === "string";
}

function hasTranscriptRoleAccess(
	runtime: IAgentRuntime,
	message: Memory,
	requiredRole: RoleName,
): Promise<boolean> {
	return hasRoleAccess(runtime, message, requiredRole);
}

async function canManageTranscript(
	runtime: IAgentRuntime,
	message: Memory,
	transcriptId: UUID,
): Promise<boolean> {
	if (await hasTranscriptRoleAccess(runtime, message, "ADMIN")) return true;
	if (!(await hasTranscriptRoleAccess(runtime, message, "USER"))) return false;
	const row = await (runtime as TranscriptStoreRuntime).getMemoryById(
		transcriptId,
	);
	if (isRedactedVariantRow(row)) return false;
	return row?.entityId === message.entityId;
}

async function accessContextForMessage(
	runtime: IAgentRuntime,
	message: Memory,
	transcriptId: UUID,
): Promise<AccessContext | undefined> {
	if (typeof message.entityId !== "string" || message.entityId.length === 0) {
		return undefined;
	}
	const isAdmin = await hasTranscriptRoleAccess(runtime, message, "ADMIN");
	const row = await (runtime as TranscriptStoreRuntime).getMemoryById(
		transcriptId,
	);
	return {
		requesterEntityId: message.entityId as UUID,
		...(typeof message.worldId === "string"
			? { worldId: message.worldId as UUID }
			: {}),
		role: isAdmin ? "ADMIN" : "USER",
		isOwner: row?.entityId === message.entityId,
		...(typeof message.content?.source === "string"
			? { source: message.content.source }
			: {}),
	};
}

function fail(error: string, text: string): ActionResult {
	return { success: false, error, text, data: { error } };
}

function ok(text: string, data: ProviderDataRecord): ActionResult {
	return {
		success: true,
		text,
		userFacingText: text,
		verifiedUserFacing: true,
		data,
	};
}

function auditDenied(
	runtime: IAgentRuntime,
	action: string,
	message: Memory,
	input: TranscriptPermissioningInput | null,
): void {
	const error = new Error(`${action} denied`);
	runtime.reportError("TranscriptPermissioningDenied", error, {
		action,
		transcriptId: input?.transcriptId,
		entityId: input?.entityId,
		roomId: input?.roomId,
		redactForAll: input?.redactForAll,
		requesterEntityId: message.entityId,
	});
	logger.warn(
		{
			action,
			transcriptId: input?.transcriptId,
			entityId: input?.entityId,
			roomId: input?.roomId,
			redactForAll: input?.redactForAll,
			requesterEntityId: message.entityId,
		},
		"[transcript-permissioning] denied transcript privacy action",
	);
}

function participantEntityIds(transcript: Transcript): UUID[] {
	const participants = transcript.metadata?.participants;
	if (!Array.isArray(participants)) return [];
	const ids = new Set<UUID>();
	for (const participant of participants) {
		if (!participant || typeof participant !== "object") continue;
		const entityId = parseUuid(
			(participant as { entityId?: unknown }).entityId,
		);
		if (entityId) ids.add(entityId);
	}
	return [...ids];
}

async function requireFullTranscript(
	runtime: IAgentRuntime,
	store: TranscriptStore,
	transcriptId: UUID,
	accessContext: AccessContext | undefined,
): Promise<ActionResult | null> {
	const transcript = await store.get(transcriptId, accessContext);
	const row = await (runtime as TranscriptStoreRuntime).getMemoryById(
		transcriptId,
	);
	if (isRedactedVariantRow(row)) {
		return fail(
			"TRANSCRIPT_REDACTED_VIEW",
			"Only an original transcript can be redacted or shared.",
		);
	}
	if (!transcript) {
		return fail(
			"TRANSCRIPT_NOT_ACCESSIBLE",
			"Transcript not found or not accessible.",
		);
	}
	if (transcript.redacted) {
		return fail(
			"TRANSCRIPT_REDACTED_VIEW",
			"Only a full transcript can be redacted or shared.",
		);
	}
	return null;
}

export const redactTranscriptAction: Action = {
	name: "REDACT_TRANSCRIPT",
	similes: [
		"REDACT_MEETING_TRANSCRIPT",
		"CREATE_REDACTED_TRANSCRIPT",
		"ANONYMIZE_TRANSCRIPT",
	],
	description:
		"Create or refresh the redacted variant for a stored meeting transcript. The original stays unchanged; any variant audio is published only after fail-closed PII redaction verification.",
	routingHint:
		"user asks to redact/anonymize a meeting transcript -> REDACT_TRANSCRIPT; do not edit the original transcript text",
	roleGate: { minRole: "USER" },
	parameters: [
		{
			name: "transcriptId",
			description: "Stored transcript id to redact.",
			required: true,
			schema: { type: "string" as const },
		},
	],
	validate: async () => true,
	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state?: unknown,
		options?: unknown,
		callback?: HandlerCallback,
	): Promise<ActionResult> => {
		const input = parseInput(paramsFromOptions(options), {
			allowTarget: false,
		});
		if (!input) {
			const result = fail(
				"REDACT_TRANSCRIPT_INVALID",
				"REDACT_TRANSCRIPT requires a valid transcriptId.",
			);
			await callback?.({ text: result.text, actions: ["REDACT_TRANSCRIPT"] });
			return result;
		}
		if (!(await canManageTranscript(runtime, message, input.transcriptId))) {
			auditDenied(runtime, "REDACT_TRANSCRIPT", message, input);
			const result = fail(
				"REDACT_TRANSCRIPT_DENIED",
				"You do not have permission to redact that transcript.",
			);
			await callback?.({ text: result.text, actions: ["REDACT_TRANSCRIPT"] });
			return result;
		}

		try {
			const store = transcriptStore(runtime);
			const accessContext = await accessContextForMessage(
				runtime,
				message,
				input.transcriptId,
			);
			const denied = await requireFullTranscript(
				runtime,
				store,
				input.transcriptId,
				accessContext,
			);
			if (denied) {
				auditDenied(runtime, "REDACT_TRANSCRIPT", message, input);
				await callback?.({ text: denied.text, actions: ["REDACT_TRANSCRIPT"] });
				return denied;
			}
			const original = await store.get(input.transcriptId, accessContext);
			if (!original) {
				throw new ElizaError("full transcript disappeared during redaction", {
					code: "TRANSCRIPT_NOT_ACCESSIBLE",
				});
			}
			const recognizer = runtimePiiRecognizer(runtime);
			const redactedAudioUrl = await verifiedRedactedAudioUrl(
				runtime,
				original,
				recognizer,
			);
			await store.createRedactedVariant({
				originalId: input.transcriptId,
				redactedBy: message.entityId as UUID,
				...(redactedAudioUrl ? { redactedAudioUrl } : {}),
				...(recognizer ? { recognizer } : {}),
			});
			const result = ok("Redacted transcript variant is ready.", {
				actionName: "REDACT_TRANSCRIPT",
				transcriptId: input.transcriptId,
				redacted: true,
				hasAudio: redactedAudioUrl !== undefined,
			});
			await callback?.({ text: result.text, actions: ["REDACT_TRANSCRIPT"] });
			return result;
		} catch (error) {
			// error-policy:J1 action boundary returns a structured failure to the planner loop.
			const messageText =
				error instanceof Error ? error.message : String(error);
			const result = fail("REDACT_TRANSCRIPT_FAILED", messageText);
			await callback?.({ text: result.text, actions: ["REDACT_TRANSCRIPT"] });
			return result;
		}
	},
	examples: [],
};

export const shareTranscriptAction: Action = {
	name: "SHARE_TRANSCRIPT",
	similes: [
		"SHARE_MEETING_TRANSCRIPT",
		"GRANT_TRANSCRIPT_ACCESS",
		"DISCLOSE_TRANSCRIPT",
	],
	description:
		"Share a stored transcript with one entity or a persisted room-roster snapshot as full or redacted content. Admin redact-for-all snapshots the room and grants every participant the redacted variant.",
	routingHint:
		"user asks to share a meeting transcript -> SHARE_TRANSCRIPT with entityId and mode full|redacted; admin redacted-for-all uses redacted mode for non-privileged grants",
	roleGate: { minRole: "USER" },
	parameters: [
		{
			name: "transcriptId",
			description: "Stored original transcript id to share.",
			required: true,
			schema: { type: "string" as const },
		},
		{
			name: "entityId",
			description: "Entity id receiving the transcript grant.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "roomId",
			description:
				"Meeting room id whose current persisted participant roster receives grants.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "redactForAll",
			description:
				"Admin-only: grant the redacted variant to every persisted meeting participant.",
			required: false,
			schema: { type: "boolean" as const, default: false },
		},
		{
			name: "mode",
			description:
				"Disclosure mode. Use redacted for ordinary participants; full requires admin access.",
			required: false,
			schema: {
				type: "string" as const,
				enum: ["redacted", "full"],
				default: "redacted",
			},
		},
	],
	validate: async () => true,
	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state?: unknown,
		options?: unknown,
		callback?: HandlerCallback,
	): Promise<ActionResult> => {
		const input = parseInput(paramsFromOptions(options), {
			allowTarget: true,
			defaultMode: "redacted",
		});
		if (!input?.mode || (input.redactForAll && input.mode !== "redacted")) {
			const result = fail(
				"SHARE_TRANSCRIPT_INVALID",
				"SHARE_TRANSCRIPT requires a valid transcriptId, exactly one of entityId, roomId, or redactForAll, and mode full or redacted.",
			);
			await callback?.({ text: result.text, actions: ["SHARE_TRANSCRIPT"] });
			return result;
		}

		const requiresAdmin = input.mode === "full" || input.redactForAll === true;
		const canShare = requiresAdmin
			? await hasTranscriptRoleAccess(runtime, message, "ADMIN")
			: await canManageTranscript(runtime, message, input.transcriptId);
		if (!canShare) {
			auditDenied(runtime, "SHARE_TRANSCRIPT", message, input);
			const result = fail(
				"SHARE_TRANSCRIPT_DENIED",
				requiresAdmin
					? "Only an admin can share the full transcript or redact it for everyone."
					: "You do not have permission to share that transcript.",
			);
			await callback?.({ text: result.text, actions: ["SHARE_TRANSCRIPT"] });
			return result;
		}

		try {
			const store = transcriptStore(runtime);
			const accessContext = await accessContextForMessage(
				runtime,
				message,
				input.transcriptId,
			);
			const denied = await requireFullTranscript(
				runtime,
				store,
				input.transcriptId,
				accessContext,
			);
			if (denied) {
				auditDenied(runtime, "SHARE_TRANSCRIPT", message, input);
				await callback?.({ text: denied.text, actions: ["SHARE_TRANSCRIPT"] });
				return denied;
			}
			const original = await store.get(input.transcriptId, accessContext);
			if (!original) {
				throw new ElizaError("full transcript disappeared during sharing", {
					code: "TRANSCRIPT_NOT_ACCESSIBLE",
				});
			}
			if (!transcriptConsentAllowsSharing(original)) {
				const result = fail(
					"SHARE_TRANSCRIPT_CONSENT_REQUIRED",
					"The persisted consent state does not permit sharing this transcript.",
				);
				await callback?.({ text: result.text, actions: ["SHARE_TRANSCRIPT"] });
				return result;
			}
			const row = await (runtime as TranscriptStoreRuntime).getMemoryById(
				input.transcriptId,
			);
			if (!row) {
				throw new ElizaError("transcript row disappeared during sharing", {
					code: "TRANSCRIPT_NOT_ACCESSIBLE",
				});
			}
			const roomTarget =
				input.roomId ?? (input.redactForAll ? row.roomId : null);
			const roomEntityIds = roomTarget ? participantEntityIds(original) : [];
			if (roomTarget && row.roomId !== roomTarget) {
				const result = fail(
					"SHARE_TRANSCRIPT_ROOM_MISMATCH",
					"The requested room does not own this transcript.",
				);
				await callback?.({ text: result.text, actions: ["SHARE_TRANSCRIPT"] });
				return result;
			}
			if (roomTarget && roomEntityIds.length === 0) {
				const result = fail(
					"SHARE_TRANSCRIPT_ROOM_EMPTY",
					"The persisted meeting roster has no resolved participant entities to share with.",
				);
				await callback?.({ text: result.text, actions: ["SHARE_TRANSCRIPT"] });
				return result;
			}
			if (input.mode === "redacted") {
				const recognizer = runtimePiiRecognizer(runtime);
				const redactedAudioUrl = await verifiedRedactedAudioUrl(
					runtime,
					original,
					recognizer,
				);
				await store.createRedactedVariant({
					originalId: input.transcriptId,
					redactedBy: message.entityId as UUID,
					...(redactedAudioUrl ? { redactedAudioUrl } : {}),
					...(recognizer ? { recognizer } : {}),
				});
			}
			const grantedAtMs = Date.now();
			if (roomTarget) {
				await store.shareRoomSnapshot({
					transcriptId: input.transcriptId,
					roomId: roomTarget,
					entityIds: roomEntityIds,
					mode: input.redactForAll ? "redacted" : input.mode,
					grantedBy: message.entityId as UUID,
					grantedAtMs,
				});
			} else if (input.entityId) {
				await store.share({
					transcriptId: input.transcriptId,
					entityId: input.entityId,
					mode: input.mode,
					grantedBy: message.entityId as UUID,
					grantedAtMs,
				});
			}
			const resultMode = input.redactForAll ? "redacted" : input.mode;
			const result = ok(
				input.redactForAll
					? "Shared the redacted transcript with the persisted meeting roster."
					: input.mode === "full"
						? "Shared the full transcript."
						: "Shared the redacted transcript.",
				{
					actionName: "SHARE_TRANSCRIPT",
					transcriptId: input.transcriptId,
					...(input.entityId ? { entityId: input.entityId } : {}),
					...(roomTarget ? { roomId: roomTarget } : {}),
					...(roomTarget ? { entityCount: roomEntityIds.length } : {}),
					...(input.redactForAll ? { redactForAll: true } : {}),
					mode: resultMode,
				},
			);
			await callback?.({ text: result.text, actions: ["SHARE_TRANSCRIPT"] });
			return result;
		} catch (error) {
			// error-policy:J1 action boundary returns a structured failure to the planner loop.
			const messageText =
				error instanceof Error ? error.message : String(error);
			const result = fail("SHARE_TRANSCRIPT_FAILED", messageText);
			await callback?.({ text: result.text, actions: ["SHARE_TRANSCRIPT"] });
			return result;
		}
	},
	examples: [],
};

const MANAGEABLE_ARTIFACTS = [
	"transcript",
	"notes",
	"sourceAudio",
	"artifacts",
] as const;
const MANAGEABLE_SHARING_STATES = [
	"owner_private",
	"restricted",
	"shared",
	"disabled",
] as const;

/** Semantic twin for the Transcripts view's artifact privacy controls. */
export const manageTranscriptPrivacyAction: Action = {
	name: "MANAGE_TRANSCRIPT_PRIVACY",
	similes: [
		"SET_TRANSCRIPT_ARTIFACT_VISIBILITY",
		"DELETE_TRANSCRIPT_SOURCE_AUDIO",
		"MANAGE_MEETING_RETENTION",
	],
	description:
		"Change one retained meeting artifact's visibility, or permanently delete source audio while preserving the transcript.",
	routingHint:
		"user asks to make transcript/notes/source audio/generated artifacts private, restricted, shared, disabled, or asks to delete retained meeting audio",
	roleGate: { minRole: "USER" },
	parameters: [
		{
			name: "transcriptId",
			description: "Stored original transcript id.",
			required: true,
			schema: { type: "string" as const },
		},
		{
			name: "artifact",
			description: "Artifact whose visibility changes.",
			required: false,
			schema: { type: "string" as const, enum: [...MANAGEABLE_ARTIFACTS] },
		},
		{
			name: "state",
			description: "New artifact visibility.",
			required: false,
			schema: {
				type: "string" as const,
				enum: [...MANAGEABLE_SHARING_STATES],
			},
		},
		{
			name: "deleteSourceAudio",
			description:
				"Permanently delete retained source audio while keeping transcript text.",
			required: false,
			schema: { type: "boolean" as const, default: false },
		},
	],
	validate: async () => true,
	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state?: unknown,
		options?: unknown,
		callback?: HandlerCallback,
	): Promise<ActionResult> => {
		const params = paramsFromOptions(options);
		const transcriptId = parseUuid(params.transcriptId);
		const artifact = MANAGEABLE_ARTIFACTS.find(
			(value) => value === params.artifact,
		);
		const state = MANAGEABLE_SHARING_STATES.find(
			(value) => value === params.state,
		) as TranscriptSharingState | undefined;
		const deleteSourceAudio = params.deleteSourceAudio === true;
		if (
			!transcriptId ||
			(deleteSourceAudio
				? artifact !== undefined || state !== undefined
				: !artifact || !state)
		) {
			const result = fail(
				"MANAGE_TRANSCRIPT_PRIVACY_INVALID",
				"Provide transcriptId and either artifact+state, or deleteSourceAudio=true.",
			);
			await callback?.({
				text: result.text,
				actions: ["MANAGE_TRANSCRIPT_PRIVACY"],
			});
			return result;
		}
		if (!(await canManageTranscript(runtime, message, transcriptId))) {
			const result = fail(
				"MANAGE_TRANSCRIPT_PRIVACY_DENIED",
				"You do not have permission to manage that transcript.",
			);
			await callback?.({
				text: result.text,
				actions: ["MANAGE_TRANSCRIPT_PRIVACY"],
			});
			return result;
		}

		try {
			const privacy = new TranscriptPrivacyService(
				runtime as TranscriptServiceRuntime,
			);
			const transcript = deleteSourceAudio
				? await privacy.deleteSourceAudio(transcriptId)
				: await privacy.updateArtifactSharing(transcriptId, {
						[artifact as keyof TranscriptCaptureSharingState]: state,
					});
			const result = ok(
				deleteSourceAudio
					? "Deleted the source audio and retained the transcript."
					: `Updated ${artifact} visibility to ${state}.`,
				{
					actionName: "MANAGE_TRANSCRIPT_PRIVACY",
					transcriptId,
					...(deleteSourceAudio
						? { sourceAudioDeleted: true }
						: { artifact, state }),
					...(transcriptCapturePrivacyState(transcript).retentionState
						? {
								retentionState:
									transcriptCapturePrivacyState(transcript).retentionState,
							}
						: {}),
				},
			);
			await callback?.({
				text: result.text,
				actions: ["MANAGE_TRANSCRIPT_PRIVACY"],
			});
			return result;
		} catch (error) {
			// error-policy:J1 action boundary returns a structured failure to the planner loop.
			const result = fail(
				"MANAGE_TRANSCRIPT_PRIVACY_FAILED",
				error instanceof Error ? error.message : String(error),
			);
			await callback?.({
				text: result.text,
				actions: ["MANAGE_TRANSCRIPT_PRIVACY"],
			});
			return result;
		}
	},
	examples: [],
};
