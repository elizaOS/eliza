/**
 * Onboarding Provider
 *
 * Provides onboarding status and context to the LLM during secret collection.
 * Injects prompts about required settings into the agent's context.
 */

import { logger } from "../../../logger.ts";
import type {
	IAgentRuntime,
	Memory,
	Provider,
	ProviderResult,
	State,
} from "../../../types/index.ts";
import { ChannelType } from "../../../types/index.ts";
import type { OnboardingSetting } from "./config.ts";

/**
 * Format a setting value for display, respecting privacy flags.
 */
function formatSettingValue(
	setting: OnboardingSetting,
	isOnboarding: boolean,
): string {
	if (setting.value === null || setting.value === undefined) {
		return "Not set";
	}
	if (setting.secret && !isOnboarding) {
		return "****************";
	}
	return String(setting.value);
}

/**
 * Generate status message based on settings state.
 */
function generateStatusMessage(
	settings: Record<string, OnboardingSetting>,
	isOnboarding: boolean,
	agentName: string,
	senderName?: string,
): string {
	const entries = Object.entries(settings);

	// Format settings for display
	const formattedSettings = entries
		.map(([key, setting]) => {
			// Skip settings that should be hidden based on visibility function
			if (setting.visibleIf && !setting.visibleIf(settings)) {
				return null;
			}

			return {
				key,
				name: setting.name,
				value: formatSettingValue(setting, isOnboarding),
				description: setting.description,
				usageDescription: setting.usageDescription || setting.description,
				required: setting.required,
				configured: setting.value !== null,
			};
		})
		.filter(Boolean);

	// Count required unconfigured
	const requiredUnconfigured = formattedSettings.filter(
		(s) => s?.required && !s.configured,
	).length;

	// Generate appropriate message
	if (isOnboarding) {
		const settingsList = formattedSettings
			.map((s) => {
				if (!s) return "";
				const label = s.required ? "(Required)" : "(Optional)";
				return `${s.key}: ${s.value} ${label}\n(${s.name}) ${s.usageDescription}`;
			})
			.filter(Boolean)
			.join("\n\n");

		const validKeys = `Valid setting keys: ${entries.map(([k]) => k).join(", ")}`;

		const instructions = `Instructions for ${agentName}:
- Only update settings if the user is clearly responding to a setting you are currently asking about.
- If the user's reply clearly maps to a setting and a valid value, you **must** call the UPDATE_SETTINGS action with the correct key and value.
- Never hallucinate settings or respond with values not listed above.
- Do not call UPDATE_SETTINGS just because onboarding started. Only update when the user provides a specific value.
- Answer setting-related questions using only the name, description, and value from the list.`;

		if (requiredUnconfigured > 0) {
			const name = senderName || "user";
			return `# PRIORITY TASK: Onboarding with ${name}

${agentName} needs to help the user configure ${requiredUnconfigured} required settings:

${settingsList}

${validKeys}

${instructions}

- Prioritize configuring required settings before optional ones.`;
		}

		return `All required settings have been configured. Here's the current configuration:

${settingsList}

${validKeys}

${instructions}`;
	}

	// Non-onboarding context
	return `## Current Configuration

${
	requiredUnconfigured > 0
		? `IMPORTANT!: ${requiredUnconfigured} required settings still need configuration. ${agentName} should get onboarded with the OWNER as soon as possible.\n\n`
		: "All required settings are configured.\n\n"
}${formattedSettings
	.map((s) => {
		if (!s) return "";
		return `### ${s.name}\n**Value:** ${s.value}\n**Description:** ${s.description}`;
	})
	.filter(Boolean)
	.join("\n\n")}`;
}

/**
 * Onboarding settings provider - injects onboarding context into LLM prompts.
 */
export const onboardingSettingsProvider: Provider = {
	name: "ONBOARDING_SETTINGS",
	description: "Current onboarding settings status for secrets collection",

	dynamic: true,
	contexts: ["settings"],
	contextGate: { anyOf: ["settings"] },
	cacheStable: false,
	cacheScope: "turn",
	roleGate: { minRole: "OWNER" },

	get: async (
		runtime: IAgentRuntime,
		message: Memory,
		state?: State,
	): Promise<ProviderResult> => {
		// Get room to determine if we're in DM (onboarding mode)
		const room = await runtime.getRoom(message.roomId);
		if (!room) {
			logger.debug("[OnboardingSettingsProvider] No room found");
			return {
				data: { settings: [] },
				values: { settings: "Error: Room not found" },
				text: "Error: Room not found",
			};
		}

		if (!room.worldId) {
			logger.debug("[OnboardingSettingsProvider] No world ID for room");
			return {
				data: { settings: [] },
				values: { settings: "Room has no associated world." },
				text: "Room has no associated world.",
			};
		}

		const isOnboarding = room.type === ChannelType.DM;

		// Get the world
		const world = await runtime.getWorld(room.worldId);
		if (!world) {
			logger.debug("[OnboardingSettingsProvider] No world found");
			return {
				data: { settings: [] },
				values: { settings: "Error: World not found" },
				text: "Error: World not found",
			};
		}

		// Check for settings in world metadata
		const worldSettings = world.metadata?.settings as
			| Record<string, OnboardingSetting>
			| undefined;
		if (!worldSettings) {
			// No onboarding configured for this world
			if (isOnboarding) {
				return {
					data: { settings: [] },
					values: {
						settings:
							"No settings configured for this world. Use initializeOnboarding to set up.",
					},
					text: "No settings configured for this world.",
				};
			}
			return {
				data: { settings: [] },
				values: { settings: "" },
				text: "",
			};
		}

		// Generate status message
		const agentName = runtime.character.name ?? "Agent";
		const senderName = state?.senderName as string | undefined;

		const output = generateStatusMessage(
			worldSettings,
			isOnboarding,
			agentName,
			senderName,
		);

		return {
			data: { settings: worldSettings },
			values: { settings: output },
			text: output,
		};
	},
};

/**
 * Provider that shows what secrets are still needed.
 */
export const missingSecretsProvider: Provider = {
	name: "MISSING_SECRETS",
	description: "Lists secrets that still need to be configured",

	dynamic: true,
	contexts: ["settings"],
	contextGate: { anyOf: ["settings"] },
	cacheStable: false,
	cacheScope: "turn",
	roleGate: { minRole: "OWNER" },

	get: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
	): Promise<ProviderResult> => {
		const room = await runtime.getRoom(message.roomId);
		if (!room?.worldId) {
			return {
				data: { missing: [] },
				values: { missingSecrets: "" },
				text: "",
			};
		}

		const world = await runtime.getWorld(room.worldId);
		if (!world?.metadata?.settings) {
			return {
				data: { missing: [] },
				values: { missingSecrets: "" },
				text: "",
			};
		}

		const settings = world.metadata.settings as Record<
			string,
			OnboardingSetting
		>;
		const entries = Object.entries(settings);

		const missingRequired = entries
			.filter(([_, s]) => s.required && s.value === null)
			.map(([key, setting]) => ({
				key,
				name: setting.name,
				description: setting.usageDescription || setting.description,
			}));

		const missingOptional = entries
			.filter(([_, s]) => !s.required && s.value === null)
			.map(([key, setting]) => ({
				key,
				name: setting.name,
				description: setting.usageDescription || setting.description,
			}));

		if (missingRequired.length === 0 && missingOptional.length === 0) {
			return {
				data: { missing: [] },
				values: { missingSecrets: "All secrets are configured." },
				text: "All secrets are configured.",
			};
		}

		let output = "";
		if (missingRequired.length > 0) {
			output += `Missing required secrets:\n${missingRequired.map((s) => `- ${s.key}: ${s.description}`).join("\n")}\n\n`;
		}
		if (missingOptional.length > 0) {
			output += `Missing optional secrets:\n${missingOptional.map((s) => `- ${s.key}: ${s.description}`).join("\n")}`;
		}

		return {
			data: {
				missing: [...missingRequired, ...missingOptional],
				missingRequired,
				missingOptional,
			},
			values: { missingSecrets: output.trim() },
			text: output.trim(),
		};
	},
};
