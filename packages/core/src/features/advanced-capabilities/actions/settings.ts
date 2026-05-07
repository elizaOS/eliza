import dedent from "dedent";
import { requireActionSpec } from "../../../generated/spec-helpers.ts";
import { logger } from "../../../logger.ts";
import { findWorldsForOwner } from "../../../roles.ts";
import {
	getSalt,
	saltWorldSettings,
	unsaltWorldSettings,
} from "../../../settings.ts";
import type {
	Action,
	ActionExample,
	ActionResult,
	Content,
	HandlerCallback,
	HandlerOptions,
	IAgentRuntime,
	Memory,
	Setting,
	State,
	UUID,
	WorldSettings,
} from "../../../types/index.ts";
import { ChannelType, ModelType } from "../../../types/index.ts";
import {
	composePrompt,
	composePromptFromState,
	parseJSONObjectFromText,
} from "../../../utils.ts";

// Get text content from centralized specs
const spec = requireActionSpec("UPDATE_SETTINGS");

/**
 * Interface representing the structure of a setting update object.
 * @interface
 * @property {string} key - The key of the setting to be updated.
 * @property {string|boolean} value - The new value for the setting, can be a string or a boolean.
 */
/**
 * Interface for updating settings.
 * @typedef {Object} SettingUpdate
 * @property {string} key - The key of the setting to update.
 * @property {string | boolean} value - The new value of the setting, can be a string or a boolean.
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

function extractValidSettings(
	result: unknown,
	worldSettings: WorldSettings,
): SettingUpdate[] {
	const settingsByKey = worldSettings.settings ?? {};
	const extracted: SettingUpdate[] = [];

	const addUpdate = (rawKey: unknown, rawValue: unknown): boolean => {
		const key = typeof rawKey === "string" ? rawKey.trim() : "";
		const value = normalizeSettingValue(rawValue);
		if (!key || value === null || !settingsByKey[key]) {
			return false;
		}
		extracted.push({ key, value });
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
			const added = settingsByKey[key] ? addUpdate(key, value) : false;
			if (!added) {
				traverse(value);
			}
		}
	};

	traverse(result);
	return extracted;
}

function responseContentFromJson(
	response: string,
	fallbackAction: string,
): Content {
	const parsed = parseJSONObjectFromText(response) as Content | null;
	return {
		...(parsed ?? {}),
		text:
			typeof parsed?.text === "string" && parsed.text.trim()
				? parsed.text
				: response.trim(),
		actions: Array.isArray(parsed?.actions) ? parsed.actions : [fallbackAction],
	};
}

const messageCompletionFooter = `\n# Instructions: Write the next message for {{agentName}}. Include the appropriate action from the list: {{actionNames}}


Response format should be JSON like this:
{
  "name": "{{agentName}}",
  "text": "Your message text here",
  "thought": "Your thought about the response",
  "actions": ["ACTION_NAME"]
}

Do not including any thinking or internal reflection in the "text" field.
"thought" should be a short description of what the agent is thinking about before responding, including a brief justification for the response.

IMPORTANT: Your response must ONLY contain the JSON object above. Do not include any text, thinking, or reasoning before or after it.`;

// Template for success responses when settings are updated
/**
 * JSDoc comment for successTemplate constant
 *
 * # Task: Generate a response for successful setting updates
 * {{providers}}
 *
 * # Update Information:
 * - Updated Settings: {{updateMessages}}
 * - Next Required Setting: {{nextSetting.name}}
 * - Remaining Required Settings: {{remainingRequired}}
 *
 * # Instructions:
 * 1. Acknowledge the successful update of settings
 * 2. Maintain {{agentName}}'s personality and tone
 * 3. Provide clear guidance on the next setting that needs to be configured
 * 4. Explain what the next setting is for and how to set it
 * 5. If appropriate, mention how many required settings remain
 *
 * Write a natural, conversational response that {{agentName}} would send about the successful update and next steps.
 * Include the actions array ["SETTING_UPDATED"] in your response.
 * ${messageCompletionFooter}
 */
