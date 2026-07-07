import type {
	Action,
	ActionResult,
	HandlerCallback,
	HandlerOptions,
	IAgentRuntime,
	Memory,
} from "@elizaos/core";
import type {
	LocalInferenceManagementInput,
	LocalInferenceManagementOp,
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

function fail(error: string, text: string): ActionResult {
	return {
		success: false,
		text,
		values: { success: false, error },
		data: { actionName: "LOCAL_INFERENCE", error },
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
		},
	};
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
				"Curated local model id for download, activation, uninstall, verify, or assignment.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "voiceModelId",
			description:
				"Voice model id for update or pin operations, such as wakeword, vad, asr, kokoro, or speaker-encoder.",
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
				"Preferred provider for a slot, for example eliza-local-inference, capacitor-llama, or elizacloud.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "pinned",
			description: "Whether a voice model should be pinned from auto-updates.",
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
		try {
			const { applyLocalInferenceManagementMutation } = await import(
				"../local-inference-routes.js"
			);
			const mutation = await applyLocalInferenceManagementMutation(input);
			const result = ok(`Local inference ${mutation.op} updated.`, mutation);
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
