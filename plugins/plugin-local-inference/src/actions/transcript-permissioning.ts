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
	type ProviderDataRecord,
	type UUID,
} from "@elizaos/core";
import type { PiiTextSpan } from "@elizaos/shared/audio-redaction";
import type { Transcript } from "@elizaos/shared/transcripts";
import {
	TranscriptStore,
	type TranscriptStoreRuntime,
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
	mode?: ArtifactShareGrantMode;
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
	options: { requireEntity: boolean; defaultMode?: ArtifactShareGrantMode },
): TranscriptPermissioningInput | null {
	const transcriptId = parseUuid(parameters.transcriptId);
	if (!transcriptId) return null;
	const entityId = parseUuid(parameters.entityId);
	if (options.requireEntity && !entityId) return null;
	const mode = parseMode(parameters.mode) ?? options.defaultMode;
	if (parameters.mode !== undefined && !parseMode(parameters.mode)) return null;
	return {
		transcriptId: transcriptId as UUID,
		...(entityId ? { entityId: entityId as UUID } : {}),
		...(mode ? { mode } : {}),
	};
}

function transcriptStore(runtime: IAgentRuntime): TranscriptStore {
	return new TranscriptStore(runtime as TranscriptStoreRuntime);
}

function transcriptPiiSpans(transcript: Transcript): PiiTextSpan[] {
	const unique = new Map<string, PiiTextSpan>();
	for (const segment of transcript.segments) {
		for (const match of detectPii(segment.text)) {
			const key = `${match.kind}\u0000${match.value.toLocaleLowerCase()}`;
			unique.set(key, { text: match.value, label: match.kind });
		}
	}
	return [...unique.values()];
}

async function verifiedRedactedAudioUrl(
	runtime: IAgentRuntime,
	transcript: Transcript,
): Promise<string | undefined> {
	if (!transcript.audioUrl) return undefined;
	const piiSpans = transcriptPiiSpans(transcript);
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
		requesterEntityId: message.entityId,
	});
	logger.warn(
		{
			action,
			transcriptId: input?.transcriptId,
			entityId: input?.entityId,
			requesterEntityId: message.entityId,
		},
		"[transcript-permissioning] denied transcript privacy action",
	);
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
			requireEntity: false,
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
			const redactedAudioUrl = await verifiedRedactedAudioUrl(
				runtime,
				original,
			);
			await store.createRedactedVariant({
				originalId: input.transcriptId,
				redactedBy: message.entityId as UUID,
				...(redactedAudioUrl ? { redactedAudioUrl } : {}),
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
		"Share a stored transcript with one entity as full or redacted content. Redacted sharing creates the linked redacted variant first; full sharing requires admin access.",
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
			required: true,
			schema: { type: "string" as const },
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
			requireEntity: true,
			defaultMode: "redacted",
		});
		if (!input?.entityId || !input.mode) {
			const result = fail(
				"SHARE_TRANSCRIPT_INVALID",
				"SHARE_TRANSCRIPT requires valid transcriptId, entityId, and mode full or redacted.",
			);
			await callback?.({ text: result.text, actions: ["SHARE_TRANSCRIPT"] });
			return result;
		}

		const canShare =
			input.mode === "full"
				? await hasTranscriptRoleAccess(runtime, message, "ADMIN")
				: await canManageTranscript(runtime, message, input.transcriptId);
		if (!canShare) {
			auditDenied(runtime, "SHARE_TRANSCRIPT", message, input);
			const result = fail(
				"SHARE_TRANSCRIPT_DENIED",
				input.mode === "full"
					? "Only an admin can share the full transcript."
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
			if (input.mode === "redacted") {
				const original = await store.get(input.transcriptId, accessContext);
				if (!original) {
					throw new ElizaError("full transcript disappeared during sharing", {
						code: "TRANSCRIPT_NOT_ACCESSIBLE",
					});
				}
				const redactedAudioUrl = await verifiedRedactedAudioUrl(
					runtime,
					original,
				);
				await store.createRedactedVariant({
					originalId: input.transcriptId,
					redactedBy: message.entityId as UUID,
					...(redactedAudioUrl ? { redactedAudioUrl } : {}),
				});
			}
			await store.share({
				transcriptId: input.transcriptId,
				entityId: input.entityId,
				mode: input.mode,
				grantedBy: message.entityId as UUID,
				grantedAtMs: Date.now(),
			});
			const result = ok(
				input.mode === "full"
					? "Shared the full transcript."
					: "Shared the redacted transcript.",
				{
					actionName: "SHARE_TRANSCRIPT",
					transcriptId: input.transcriptId,
					entityId: input.entityId,
					mode: input.mode,
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