const successTemplate = `# Task: Generate a response for successful setting updates
{{providers}}

# Update Information:
- Updated Settings: {{updateMessages}}
- Next Required Setting: {{nextSetting.name}}
- Remaining Required Settings: {{remainingRequired}}

# Instructions:
1. Acknowledge the successful update of settings
2. Maintain {{agentName}}'s personality and tone
3. Provide clear guidance on the next setting that needs to be configured
4. Explain what the next setting is for and how to set it
5. If appropriate, mention how many required settings remain

Write a natural, conversational response that {{agentName}} would send about the successful update and next steps.
Include the actions array ["SETTING_UPDATED"] in your response.
${messageCompletionFooter}`;

// Template for failure responses when settings couldn't be updated
/**
 * Template for generating a response for failed setting updates.
 *
 * @template T
 * @param {string} failureTemplate - The failure template string to fill in with dynamic content.
 * @returns {string} - The filled-in template for generating the response.
 */
const failureTemplate = `# Task: Generate a response for failed setting updates

# About {{agentName}}:
{{bio}}

# Current Settings Status:
{{settingsStatus}}

# Next Required Setting:
- Name: {{nextSetting.name}}
- Description: {{nextSetting.description}}
- Required: Yes
- Remaining Required Settings: {{remainingRequired}}

# Recent Conversation:
{{recentMessages}}

# Instructions:
1. Express that you couldn't understand or process the setting update
2. Maintain {{agentName}}'s personality and tone
3. Provide clear guidance on what setting needs to be configured next
4. Explain what the setting is for and how to set it properly
5. Use a helpful, patient tone

Write a natural, conversational response that {{agentName}} would send about the failed update and how to proceed.
Include the actions array ["SETTING_UPDATE_FAILED"] in your response.
${messageCompletionFooter}`;

// Template for error responses when unexpected errors occur
/**
 * Template for generating a response for an error during setting updates.
 *
 * The template includes placeholders for agent name, bio, recent messages,
 * and provides instructions for crafting a response.
 *
 * Instructions:
 * 1. Apologize for the technical difficulty
 * 2. Maintain agent's personality and tone
 * 3. Suggest trying again or contacting support if the issue persists
 * 4. Keep the message concise and helpful
 *
 * Actions array to include: ["SETTING_UPDATE_ERROR"]
 */
const errorTemplate = `# Task: Generate a response for an error during setting updates

# About {{agentName}}:
{{bio}}

# Recent Conversation:
{{recentMessages}}

# Instructions:
1. Apologize for the technical difficulty
2. Maintain {{agentName}}'s personality and tone
3. Suggest trying again or contacting support if the issue persists
4. Keep the message concise and helpful

Write a natural, conversational response that {{agentName}} would send about the error.
Include the actions array ["SETTING_UPDATE_ERROR"] in your response.
${messageCompletionFooter}`;

// Template for completion responses when all required settings are configured
/**
 * Task: Generate a response for settings completion
 *
 * About {{agentName}}:
 * {{bio}}
 *
 * Settings Status:
 * {{settingsStatus}}
 *
 * Recent Conversation:
 * {{recentMessages}}
 *
 * Instructions:
 * 1. Congratulate the user on completing the settings process
 * 2. Maintain {{agentName}}'s personality and tone
 * 3. Summarize the key settings that have been configured
 * 4. Explain what functionality is now available
 * 5. Provide guidance on what the user can do next
 * 6. Express enthusiasm about working together
 *
 * Write a natural, conversational response that {{agentName}} would send about the successful completion of settings.
 * Include the actions array ["ONBOARDING_COMPLETE"] in your response.
 */
const completionTemplate = `# Task: Generate a response for settings completion

# About {{agentName}}:
{{bio}}

# Settings Status:
{{settingsStatus}}

# Recent Conversation:
{{recentMessages}}

# Instructions:
1. Congratulate the user on completing the settings process
2. Maintain {{agentName}}'s personality and tone
3. Summarize the key settings that have been configured
4. Explain what functionality is now available
5. Provide guidance on what the user can do next
6. Express enthusiasm about working together

Write a natural, conversational response that {{agentName}} would send about the successful completion of settings.
Include the actions array ["ONBOARDING_COMPLETE"] in your response.
${messageCompletionFooter}`;

/**
 * Gets settings state from world metadata
 */
/**
 * Retrieves the settings for a specific world from the database.
 * Settings are stored encrypted; this function decrypts secret values before returning.
 * @param {IAgentRuntime} runtime - The Agent Runtime instance.
 * @param {UUID} worldId - The UUID of the world.
 * @returns {Promise<WorldSettings | null>} The settings of the world (decrypted), or null if not found.
 */
