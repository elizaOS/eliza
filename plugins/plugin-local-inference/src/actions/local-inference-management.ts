import {
	type Action,
	type ActionResult,
	ElizaError,
	type HandlerCallback,
	type HandlerOptions,
	type IAgentRuntime,
	type Memory,
} from "@elizaos/core";
import type {
	LocalInferenceManagementInput,
	LocalInferenceManagementOp,
	LocalInferenceManagementResult,
} from "../local-inference-routes.js";

const OP_ALIASES: Record<string, LocalInferenceManagementOp> = {
	start_download: "start_download",
	startLocalInferenceDownload: "start_download",
	download: "start_download",
	cancel_download: "cancel_download",
	cancelLocalInferenceDownload: "cancel_download",
	cancel: "cancel_download",
	set_active: "set_active",
	setLocalInferenceActive: "set_active",
	activate: "set_active",
	clear_active: "clear_active",
	clearLocalInferenceActive: "clear_active",
	uninstall_model: "uninstall_model",
	uninstallLocalInferenceModel: "uninstall_model",
	verify_model: "verify_model",
	verifyLocalInferenceModel: "verify_model",
	set_policy: "set_policy",
	setLocalInferencePolicy: "set_policy",
	set_preferred_provider: "set_preferred_provider",
	setLocalInferencePreferredProvider: "set_preferred_provider",
	set_assignment: "set_assignment",
	setLocalInferenceAssignment: "set_assignment",
	trigger_voice_model_update: "trigger_voice_model_update",
	triggerVoiceModelUpdate: "trigger_voice_model_update",
	pin_voice_model: "pin_voice_model",
	pinVoiceModel: "pin_voice_model",
	set_voice_model_preferences: "set_voice_model_preferences",
	setVoiceModelPreferences: "set_voice_model_preferences",
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringParam(
	params: Record<string, unknown>,
	key: string,
): string | undefined {
	const value = params[key];
	return typeof value === "string" ? value : undefined;
}

function booleanParam(
	params: Record<string, unknown>,
	key: string,
): boolean | undefined {
	const value = params[key];
	return typeof value === "boolean" ? value : undefined;
}

function paramsFromOptions(options?: HandlerOptions): Record<string, unknown> {
	return isRecord(options?.parameters) ? options.parameters : {};
}

function quietHoursParam(
	params: Record<string, unknown>,
): Array<{ start: string; end: string }> | undefined {
	const value = params["quietHours"];
	if (value === undefined) return undefined;
	const invalid = (): never => {
		throw new ElizaError(
			"quietHours must be an array of {start, end} ranges in HH:MM format. No preferences were changed.",
			{ code: "LOCAL_INFERENCE_INVALID_QUIET_HOURS" },
		);
	};
	if (!Array.isArray(value)) return invalid();
	const time = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
	return Array.from(value, (entry) => {
		if (
			!isRecord(entry) ||
			typeof entry.start !== "string" ||
			typeof entry.end !== "string" ||
			!time.test(entry.start) ||
			!time.test(entry.end)
		)
			return invalid();
		return { start: entry.start, end: entry.end };
	});
}

function fail(
	error: string,
	text: string,
	data: Record<string, unknown> = {},
): ActionResult {
	return {
		success: false,
		text,
		values: { success: false, error },
		data: { actionName: "LOCAL_INFERENCE", ...data, error },
	};
}

function ok(text: string, data: Record<string, unknown>): ActionResult {
	return {
		success: true,
		text,
		values: { success: true },
		data: { actionName: "LOCAL_INFERENCE", ...data },
	};
}

export function parseLocalInferenceManagementInput(
	params: Record<string, unknown>,
): LocalInferenceManagementInput | null {
	const rawOp = stringParam(params, "action") ?? stringParam(params, "op");
	if (!rawOp) return null;
	const op = OP_ALIASES[rawOp.trim()] ?? OP_ALIASES[rawOp.trim().toLowerCase()];
	if (!op) return null;
	return {
		op,
		modelId: stringParam(params, "modelId") ?? stringParam(params, "id"),
		voiceModelId:
			stringParam(params, "voiceModelId") ?? stringParam(params, "voiceModel"),
		slot: stringParam(params, "slot") ?? stringParam(params, "modelType"),
		provider: stringParam(params, "provider"),
		policy: stringParam(params, "policy"),
		pinned: booleanParam(params, "pinned"),
		voicePreferences: {
			autoUpdateOnWifi: booleanParam(params, "autoUpdateOnWifi"),
			autoUpdateOnCellular: booleanParam(params, "autoUpdateOnCellular"),
			autoUpdateOnMetered: booleanParam(params, "autoUpdateOnMetered"),
			quietHours: quietHoursParam(params),
		},
	};
}

/** Reply text that states the resulting value, so a clear is not reported as an update. */
function describeMutation(mutation: LocalInferenceManagementResult): string {
	switch (mutation.op) {
		case "pin_voice_model":
			return `Voice model ${mutation.id} is now ${mutation.pinned ? "pinned" : "unpinned"}.`;
		case "set_preferred_provider":
			return mutation.provider
				? `Preferred provider for ${mutation.slot} is now ${mutation.provider}.`
				: `Preferred provider for ${mutation.slot} was cleared.`;
		case "set_assignment":
			return mutation.modelId
				? `Local model assignment for ${mutation.slot} is now ${mutation.modelId}.`
				: `Local model assignment for ${mutation.slot} was cleared.`;
		case "uninstall_model":
			return `Removed local model ${mutation.modelId}.`;
		case "cancel_download":
			return mutation.modelId
				? `Cancelled the download of ${mutation.modelId}.`
				: "Cancelled the active downloads.";
		case "verify_model":
			return describeVerifyState(mutation.modelId, mutation.state);
		default:
			return `Local inference ${mutation.op} updated.`;
	}
}

function describeVerifyState(
	modelId: string,
	state: Extract<
		LocalInferenceManagementResult,
		{ op: "verify_model" }
	>["state"],
): string {
	switch (state) {
		case "ok":
			return `Model ${modelId} verified: the file matches its recorded hash.`;
		case "unknown":
			return `Model ${modelId} has no recorded hash to compare against, so the file could not be verified.`;
		case "mismatch":
			return `Model ${modelId} failed verification: the file does not match its recorded hash.`;
		case "missing":
			return `Model ${modelId} failed verification: the file is missing.`;
		case "truncated":
			return `Model ${modelId} failed verification: the file is truncated or not a GGUF file.`;
	}
}

/**
 * A mutation the route layer completed without doing what was asked. The
 * reply must say so instead of reporting an update.
 */
function describeNoOp(
	mutation: LocalInferenceManagementResult,
): { error: string; text: string } | null {
	if (mutation.op === "uninstall_model" && !mutation.removed) {
		return {
			error: "LOCAL_INFERENCE_NOT_REMOVED",
			text: `Model ${mutation.modelId} was not removed: it is not installed, or it is an external model Eliza does not own.`,
		};
	}
	if (mutation.op === "cancel_download" && !mutation.cancelled) {
		return {
			error: "LOCAL_INFERENCE_NO_DOWNLOAD",
			text: mutation.modelId
				? `No download in progress for ${mutation.modelId}.`
				: "No download in progress.",
		};
	}
	return null;
}

export const localInferenceManagementAction: Action = {
	name: "LOCAL_INFERENCE",
	similes: [
		"LOCAL_MODEL",
		"LOCAL_MODELS",
		"MODEL_HUB",
		"LOCAL_INFERENCE_SETTINGS",
		"VOICE_MODEL_SETTINGS",
	],
	description:
		"Owner-only action twin for local-inference and voice model view mutations. Starts or cancels local model downloads, activates or clears the active local model, uninstalls or verifies an installed model, and updates local-inference routing preferences or assignment slots.",
	routingHint:
		"Use LOCAL_INFERENCE when the user asks to change local model downloads, active model, local inference routing, or local model slot assignments. Pure navigation to the model hub is VIEWS.",
	roleGate: { minRole: "OWNER" },
	parameters: [
		{
			name: "action",
			description:
				"Operation: start_download, cancel_download, set_active, clear_active, uninstall_model, verify_model, trigger_voice_model_update, pin_voice_model, set_voice_model_preferences, set_policy, set_preferred_provider, or set_assignment.",
			required: true,
			schema: {
				type: "string" as const,
				enum: [
					"start_download",
					"cancel_download",
					"set_active",
					"clear_active",
					"uninstall_model",
					"verify_model",
					"trigger_voice_model_update",
					"pin_voice_model",
					"set_voice_model_preferences",
					"set_policy",
					"set_preferred_provider",
					"set_assignment",
				],
			},
		},
		{
			name: "modelId",
			description:
				"Curated local model id for download, activation, uninstall, verify, or assignment. For set_assignment, omit or pass empty to clear the slot's assignment.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "voiceModelId",
			description:
				"Voice model id, required for trigger_voice_model_update and pin_voice_model. pin_voice_model accepts ids such as wakeword, vad, asr, kokoro, or speaker-encoder. trigger_voice_model_update accepts only wakeword; the other voice models ship inside the Eliza-1 bundle and cannot be updated on their own.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "slot",
			description:
				"Model slot such as TEXT_SMALL, TEXT_LARGE, TEXT_EMBEDDING, TEXT_TO_SPEECH, or TRANSCRIPTION.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "provider",
			description:
				"Preferred provider for a slot, for example eliza-local-inference, capacitor-llama, or elizacloud. For set_preferred_provider, omit or pass empty to clear the slot's preferred provider.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "pinned",
			description:
				"Required for pin_voice_model: true pins the voice model from auto-updates, false removes the pin.",
			required: false,
			schema: { type: "boolean" as const },
		},
		{
			name: "autoUpdateOnWifi",
			description: "Enable voice model auto-updates on Wi-Fi.",
			required: false,
			schema: { type: "boolean" as const },
		},
		{
			name: "autoUpdateOnCellular",
			description: "Enable voice model auto-updates on cellular networks.",
			required: false,
			schema: { type: "boolean" as const },
		},
		{
			name: "autoUpdateOnMetered",
			description: "Enable voice model auto-updates on metered networks.",
			required: false,
			schema: { type: "boolean" as const },
		},
		{
			name: "quietHours",
			description:
				'Quiet hours for voice model auto-updates, as a list of {start, end} time ranges (for example [{start: "22:00", end: "07:00"}]).',
			required: false,
			schema: { type: "array" as const },
		},
		{
			name: "policy",
			description:
				"Routing policy value for a slot. Omit or pass empty to clear it.",
			required: false,
			schema: { type: "string" as const },
		},
	],
	validate: async () => true,
	handler: async (
		_runtime: IAgentRuntime,
		_message: Memory,
		_state?: unknown,
		_options?: HandlerOptions,
		callback?: HandlerCallback,
	): Promise<ActionResult> => {
		try {
			const input = parseLocalInferenceManagementInput(
				paramsFromOptions(_options),
			);
			if (!input) {
				const result = fail(
					"LOCAL_INFERENCE_INVALID",
					"LOCAL_INFERENCE requires a supported action.",
				);
				await callback?.({ text: result.text, actions: ["LOCAL_INFERENCE"] });
				return result;
			}
			// The route layer names this argument `id`; the planner only knows it as
			// `voiceModelId`, so report the missing argument under the declared name.
			// The route layer also reads `modelId` as the id, so that call still passes.
			if (
				(input.op === "trigger_voice_model_update" ||
					input.op === "pin_voice_model") &&
				!(input.voiceModelId ?? input.modelId)?.trim()
			) {
				const result = fail(
					"LOCAL_INFERENCE_INVALID",
					`${input.op} requires voiceModelId.`,
				);
				await callback?.({ text: result.text, actions: ["LOCAL_INFERENCE"] });
				return result;
			}
			const { applyLocalInferenceManagementMutation } = await import(
				"../local-inference-routes.js"
			);
			const mutation = await applyLocalInferenceManagementMutation(input);
			const noOp = describeNoOp(mutation);
			const result = noOp
				? fail(noOp.error, noOp.text, { ...mutation })
				: ok(describeMutation(mutation), { ...mutation });
			await callback?.({ text: result.text, actions: ["LOCAL_INFERENCE"] });
			return result;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const result = fail("LOCAL_INFERENCE_FAILED", message);
			await callback?.({ text: result.text, actions: ["LOCAL_INFERENCE"] });
			return result;
		}
	},
	examples: [],
};
