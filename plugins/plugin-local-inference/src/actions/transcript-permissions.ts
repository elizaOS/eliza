/**
 * Transcript permissioning actions for variant-based redaction and per-viewer
 * sharing. They are intentionally thin: authorization is checked at the action
 * boundary, then the durable write goes through TranscriptStore so route,
 * provider, and future UI paths all read the same metadata contract.
 */

import {
	type Action,
	type ActionResult,
	type HandlerCallback,
	hasRoleAccess,
	type IAgentRuntime,
	logger,
	type Memory,
	type UUID,
} from "@elizaos/core";
import {
	TranscriptStore,
	type TranscriptStoreRuntime,
} from "../services/voice/transcript-store.js";

type TranscriptPermissionRuntime = IAgentRuntime & TranscriptStoreRuntime;

type ActionParams = Record<string, unknown>;

function actionParams(options: unknown): ActionParams {
	const direct = options && typeof options === "object" ? options : {};
	const parameters =
		"parameters" in direct &&
		direct.parameters &&
		typeof direct.parameters === "object"
			? (direct.parameters as Record<string, unknown>)
			: {};
	return { ...(direct as Record<string, unknown>), ...parameters };
}

function stringParam(params: ActionParams, key: string): string | null {
	const value = params[key];
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: null;
}

function transcriptIdFrom(params: ActionParams, message: Memory): UUID | null {
	const value =
		stringParam(params, "transcriptId") ??
		stringParam(params, "id") ??
		(typeof message.content.transcriptId === "string"
			? message.content.transcriptId.trim()
			: null);
	return value ? (value as UUID) : null;
}

function shareModeFrom(params: ActionParams): "full" | "redacted" | null {
	const raw = stringParam(params, "mode") ?? stringParam(params, "shareMode");
	if (raw === "full" || raw === "redacted") return raw;
	return null;
}

function logDenied(
	action: string,
	reason: string,
	context: Record<string, unknown>,
): void {
	logger.warn({ action, reason, ...context }, `[${action}] denied`);
}

async function isOwnTranscript(
	runtime: TranscriptPermissionRuntime,
	transcriptId: UUID,
	message: Memory,
): Promise<boolean> {
	const row = await runtime.getMemoryById(transcriptId);
	if (!row) return false;
	return row.entityId === message.entityId;
}

async function canManageTranscript(
	runtime: TranscriptPermissionRuntime,
	message: Memory,
	transcriptId: UUID,
): Promise<boolean> {
	if (await isOwnTranscript(runtime, transcriptId, message)) return true;
	return hasRoleAccess(runtime, message, "ADMIN");
}

async function redactHandler(
	runtime: IAgentRuntime,
	message: Memory,
	_state?: unknown,
	options?: unknown,
	callback?: HandlerCallback,
): Promise<ActionResult> {
	const rt = runtime as TranscriptPermissionRuntime;
	const params = actionParams(options);
	const transcriptId = transcriptIdFrom(params, message);
	if (!transcriptId) {
		const text = "Transcript id is required.";
		await callback?.({ text, actions: ["REDACT_TRANSCRIPT_FAILED"] });
		return { success: false, text, error: "TRANSCRIPT_ID_REQUIRED" };
	}

	if (!(await canManageTranscript(rt, message, transcriptId))) {
		logDenied("REDACT_TRANSCRIPT", "insufficient_role", {
			transcriptId,
			entityId: message.entityId,
		});
		const text = "You do not have permission to redact that transcript.";
		await callback?.({ text, actions: ["REDACT_TRANSCRIPT_DENIED"] });
		return { success: false, text, error: "TRANSCRIPT_REDACTION_DENIED" };
	}

	const variant = await new TranscriptStore(rt).createRedactedVariant({
		originalId: transcriptId,
		redactedBy: message.entityId as UUID,
	});
	const text = "Created a redacted transcript variant.";
	await callback?.({ text, actions: ["REDACT_TRANSCRIPT_SUCCESS"] });
	return {
		success: true,
		text,
		data: {
			actionName: "REDACT_TRANSCRIPT",
			transcriptId,
			redactedVariantId: variant.id,
		},
	};
}

