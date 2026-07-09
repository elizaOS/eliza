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
	type HandlerCallback,
	hasRoleAccess,
	type IAgentRuntime,
	logger,
	type Memory,
	type ProviderDataRecord,
	type UUID,
} from "@elizaos/core";
import {
	TranscriptStore,
	type TranscriptStoreRuntime,
} from "../services/voice/transcript-store.js";

type RoleName = "USER" | "ADMIN";

export type RoleAccessCheck = (
	runtime: IAgentRuntime,
	message: Memory,
	requiredRole: RoleName,
) => Promise<boolean>;

let roleAccessCheck: RoleAccessCheck = (runtime, message, requiredRole) =>
	hasRoleAccess(runtime, message, requiredRole);

export function setTranscriptPermissioningRoleAccessForTests(
	check: RoleAccessCheck,
): void {
	roleAccessCheck = check;
}

export function resetTranscriptPermissioningRoleAccessForTests(): void {
	roleAccessCheck = (runtime, message, requiredRole) =>
		hasRoleAccess(runtime, message, requiredRole);
}

interface HandlerOptions {
	parameters?: Record<string, unknown>;
}

interface TranscriptPermissioningInput {
	transcriptId: UUID;
	entityId?: UUID;
	mode?: ArtifactShareGrantMode;
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

function parseInput(
	parameters: Record<string, unknown>,
	options: { requireEntity: boolean; defaultMode?: ArtifactShareGrantMode },
): TranscriptPermissioningInput | null {
	const transcriptId = nonEmptyString(parameters.transcriptId);
	if (!transcriptId) return null;
	const entityId = nonEmptyString(parameters.entityId);
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

async function canManageTranscript(
	runtime: IAgentRuntime,
	message: Memory,
	transcriptId: UUID,
): Promise<boolean> {
	if (await roleAccessCheck(runtime, message, "ADMIN")) return true;
	if (!(await roleAccessCheck(runtime, message, "USER"))) return false;
	const row = await (runtime as TranscriptStoreRuntime).getMemoryById(
		transcriptId,
	);
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
	const isAdmin = await roleAccessCheck(runtime, message, "ADMIN");
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
	store: TranscriptStore,
	transcriptId: UUID,
	accessContext: AccessContext | undefined,
): Promise<ActionResult | null> {
	const transcript = await store.get(transcriptId, accessContext);
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
		"Create or refresh the redacted variant for a stored meeting transcript. The original transcript and audio remain unchanged, and the variant withholds audio.",
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
				"REDACT_TRANSCRIPT requires transcriptId.",
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
				store,
				input.transcriptId,
				accessContext,
			);
			if (denied) {
				auditDenied(runtime, "REDACT_TRANSCRIPT", message, input);
				await callback?.({ text: denied.text, actions: ["REDACT_TRANSCRIPT"] });
				return denied;
			}
			const variant = await store.createRedactedVariant({
				originalId: input.transcriptId,
				redactedBy: message.entityId as UUID,
			});
			const result = ok("Redacted transcript variant is ready.", {
				actionName: "REDACT_TRANSCRIPT",
				transcriptId: input.transcriptId,
				variantId: variant.id,
				redacted: true,
				hasAudio: false,
			});
			await callback?.({ text: result.text, actions: ["REDACT_TRANSCRIPT"] });
			return result;
		} catch (error) {
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
				"SHARE_TRANSCRIPT requires transcriptId, entityId, and mode full or redacted.",
			);
			await callback?.({ text: result.text, actions: ["SHARE_TRANSCRIPT"] });
			return result;
		}

		const canShare =
			input.mode === "full"
				? await roleAccessCheck(runtime, message, "ADMIN")
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
			let variantId: string | undefined;
			const store = transcriptStore(runtime);
			const accessContext = await accessContextForMessage(
				runtime,
				message,
				input.transcriptId,
			);
			const denied = await requireFullTranscript(
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
				const variant = await store.createRedactedVariant({
					originalId: input.transcriptId,
					redactedBy: message.entityId as UUID,
				});
				variantId = variant.id;
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
					...(variantId ? { variantId } : {}),
				},
			);
			await callback?.({ text: result.text, actions: ["SHARE_TRANSCRIPT"] });
			return result;
		} catch (error) {
			const messageText =
				error instanceof Error ? error.message : String(error);
			const result = fail("SHARE_TRANSCRIPT_FAILED", messageText);
			await callback?.({ text: result.text, actions: ["SHARE_TRANSCRIPT"] });
			return result;
		}
	},
	examples: [],
};