export async function getWorldSettings(
	runtime: IAgentRuntime,
	worldId: UUID,
): Promise<WorldSettings | null> {
	const world = await runtime.getWorld(worldId);

	if (!world?.metadata?.settings) {
		return null;
	}

	// Decrypt secret values before returning (settings are stored encrypted)
	const salt = getSalt();
	return unsaltWorldSettings(world.metadata.settings as WorldSettings, salt);
}

/**
 * Updates settings state in world metadata
 */
export async function updateWorldSettings(
	runtime: IAgentRuntime,
	worldId: UUID,
	worldSettings: WorldSettings,
): Promise<boolean> {
	const world = await runtime.getWorld(worldId);

	if (!world) {
		logger.error(
			{
				src: "plugin:advanced-capabilities:action:settings",
				agentId: runtime.agentId,
				worldId,
			},
			"No world found",
		);
		return false;
	}

	// Initialize metadata if it doesn't exist
	if (!world.metadata) {
		world.metadata = {};
	}

	// Encrypt secret values before saving (settings must be stored encrypted)
	const salt = getSalt();
	const saltedSettings = saltWorldSettings(worldSettings, salt);

	// Update settings state
	world.metadata.settings = saltedSettings;

	// Save updated world
	await runtime.updateWorld(world);

	return true;
}

/**
 * Formats a list of settings for display
 */
function formatSettingsList(worldSettings: WorldSettings): string {
	const lines: string[] = [];
	for (const [key, setting] of Object.entries(worldSettings)) {
		if (key.startsWith("_")) continue;
		if (!setting || typeof setting !== "object") continue;
		if (!("name" in setting) || !("value" in setting)) continue;
		const status = setting.value !== null ? "Configured" : "Not configured";
		const required = setting.required ? "Required" : "Optional";
		lines.push(`- ${setting.name} (${key}): ${status}, ${required}`);
	}

	return lines.length > 0 ? lines.join("\n") : "No settings available";
}

/**
 * Categorizes settings by their configuration status
 */
function categorizeSettings(worldSettings: WorldSettings): {
	configured: [string, Setting][];
	requiredUnconfigured: [string, Setting][];
	optionalUnconfigured: [string, Setting][];
} {
	const configured: [string, Setting][] = [];
	const requiredUnconfigured: [string, Setting][] = [];
	const optionalUnconfigured: [string, Setting][] = [];

	for (const [key, setting] of Object.entries(worldSettings)) {
		// Skip internal settings
		if (key.startsWith("_")) {
			continue;
		}

		const typedSetting = setting as Setting;

		if (typedSetting.value !== null) {
			configured.push([key, typedSetting]);
		} else if (typedSetting.required) {
			requiredUnconfigured.push([key, typedSetting]);
		} else {
			optionalUnconfigured.push([key, typedSetting]);
		}
	}

	return { configured, requiredUnconfigured, optionalUnconfigured };
}

/**
 * Extracts setting values from user message with improved handling of multiple settings
 */
async function extractSettingValues(
	runtime: IAgentRuntime,
	_message: Memory,
	state: State,
	worldSettings: WorldSettings,
	explicitUpdates: SettingUpdate[] = [],
): Promise<SettingUpdate[]> {
	if (explicitUpdates.length > 0) {
		return explicitUpdates.filter(
			(update) => worldSettings.settings[update.key],
		);
	}

	// Find what settings need to be configured
	const { requiredUnconfigured, optionalUnconfigured } =
		categorizeSettings(worldSettings);

	// Generate a prompt to extract settings from the user's message
	const settingsContext = requiredUnconfigured
		.concat(optionalUnconfigured)
		.map(([key, setting]) => {
			const requiredStr = setting.required ? "Required." : "Optional.";
			return `${key}: ${setting.description} ${requiredStr}`;
		})
		.join("\n");

	const basePrompt = dedent`
    I need to extract settings values from the user's message.
    
    Available settings:
    ${settingsContext}
    
    User message: ${state.text}

    For each setting mentioned in the user's message, extract the value.
    
    Only return settings that are clearly mentioned in the user's message.
    If a setting is mentioned but no clear value is provided, do not include it.
    Preserve the extracted value exactly, including punctuation.
    `;

	const result = await runtime.dynamicPromptExecFromState({
		state,
		params: { prompt: basePrompt },
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
			preferredEncapsulation: "json",
			contextCheckLevel: 0,
			maxRetries: 1,
		},
	});

	// Validate the extracted settings
	if (!result) {
		return [];
	}

	return extractValidSettings(result, worldSettings);
}

