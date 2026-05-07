/**
 * Update Settings Action
 *
 * Extracts and saves setting values from natural language user messages.
 * Uses LLM to parse user responses and map them to settings.
 */

import { logger } from "../../../logger.ts";
import type {
	Action,
	ActionExample,
	ActionResult,
	HandlerCallback,
	HandlerOptions,
	IAgentRuntime,
	Memory,
	State,
	World,
} from "../../../types/index.ts";
import { ChannelType, ModelType } from "../../../types/index.ts";
import type { SecretsService } from "../services/secrets.ts";
import type { SecretContext } from "../types.ts";
import { validateSecret } from "../validation.ts";
import type { OnboardingSetting } from "./config.ts";

/**
 * Setting update extracted from user message.
 */
interface SettingUpdate {
	key: string;
	value: string | boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeSettingValue(value: unknown): string | boolean | null {
	if (typeof value === "string" || typeof value === "boolean") {
		return value;
	}
	if (typeof value === "number" || typeof value === "bigint") {
		return String(value);
	}
	return null;
}

function extractValidSettingUpdates(
	result: unknown,
	settings: Record<string, OnboardingSetting>,
): SettingUpdate[] {
	const validUpdates: SettingUpdate[] = [];

	const addUpdate = (rawKey: unknown, rawValue: unknown): boolean => {
		const key = typeof rawKey === "string" ? rawKey.trim() : "";
		const value = normalizeSettingValue(rawValue);
		if (!key || value === null || !settings[key]) {
			return false;
		}
		validUpdates.push({ key, value });
		return true;
	};

	const traverse = (node: unknown): void => {
		if (Array.isArray(node)) {
			for (const item of node) {
				traverse(item);
			}
			return;
		}

		if (!isRecord(node)) {
			return;
		}

		if ("key" in node && "value" in node) {
			addUpdate(node.key, node.value);
		}

		for (const [key, value] of Object.entries(node)) {
			const added = settings[key] ? addUpdate(key, value) : false;
			if (!added) {
				traverse(value);
			}
		}
	};

	traverse(result);
	return validUpdates;
}

/**
 * Extract setting values from user message using LLM.
 */
async function extractSettingValues(
	runtime: IAgentRuntime,
	message: Memory,
	state: State,
	settings: Record<string, OnboardingSetting>,
): Promise<SettingUpdate[]> {
	// Find unconfigured settings
	const unconfigured = Object.entries(settings).filter(
		([_, s]) => s.value === null,
	);

	if (unconfigured.length === 0) {
		return [];
	}

	// Build context for LLM
	const settingsContext = unconfigured
		.map(([key, setting]) => {
			const requiredStr = setting.required ? "Required." : "Optional.";
			return `${key}: ${setting.description} ${requiredStr}`;
		})
		.join("\n");

	const prompt = `I need to extract settings values from the user's message.

Available settings:
${settingsContext}

User message: ${state.text || message.content?.text || ""}

For each setting mentioned in the user's message, extract the value.

Only return settings that are clearly mentioned in the user's message.
If a setting is mentioned but no clear value is provided, do not include it.
Preserve the extracted value exactly, including punctuation.`;

	const result = await runtime.dynamicPromptExecFromState({
		state,
		params: { prompt },
		schema: [
			{
				field: "updates",
				description:
					"Setting updates clearly present in the user message, or an empty list when none are clear",
				type: "array",
				items: {
					description: "One setting update",
					type: "object",
					properties: [
						{
							field: "key",
							description: "Exact setting key from Available settings",
							required: true,
						},
						{
							field: "value",
							description:
								"Exact value for the setting, preserving punctuation",
							required: true,
						},
					],
				},
				required: false,
				validateField: false,
				streamField: false,
			},
		],
		options: {
			modelType: ModelType.TEXT_LARGE,
			contextCheckLevel: 0,
			maxRetries: 1,
		},
	});

	if (!result) {
		return [];
	}

	return extractValidSettingUpdates(result, settings);
}

/**
 * Process setting updates and save to storage.
 */
async function processSettingUpdates(
	runtime: IAgentRuntime,
	world: World,
	settings: Record<string, OnboardingSetting>,
	updates: SettingUpdate[],
	secretsService: SecretsService | null,
): Promise<{ updatedAny: boolean; messages: string[] }> {
	if (!updates.length) {
		return { updatedAny: false, messages: [] };
	}

	const messages: string[] = [];
	let updatedAny = false;
	const updatedSettings = { ...settings };

	for (const update of updates) {
		const setting = updatedSettings[update.key];
		if (!setting) continue;

		// Check dependencies
		if (setting.dependsOn?.length) {
			const dependenciesMet = setting.dependsOn.every((dep) => {
				const depSetting = updatedSettings[dep];
				return depSetting && depSetting.value !== null;
			});
			if (!dependenciesMet) {
				messages.push(`Cannot update ${setting.name} - dependencies not met`);
				continue;
			}
		}

		// Validate
		const valueStr = String(update.value);
		if (setting.validation && !setting.validation(valueStr)) {
			messages.push(`Invalid value for ${setting.name}`);
			continue;
		}

		if (setting.validationMethod) {
			const validation = await validateSecret(
				update.key,
				valueStr,
				setting.validationMethod,
			);
			if (!validation.isValid) {
				messages.push(
					`Validation failed for ${setting.name}: ${validation.error}`,
				);
				continue;
			}
		}

		// Update local state
		updatedSettings[update.key] = {
			...setting,
			value: valueStr,
		};

		// Store in secrets service if available
		if (secretsService) {
			const context: SecretContext = {
				level: "world",
				agentId: runtime.agentId,
				worldId: world.id,
			};

			await secretsService.set(update.key, valueStr, context, {
				description: setting.description,
				type: setting.type,
				encrypted: setting.secret,
			});
		}

		messages.push(`Updated ${setting.name} successfully`);
		updatedAny = true;

		// Execute onSetAction if defined
		if (setting.onSetAction) {
			const actionMessage = setting.onSetAction(update.value);
			if (actionMessage) {
				messages.push(actionMessage);
			}
		}
	}

	// Save updated settings to world metadata
	if (updatedAny) {
		if (!world.metadata) {
			(world as { metadata?: unknown }).metadata = {};
		}
		// Cast to allow storing our extended settings type
		(world.metadata as Record<string, unknown>).settings = updatedSettings;
		await runtime.updateWorld(world);
	}

	return { updatedAny, messages };
}

/**
 * Get the next setting to configure.
 */
function getNextRequiredSetting(
	settings: Record<string, OnboardingSetting>,
): [string, OnboardingSetting] | null {
	const entries = Object.entries(settings);

	// Find unconfigured required settings
	for (const [key, setting] of entries) {
		if (!setting.required || setting.value !== null) continue;

		// Check dependencies
		const dependenciesMet = (setting.dependsOn || []).every((dep) => {
			const depSetting = settings[dep];
			return depSetting && depSetting.value !== null;
		});

		if (dependenciesMet) {
			return [key, setting];
		}
	}

	return null;
}

/**
 * Count unconfigured required settings.
 */
function countUnconfiguredRequired(
	settings: Record<string, OnboardingSetting>,
): number {
	return Object.values(settings).filter((s) => s.required && s.value === null)
		.length;
}

/**
 * UPDATE_SETTINGS Action - extracts and saves settings from natural language.
 */
export const updateSettingsAction: Action = {
	name: "UPDATE_SETTINGS",
	contexts: ["settings", "secrets", "connectors"],
	roleGate: { minRole: "ADMIN" },
	suppressPostActionContinuation: true,
	similes: ["UPDATE_SETTING", "SAVE_SETTING", "SET_CONFIGURATION", "CONFIGURE"],
	description:
		"Saves a configuration setting during the onboarding process. Use when onboarding with a world owner or admin.",
	parameters: [
		{
			name: "key",
			description: "Optional setting key to update.",
			required: false,
			schema: { type: "string" },
		},
		{
			name: "value",
			description: "Optional setting value to save.",
			required: false,
			schema: { type: "string" },
		},
	],

	validate: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
		_options?: HandlerOptions,
	): Promise<boolean> => {
		const text = message.content?.text?.toLowerCase() ?? "";
		const hasUpdateIntent =
			["update", "settings"].some((keyword) => text.includes(keyword)) &&
			/\b(?:update|settings)\b/i.test(text);
		if (!hasUpdateIntent || message.content.channelType !== ChannelType.DM) {
			return false;
		}

		const room = await runtime.getRoom(message.roomId);
		if (!room?.worldId) return false;

		const world = await runtime.getWorld(room.worldId);
		if (!world?.metadata?.settings) return false;

		const settings = world.metadata.settings as Record<
			string,
			OnboardingSetting
		>;
		return Object.values(settings).some((setting) => setting.value === null);
	},

	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		state?: State,
		_options?: HandlerOptions,
		callback?: HandlerCallback,
	): Promise<ActionResult> => {
		if (!state || !callback) {
			return {
				text: "State and callback required",
				values: { success: false },
				data: { actionName: "UPDATE_SETTINGS" },
				success: false,
			};
		}

		// Get room and world
		const room = await runtime.getRoom(message.roomId);
		if (!room?.worldId) {
			await callback({ text: "Unable to find room configuration." });
			return {
				text: "Room not found",
				values: { success: false },
				data: { actionName: "UPDATE_SETTINGS" },
				success: false,
			};
		}

		const world = await runtime.getWorld(room.worldId);
		if (!world?.metadata?.settings) {
			await callback({ text: "No settings configured for this world." });
			return {
				text: "No settings found",
				values: { success: false },
				data: { actionName: "UPDATE_SETTINGS" },
				success: false,
			};
		}

		const settings = world.metadata.settings as Record<
			string,
			OnboardingSetting
		>;

		// Get secrets service
		const secretsService = runtime.getService(
			"SECRETS",
		) as SecretsService | null;

		// Extract settings from message
		logger.info("[UpdateSettings] Extracting settings from message");
		const extractedSettings = await extractSettingValues(
			runtime,
			message,
			state,
			settings,
		);
		logger.info(
			`[UpdateSettings] Extracted ${extractedSettings.length} settings`,
		);

		// Process updates
		const results = await processSettingUpdates(
			runtime,
			world,
			settings,
			extractedSettings,
			secretsService,
		);

		// Get updated settings
		const updatedWorld = await runtime.getWorld(room.worldId);
		const updatedSettings = updatedWorld?.metadata?.settings as Record<
			string,
			OnboardingSetting
		>;

		if (results.updatedAny) {
			const remaining = countUnconfiguredRequired(updatedSettings || settings);

			if (remaining === 0) {
				// All required settings configured
				await callback({
					text: `${results.messages.join("\n")}\n\nAll required settings have been configured! You're all set.`,
					actions: ["ONBOARDING_COMPLETE"],
				});

				return {
					text: "Onboarding complete",
					values: { success: true, onboardingComplete: true },
					data: {
						actionName: "UPDATE_SETTINGS",
						action: "ONBOARDING_COMPLETE",
					},
					success: true,
				};
			}

			// More settings needed
			const next = getNextRequiredSetting(updatedSettings || settings);
			const nextPrompt = next
				? `\n\nNext, I need your ${next[1].name}. ${next[1].usageDescription || next[1].description}`
				: "";

			await callback({
				text: `${results.messages.join("\n")}${nextPrompt}`,
				actions: ["SETTING_UPDATED"],
			});

			return {
				text: "Settings updated",
				values: { success: true, remainingRequired: remaining },
				data: {
					actionName: "UPDATE_SETTINGS",
					action: "SETTING_UPDATED",
					updated: extractedSettings.map((s) => s.key),
				},
				success: true,
			};
		}

		// No settings extracted
		const next = getNextRequiredSetting(settings);
		const prompt = next
			? `I couldn't understand that. I need your ${next[1].name}. ${next[1].usageDescription || next[1].description}`
			: "I couldn't extract any settings from your message. Could you try again?";

		await callback({
			text: prompt,
			actions: ["SETTING_UPDATE_FAILED"],
		});

		return {
			text: "No settings updated",
			values: { success: false },
			data: { actionName: "UPDATE_SETTINGS", action: "SETTING_UPDATE_FAILED" },
			success: false,
		};
	},

	examples: [
		[
			{
				name: "{{name1}}",
				content: {
					text: "My OpenAI key is sk-abc123def456",
					source: "discord",
				},
			},
			{
				name: "{{name2}}",
				content: {
					text: "Got it! I've saved your OpenAI API Key. Next, I need your Anthropic API Key.",
					actions: ["SETTING_UPDATED"],
					source: "discord",
				},
			},
		],
		[
			{
				name: "{{name1}}",
				content: {
					text: "Here's my Twitter login: @myhandle with password secret123",
					source: "discord",
				},
			},
			{
				name: "{{name2}}",
				content: {
					text: "Perfect! I've updated your Twitter Username and Twitter Password. We're all set!",
					actions: ["ONBOARDING_COMPLETE"],
					source: "discord",
				},
			},
		],
	] as ActionExample[][],
};
