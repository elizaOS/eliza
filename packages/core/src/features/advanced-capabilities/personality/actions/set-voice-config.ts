import { logger } from "../../../../logger.ts";
import type {
	Action,
	ActionExample,
	ActionResult,
	CharacterSettings,
	HandlerCallback,
	IAgentRuntime,
	JsonValue,
	Memory,
	State,
} from "../../../../types/index.ts";
import { hasActionContextOrKeyword } from "../../../../utils/action-validation.ts";
import { persistCharacterPatch } from "./shared/persist-character-patch.ts";

type VoiceProvider = "elevenlabs" | "edge";

type SetVoiceConfigParameters = {
	provider?: string;
	voiceId?: string;
	modelId?: string;
};

type JsonObject = Record<string, JsonValue>;

function isVoiceProvider(value: unknown): value is VoiceProvider {
	return value === "elevenlabs" || value === "edge";
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Update the agent's voice (TTS) settings on the character.
 *
 * Mirrors what the UI's `client.updateConfig({ messages: { tts: ... } })`
 * call accomplishes by writing the same fields into the runtime
 * character's `settings.voice` slot, which is what
 * `services/message.ts` reads at speech time. Persistence then flows
 * through the standard `eliza_character_persistence` service so the
 * change survives across restarts (same path `MODIFY_CHARACTER` uses).
 */
export const setVoiceConfigAction: Action = {
	name: "SET_VOICE_CONFIG",
	contexts: ["settings", "media", "agent_internal"],
	roleGate: { minRole: "ADMIN" },
	similes: [
		"UPDATE_VOICE_CONFIG",
		"SET_TTS",
		"UPDATE_TTS",
		"SET_VOICE",
		"UPDATE_VOICE",
		"CONFIGURE_VOICE",
		"CHANGE_VOICE_MODEL",
	],
	description:
		"Updates the agent's text-to-speech (TTS) voice configuration: which provider to use (ElevenLabs or Edge), the voice id, and an optional model id. Use this when the user asks to change the agent's voice, switch TTS providers, pick a specific voice, or set a TTS model.",
	suppressPostActionContinuation: true,
	parameters: [
		{
			name: "provider",
			description: "TTS provider identifier. One of 'elevenlabs' or 'edge'.",
			required: true,
			schema: {
				type: "string" as const,
				enum: ["elevenlabs", "edge"],
			},
		},
		{
			name: "voiceId",
			description:
				"Provider-specific voice identifier (for example an ElevenLabs voice id or an Edge voice short name).",
			required: true,
			schema: { type: "string" as const },
		},
		{
			name: "modelId",
			description:
				"Optional provider-specific model id (for example 'eleven_turbo_v2'). Omit to use the provider default.",
			required: false,
			schema: { type: "string" as const },
		},
	],

	validate: async (
		_runtime: IAgentRuntime,
		message: Memory,
		state?: State,
	): Promise<boolean> =>
		hasActionContextOrKeyword(message, state, {
			contexts: ["settings", "media", "agent_internal"],
			keywords: [
				"voice",
				"tts",
				"text to speech",
				"elevenlabs",
				"voice id",
				"voice model",
				"change voice",
			],
		}),

	handler: async (
		runtime: IAgentRuntime,
		_message: Memory,
		_state?: State,
		options?: Record<string, unknown>,
		callback?: HandlerCallback,
	): Promise<ActionResult> => {
		const params = (options?.parameters ?? {}) as SetVoiceConfigParameters;
		const provider = params.provider?.trim();
		const voiceId = params.voiceId?.trim();
		const modelId = params.modelId?.trim();

		if (!provider || !isVoiceProvider(provider)) {
			const text =
				"I need a valid TTS provider ('elevenlabs' or 'edge') to update the voice config.";
			await callback?.({ text, thought: "Missing or invalid provider" });
			return {
				text,
				success: false,
				values: { error: "invalid_provider" },
				data: { action: "SET_VOICE_CONFIG" },
			};
		}

		if (!voiceId) {
			const text = "I need a voice id to update the voice config.";
			await callback?.({ text, thought: "Missing voiceId" });
			return {
				text,
				success: false,
				values: { error: "missing_voice_id" },
				data: { action: "SET_VOICE_CONFIG" },
			};
		}

		try {
			const existingSettings = runtime.character.settings ?? {};
			const existingVoice = isJsonObject(existingSettings.voice)
				? existingSettings.voice
				: {};

			const nextVoice: JsonObject = {
				...existingVoice,
				provider,
				voiceId,
				voice_id: voiceId,
			};

			if (modelId) {
				nextVoice.model = modelId;
				nextVoice.model_id = modelId;
			} else {
				delete nextVoice.model;
				delete nextVoice.model_id;
			}

			const nextSettings: CharacterSettings = {
				...existingSettings,
				voice: nextVoice,
			};

			const result = await persistCharacterPatch(runtime, {
				settings: nextSettings,
			});

			if (!result.success) {
				const text = `I couldn't save the voice configuration: ${result.error ?? "unknown error"}`;
				await callback?.({ text, thought: "Voice config persistence failed" });
				return {
					text,
					success: false,
					values: { error: result.error ?? "persistence_failed" },
					data: { action: "SET_VOICE_CONFIG" },
				};
			}

			const summary = modelId
				? `Updated voice config: provider=${provider}, voiceId=${voiceId}, modelId=${modelId}.`
				: `Updated voice config: provider=${provider}, voiceId=${voiceId}.`;

			await callback?.({
				text: summary,
				thought: `Applied voice config: provider=${provider}; voiceId=${voiceId}; modelId=${modelId ?? "none"}`,
				actions: ["SET_VOICE_CONFIG"],
			});

			return {
				text: summary,
				success: true,
				values: {
					provider,
					voiceId,
					...(modelId ? { modelId } : {}),
				},
				data: {
					action: "SET_VOICE_CONFIG",
					voiceConfig: {
						provider,
						voiceId,
						...(modelId ? { modelId } : {}),
					},
				},
			};
		} catch (error) {
			logger.error(
				{ error: error instanceof Error ? error.message : String(error) },
				"Error in SET_VOICE_CONFIG action",
			);
			const text = "I encountered an error while updating the voice config.";
			await callback?.({
				text,
				thought: `Error in set voice config: ${(error as Error).message}`,
			});
			return {
				text,
				success: false,
				values: { error: (error as Error).message },
				data: {
					action: "SET_VOICE_CONFIG",
					errorDetails: (error as Error).stack,
				},
			};
		}
	},

	examples: [
		[
			{
				name: "{{user}}",
				content: {
					text: "Use ElevenLabs voice 21m00Tcm4TlvDq8ikWAM with the eleven_turbo_v2 model.",
				},
			},
			{
				name: "{{agent}}",
				content: {
					text: "Updated voice config: provider=elevenlabs, voiceId=21m00Tcm4TlvDq8ikWAM, modelId=eleven_turbo_v2.",
					actions: ["SET_VOICE_CONFIG"],
				},
			},
		],
		[
			{
				name: "{{user}}",
				content: {
					text: "Switch the TTS to Microsoft Edge with the en-US-JennyNeural voice.",
				},
			},
			{
				name: "{{agent}}",
				content: {
					text: "Updated voice config: provider=edge, voiceId=en-US-JennyNeural.",
					actions: ["SET_VOICE_CONFIG"],
				},
			},
		],
	] as ActionExample[][],
};