/**
 * Processes multiple setting updates atomically
 */
async function processSettingUpdates(
	runtime: IAgentRuntime,
	worldId: UUID,
	worldSettings: WorldSettings,
	updates: SettingUpdate[],
): Promise<{ updatedAny: boolean; messages: string[] }> {
	if (!updates.length) {
		return { updatedAny: false, messages: [] };
	}

	const messages: string[] = [];
	let updatedAny = false;

	// Create a copy of the state for atomic updates
	const updatedState: Record<string, Setting> = {
		...worldSettings.settings,
	};

	// Process all updates
	for (const update of updates) {
		const setting = updatedState[update.key];
		if (!setting) {
			continue;
		}

		// Check dependencies if they exist
		if (setting.dependsOn?.length) {
			const dependenciesMet = setting.dependsOn.every(
				(dep) => updatedState[dep] && updatedState[dep].value !== null,
			);
			if (!dependenciesMet) {
				messages.push(`Cannot update ${setting.name} - dependencies not met`);
				continue;
			}
		}

		// Update the setting
		updatedState[update.key] = {
			...setting,
			value: update.value,
		};

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

	// If any updates were made, save the entire state to world metadata
	if (updatedAny) {
		// Save to world metadata
		const saved = await updateWorldSettings(runtime, worldId, {
			...worldSettings,
			settings: updatedState,
		});

		if (!saved) {
			throw new Error("Failed to save updated state to world metadata");
		}

		// Verify save by retrieving it again
		const savedState = await getWorldSettings(runtime, worldId);
		if (!savedState) {
			throw new Error("Failed to verify state save");
		}
	}

	return { updatedAny, messages };
}

/**
 * Handles the completion of settings when all required settings are configured
 */
async function handleOnboardingComplete(
	runtime: IAgentRuntime,
	worldSettings: WorldSettings,
	_state: State,
	callback: HandlerCallback,
): Promise<ActionResult> {
	// Generate completion message
	const prompt = composePrompt({
		state: {
			settingsStatus: formatSettingsList(worldSettings),
		},
		template: completionTemplate,
	});

	const response = await runtime.useModel(ModelType.TEXT_LARGE, {
		prompt,
		stopSequences: [],
	});

	const responseContent = responseContentFromJson(
		response,
		"ONBOARDING_COMPLETE",
	);

	await callback({
		text: responseContent.text,
		actions: ["ONBOARDING_COMPLETE"],
		source: "discord",
	});

	return {
		text: "Onboarding completed successfully",
		values: {
			success: true,
			onboardingComplete: true,
			allRequiredConfigured: true,
		},
		data: {
			actionName: "UPDATE_SETTINGS",
			action: "ONBOARDING_COMPLETE",
			settingsStatus: formatSettingsList(worldSettings),
		},
		success: true,
	};
}

/**
 * Generates a success response for setting updates
 */
async function generateSuccessResponse(
	runtime: IAgentRuntime,
	worldSettings: WorldSettings,
	state: State,
	messages: string[],
	callback: HandlerCallback,
): Promise<ActionResult> {
	const { requiredUnconfigured } = categorizeSettings(worldSettings);

	if (requiredUnconfigured.length === 0) {
		// All required settings are configured, complete settings
		return await handleOnboardingComplete(
			runtime,
			worldSettings,
			state,
			callback,
		);
	}

	const requiredUnconfiguredString = requiredUnconfigured
		.map(([key, setting]) => `${key}: ${setting.name}`)
		.join("\n");

	// Generate success message
	const prompt = composePrompt({
		state: {
			updateMessages: messages.join("\n"),
			nextSetting: requiredUnconfiguredString,
			remainingRequired: requiredUnconfigured.length.toString(),
		},
		template: successTemplate,
	});

	const response = await runtime.useModel(ModelType.TEXT_LARGE, {
		prompt,
		stopSequences: [],
	});

	const responseContent = responseContentFromJson(response, "SETTING_UPDATED");

	await callback({
		text: responseContent.text,
		actions: ["SETTING_UPDATED"],
		source: "discord",
	});

	return {
		text: "Settings updated successfully",
		values: {
			success: true,
			settingsUpdated: true,
			remainingRequired: requiredUnconfigured.length,
		},
		data: {
			actionName: "UPDATE_SETTINGS",
			action: "SETTING_UPDATED",
			updatedMessages: messages,
			remainingRequired: requiredUnconfigured.length,
		},
		success: true,
	};
}

/**
 * Generates a failure response when no settings could be updated
 */
async function generateFailureResponse(
	runtime: IAgentRuntime,
	worldSettings: WorldSettings,
	state: State,
	callback: HandlerCallback,
): Promise<ActionResult> {
	const { requiredUnconfigured } = categorizeSettings(worldSettings);

	if (requiredUnconfigured.length === 0) {
		// All required settings are configured, complete settings
		return await handleOnboardingComplete(
			runtime,
			worldSettings,
			state,
			callback,
		);
	}

	const requiredUnconfiguredString = requiredUnconfigured
		.map(([key, setting]) => `${key}: ${setting.name}`)
		.join("\n");

	// Generate failure message
	const prompt = composePrompt({
		state: {
			nextSetting: requiredUnconfiguredString,
			remainingRequired: requiredUnconfigured.length.toString(),
		},
		template: failureTemplate,
	});

	const response = await runtime.useModel(ModelType.TEXT_LARGE, {
		prompt,
		stopSequences: [],
	});

	const responseContent = responseContentFromJson(
		response,
		"SETTING_UPDATE_FAILED",
	);

	await callback({
		text: responseContent.text,
		actions: ["SETTING_UPDATE_FAILED"],
		source: "discord",
	});

	return {
		text: "No settings were updated",
		values: {
			success: false,
			settingsUpdated: false,
			remainingRequired: requiredUnconfigured.length,
		},
		data: {
			actionName: "UPDATE_SETTINGS",
			action: "SETTING_UPDATE_FAILED",
			remainingRequired: requiredUnconfigured.length,
		},
		success: false,
	};
}

/**
 * Generates an error response for unexpected errors
 */
async function generateErrorResponse(
	runtime: IAgentRuntime,
	state: State,
	callback: HandlerCallback,
): Promise<ActionResult> {
	const prompt = composePromptFromState({
		state,
		template: errorTemplate,
	});

	const response = await runtime.useModel(ModelType.TEXT_LARGE, {
		prompt,
		stopSequences: [],
	});

	const responseContent = responseContentFromJson(
		response,
		"SETTING_UPDATE_ERROR",
	);

	await callback({
		text: responseContent.text,
		actions: ["SETTING_UPDATE_ERROR"],
		source: "discord",
	});

	return {
		text: "Error processing settings",
		values: {
			success: false,
			error: "PROCESSING_ERROR",
		},
		data: {
			actionName: "UPDATE_SETTINGS",
			action: "SETTING_UPDATE_ERROR",
		},
		success: false,
	};
}

/**
 * Enhanced settings action with improved state management and logging
 * Updated to use world metadata instead of cache
 */
export const updateSettingsAction: Action = {
	name: spec.name,
	contexts: ["settings", "admin"],
	roleGate: { minRole: "ADMIN" },
	similes: spec.similes ? [...spec.similes] : [],
	description: spec.description,
	parameters: [
		{
			name: "key",
			description: "Exact setting key to update.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "value",
			description: "Setting value to save.",
			required: false,
			schema: { type: "string" as const },
		},
	],
	examples: (spec.examples ?? []) as ActionExample[][],

	validate: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
		_options?: HandlerOptions,
	): Promise<boolean> => {
		if (message.content.channelType !== ChannelType.DM) {
			logger.debug(
				{
					src: "plugin:advanced-capabilities:action:settings",
					agentId: runtime.agentId,
					channelType: message.content.channelType,
				},
				"Skipping settings in non-DM channel",
			);
			return false;
		}

		// Find the server where this user is the owner
		const params =
			_options?.parameters && typeof _options.parameters === "object"
				? (_options.parameters as Record<string, unknown>)
				: {};
		const hasStructuredSetting =
			typeof params.key === "string" &&
			params.key.trim().length > 0 &&
			params.value !== undefined;

		logger.debug(
			{
				src: "plugin:advanced-capabilities:action:settings",
				agentId: runtime.agentId,
				entityId: message.entityId,
			},
			"Looking for server where user is owner",
		);
		const worlds = await findWorldsForOwner(runtime, message.entityId);
		if (!worlds) {
			return false;
		}

		const world = worlds.find((world) => world.metadata?.settings);

		// Check if there's an active settings state in world metadata
		const worldMetadata = world?.metadata;
		const worldSettings = worldMetadata?.settings;

		if (!worldSettings) {
			logger.debug(
				{
					src: "plugin:advanced-capabilities:action:settings",
					agentId: runtime.agentId,
					messageServerId: world?.messageServerId,
				},
				"No settings state found for server during validation",
			);
			return false;
		}

		logger.debug(
			{
				src: "plugin:advanced-capabilities:action:settings",
				agentId: runtime.agentId,
				messageServerId: world?.messageServerId,
			},
			"Found valid settings state for server",
		);
		return hasStructuredSetting || Boolean(message.content.text);
	},

	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		state?: State,
		_options?: HandlerOptions,
		callback?: HandlerCallback,
	): Promise<ActionResult> => {
		if (!state) {
			logger.error(
				{
					src: "plugin:advanced-capabilities:action:settings",
					agentId: runtime.agentId,
				},
				"State is required for settings handler",
			);
			return {
				text: "State is required for settings handler",
				values: {
					success: false,
					error: "STATE_REQUIRED",
				},
				data: {
					actionName: "UPDATE_SETTINGS",
					error: "State is required",
				},
				success: false,
				error: new Error("State is required for settings handler"),
			};
		}

		if (!message) {
			logger.error(
				{
					src: "plugin:advanced-capabilities:action:settings",
					agentId: runtime.agentId,
				},
				"Message is required for settings handler",
			);
			if (callback) {
				await generateErrorResponse(runtime, state, callback);
			}
			return {
				text: "Message is required for settings handler",
				values: {
					success: false,
					error: "MESSAGE_REQUIRED",
				},
				data: {
					actionName: "UPDATE_SETTINGS",
					error: "Message is required",
				},
				success: false,
				error: new Error("Message is required for settings handler"),
			};
		}

		if (!callback) {
			logger.error(
				{
					src: "plugin:advanced-capabilities:action:settings",
					agentId: runtime.agentId,
				},
				"Callback is required for settings handler",
			);
			return {
				text: "Callback is required for settings handler",
				values: {
					success: false,
					error: "CALLBACK_REQUIRED",
				},
				data: {
					actionName: "UPDATE_SETTINGS",
					error: "Callback is required",
				},
				success: false,
				error: new Error("Callback is required for settings handler"),
			};
		}

		// Find the server where this user is the owner
		logger.info(
			{
				src: "plugin:advanced-capabilities:action:settings",
				agentId: runtime.agentId,
				entityId: message.entityId,
			},
			"Handler looking for server for user",
		);
		const worlds = await findWorldsForOwner(runtime, message.entityId);
		const serverOwnership = worlds?.find((world) => world.metadata?.settings);
		if (!serverOwnership) {
			logger.error(
				{
					src: "plugin:advanced-capabilities:action:settings",
					agentId: runtime.agentId,
					entityId: message.entityId,
				},
				"No server found for user in handler",
			);
			await generateErrorResponse(runtime, state, callback);
			return {
				text: "No server found for user",
				values: {
					success: false,
					error: "NO_SERVER_FOUND",
				},
				data: {
					actionName: "UPDATE_SETTINGS",
					error: "No server found where user is owner",
					entityId: message.entityId,
				},
				success: false,
			};
		}

		const worldId = serverOwnership.id;
		logger.info(
			{
				src: "plugin:advanced-capabilities:action:settings",
				agentId: runtime.agentId,
				worldId,
			},
			"Using world ID",
		);

		// Get settings state directly from the world object we already have
		// Must decrypt secret values (settings are stored encrypted)
		const serverOwnershipMetadata = serverOwnership.metadata;
		const rawSettings = serverOwnershipMetadata?.settings as
			| WorldSettings
			| undefined;
		const worldSettings = rawSettings
			? unsaltWorldSettings(rawSettings, getSalt())
			: undefined;

		if (!worldSettings) {
			logger.error(
				{
					src: "plugin:advanced-capabilities:action:settings",
					agentId: runtime.agentId,
					worldId,
				},
				"No settings state found for world in handler",
			);
			await generateErrorResponse(runtime, state, callback);
			return {
				text: "No settings state found",
				values: {
					success: false,
					error: "NO_SETTINGS_STATE",
				},
				data: {
					actionName: "UPDATE_SETTINGS",
					error: "No settings state found for world",
					worldId,
				},
				success: false,
			};
		}

		// Extract setting values from message
		logger.info(
			{
				src: "plugin:advanced-capabilities:action:settings",
				agentId: runtime.agentId,
				text: message.content.text,
			},
			"Extracting settings from message",
		);
		const extractedSettings = await extractSettingValues(
			runtime,
			message,
			state,
			worldSettings,
			(() => {
				const params =
					_options?.parameters && typeof _options.parameters === "object"
						? (_options.parameters as Record<string, unknown>)
						: {};
				const explicitValue = normalizeSettingValue(params.value);
				return typeof params.key === "string" &&
					params.key.trim().length > 0 &&
					explicitValue !== null
					? [{ key: params.key.trim(), value: explicitValue }]
					: [];
			})(),
		);
		logger.info(
			{
				src: "plugin:advanced-capabilities:action:settings",
				agentId: runtime.agentId,
				count: extractedSettings.length,
			},
			"Extracted settings",
		);

		// Process extracted settings
		const updateResults = await processSettingUpdates(
			runtime,
			worldId,
			worldSettings,
			extractedSettings,
		);

		// Generate appropriate response
		if (updateResults.updatedAny) {
			logger.info(
				{
					src: "plugin:advanced-capabilities:action:settings",
					agentId: runtime.agentId,
					messages: updateResults.messages,
				},
				"Successfully updated settings",
			);

			// Get updated settings state
			const updatedWorldSettings = await getWorldSettings(runtime, worldId);
			if (!updatedWorldSettings) {
				logger.error(
					{
						src: "plugin:advanced-capabilities:action:settings",
						agentId: runtime.agentId,
					},
					"Failed to retrieve updated settings state",
				);
				await generateErrorResponse(runtime, state, callback);
				return {
					text: "Failed to retrieve updated settings state",
					values: {
						success: false,
						error: "RETRIEVE_FAILED",
					},
					data: {
						actionName: "UPDATE_SETTINGS",
						error: "Failed to retrieve updated settings state",
						worldId,
					},
					success: false,
				};
			}

			await generateSuccessResponse(
				runtime,
				updatedWorldSettings,
				state,
				updateResults.messages,
				callback,
			);

			// Check if all required settings are configured
			const { requiredUnconfigured } = categorizeSettings(updatedWorldSettings);
			const allConfigured = requiredUnconfigured.length === 0;

			return {
				text: "Settings updated successfully",
				values: {
					success: true,
					settingsUpdated: extractedSettings.length,
					updatedSettings: extractedSettings.map((s) => s.key),
					remainingRequired: requiredUnconfigured.length,
					allConfigured,
					worldId,
				},
				data: {
					actionName: "UPDATE_SETTINGS",
					updatedSettingsKeys: extractedSettings.map((s) => s.key),
					updatedSettingsCount: extractedSettings.length,
					messagesCount: updateResults.messages.length,
					remainingRequired: requiredUnconfigured.map(([key, _]) => key),
					allConfigured,
					worldId: worldId ?? "",
				},
				success: true,
			};
		} else {
			logger.info(
				{
					src: "plugin:advanced-capabilities:action:settings",
					agentId: runtime.agentId,
				},
				"No settings were updated",
			);
			await generateFailureResponse(runtime, worldSettings, state, callback);

			const { requiredUnconfigured } = categorizeSettings(worldSettings);

			return {
				text: "No settings were updated",
				values: {
					success: false,
					error: "NO_UPDATES",
					remainingRequired: requiredUnconfigured.length,
					worldId,
				},
				data: {
					actionName: "UPDATE_SETTINGS",
					error: "No valid settings found in message",
					remainingRequired: requiredUnconfigured.map(([key, _]) => key),
					worldId,
				},
				success: false,
			};
		}
	},
};