async function shareHandler(
	runtime: IAgentRuntime,
	message: Memory,
	_state?: unknown,
	options?: unknown,
	callback?: HandlerCallback,
): Promise<ActionResult> {
	const rt = runtime as TranscriptPermissionRuntime;
	const params = actionParams(options);
	const transcriptId = transcriptIdFrom(params, message);
	const targetEntityId = stringParam(params, "entityId") as UUID | null;
	const mode = shareModeFrom(params) ?? "redacted";
	if (!transcriptId || !targetEntityId) {
		const text = "Transcript id and target entity id are required.";
		await callback?.({ text, actions: ["SHARE_TRANSCRIPT_FAILED"] });
		return { success: false, text, error: "TRANSCRIPT_SHARE_PARAMS_REQUIRED" };
	}

	const hasAdmin = await hasRoleAccess(rt, message, "ADMIN");
	if (mode === "full" && !hasAdmin) {
		logDenied("SHARE_TRANSCRIPT", "full_grant_requires_admin", {
			transcriptId,
			targetEntityId,
			entityId: message.entityId,
		});
		const text = "Only an admin can share the full transcript.";
		await callback?.({ text, actions: ["SHARE_TRANSCRIPT_DENIED"] });
		return { success: false, text, error: "TRANSCRIPT_FULL_SHARE_DENIED" };
	}
	if (!hasAdmin && !(await isOwnTranscript(rt, transcriptId, message))) {
		logDenied("SHARE_TRANSCRIPT", "insufficient_role", {
			transcriptId,
			targetEntityId,
			entityId: message.entityId,
		});
		const text = "You do not have permission to share that transcript.";
		await callback?.({ text, actions: ["SHARE_TRANSCRIPT_DENIED"] });
		return { success: false, text, error: "TRANSCRIPT_SHARE_DENIED" };
	}

	if (mode === "redacted") {
		await new TranscriptStore(rt).createRedactedVariant({
			originalId: transcriptId,
			redactedBy: message.entityId as UUID,
		});
	}
	await new TranscriptStore(rt).share({
		transcriptId,
		entityId: targetEntityId,
		mode,
		grantedBy: message.entityId as UUID,
		grantedAtMs: Date.now(),
	});
	const text =
		mode === "full"
			? "Shared the full transcript."
			: "Shared the redacted transcript.";
	await callback?.({ text, actions: ["SHARE_TRANSCRIPT_SUCCESS"] });
	return {
		success: true,
		text,
		data: {
			actionName: "SHARE_TRANSCRIPT",
			transcriptId,
			targetEntityId,
			mode,
		},
	};
}

async function validate(
	_runtime: IAgentRuntime,
	message: Memory,
): Promise<boolean> {
	return typeof message.content.text === "string"
		? message.content.text.trim().length > 0
		: Boolean(message.content.transcriptId);
}

export const redactTranscriptAction: Action = {
	name: "REDACT_TRANSCRIPT",
	similes: ["TRANSCRIPT_REDACTION", "CREATE_REDACTED_TRANSCRIPT"],
	description:
		"Create a deterministic redacted variant for a stored transcript without mutating the original transcript or audio.",
	routingHint:
		"redact a stored meeting/voice transcript before sharing it -> REDACT_TRANSCRIPT",
	roleGate: { minRole: "USER" },
	validate,
	handler: redactHandler,
	parameters: [
		{
			name: "transcriptId",
			description: "Stored transcript id to redact.",
			required: true,
			schema: { type: "string" as const },
		},
	],
	examples: [],
};

export const shareTranscriptAction: Action = {
	name: "SHARE_TRANSCRIPT",
	similes: ["GRANT_TRANSCRIPT_ACCESS", "SHARE_REDACTED_TRANSCRIPT"],
	description:
		"Grant a person access to a transcript. USER can share their own redacted transcript; ADMIN can grant full access.",
	routingHint:
		"share a stored meeting/voice transcript with a person, redacted by default -> SHARE_TRANSCRIPT",
	roleGate: { minRole: "USER" },
	validate,
	handler: shareHandler,
	parameters: [
		{
			name: "transcriptId",
			description: "Stored transcript id to share.",
			required: true,
			schema: { type: "string" as const },
		},
		{
			name: "entityId",
			description: "Target entity id receiving the grant.",
			required: true,
			schema: { type: "string" as const },
		},
		{
			name: "mode",
			description: "Grant mode: redacted or full. Defaults to redacted.",
			required: false,
			schema: {
				type: "string" as const,
				enum: ["redacted", "full"],
				default: "redacted",
			},
		},
	],
	examples: [],
};
