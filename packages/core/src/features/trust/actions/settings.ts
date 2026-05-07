import dedent from "dedent";
import { createUniqueUuid } from "../../../entities.ts";
import { logger } from "../../../logger.ts";
import { findWorldsForOwner } from "../../../roles.ts";
import {
	type ActionExample,
	type ActionResult,
	ChannelType,
	type Content,
	type Action as ElizaAction,
	type HandlerCallback,
	type IAgentRuntime,
	type Memory,
	ModelType,
	type Setting,
	type State,
	type WorldSettings,
} from "../../../types/index.ts";
import { hasActionContextOrKeyword } from "../../../utils/action-validation.ts";
import {
	composePrompt,
	composePromptFromState,
	parseJSONObjectFromText,
} from "../../../utils.ts";

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
	const extracted: SettingUpdate[] = [];

	const addUpdate = (rawKey: unknown, rawValue: unknown): boolean => {
		const key = typeof rawKey === "string" ? rawKey.trim() : "";
		const value = normalizeSettingValue(rawValue);
		if (!key || value === null || !worldSettings[key]) {
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
			const added = worldSettings[key] ? addUpdate(key, value) : false;
			if (!added) {
				traverse(value);
			}
		}
	};

	traverse(result);
	return extracted;
}

const messageCompletionFooter = `\n# Instructions: Write the next message for {{agentName}}. Include the appropriate action from the list: {{actionNames}}
Respond with JSON only. Return exactly one JSON object, no prose or fences.

Example:
{
  "name": "{{agentName}}",
  "text": "Message to send",
  "thought": "Short justification for the response",
  "actions": ["SETTING_UPDATED"]
}

Do not include thinking or internal reflection in the text field.
thought should be a short description of what the agent is thinking before responding, including a brief justification for the response.`;

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

const _extractionTemplate = `# Task: Extract Setting Changes from User Input

I need to extract settings that the user wants to change based on their message.

Available Settings:
{{settingsContext}}

User message: {{content}}

For each setting mentioned in the user's input, extract the key and its new value.
Return only the extracted settings as structured fields with key and value.

Example response:
updates[2]{key,value}:
  SETTING_NAME,extracted value
  ANOTHER_SETTING,another value

IMPORTANT: Only include settings from the Available Settings list above. Ignore any other potential settings.`;

function parseGeneratedContent(response: string): Content {
	const parsed = parseJSONObjectFromText(response);
	return isRecord(parsed) ? (parsed as Content) : { text: response.trim() };
}

export async function getWorldSettings(
	runtime: IAgentRuntime,
	serverId: string,
): Promise<WorldSettings | null> {
	try {
		const worldId = createUniqueUuid(runtime, serverId);
		const world = await runtime.getWorld(worldId);

		if (!world?.metadata?.settings) {
			return null;
		}

		return world.metadata.settings as WorldSettings;
	} catch (error) {
		logger.error(`Error getting settings state: ${error}`);
		return null;
	}
}

export async function updateWorldSettings(
	runtime: IAgentRuntime,
	serverId: string,
	worldSettings: WorldSettings,
): Promise<boolean> {
	try {
		const worldId = createUniqueUuid(runtime, serverId);
		const world = await runtime.getWorld(worldId);

		if (!world) {
			logger.error(`No world found for server ${serverId}`);
			return false;
		}

		if (!world.metadata) {
			world.metadata = {};
		}

		world.metadata.settings = worldSettings;

		await runtime.updateWorld(world);

		return true;
	} catch (error) {
		logger.error(`Error updating settings state: ${error}`);
		return false;
	}
}

function formatSettingsList(worldSettings: WorldSettings): string {
	const settings = (Object.entries(worldSettings) as [string, Setting][])
		.filter(([key, setting]) => !key.startsWith("_") && setting != null)
		.map(([key, setting]) => {
			const status = setting.value !== null ? "Configured" : "Not configured";
			const required = setting.required ? "Required" : "Optional";
			return `- ${setting.name} (${key}): ${status}, ${required}`;
		})
		.join("\n");

	return settings || "No settings available";
}

function categorizeSettings(worldSettings: WorldSettings): {
	configured: [string, Setting][];
	requiredUnconfigured: [string, Setting][];
	optionalUnconfigured: [string, Setting][];
} {
	const configured: [string, Setting][] = [];
	const requiredUnconfigured: [string, Setting][] = [];
	const optionalUnconfigured: [string, Setting][] = [];

	for (const [key, setting] of Object.entries(worldSettings) as [
		string,
		Setting,
	][]) {
		if (key.startsWith("_")) continue;

		if (setting.value !== null) {
			configured.push([key, setting]);
		} else if (setting.required) {
			requiredUnconfigured.push([key, setting]);
		} else {
			optionalUnconfigured.push([key, setting]);
		}
	}

	return { configured, requiredUnconfigured, optionalUnconfigured };
}

async function extractSettingValues(
	runtime: IAgentRuntime,
	_message: Memory,
	state: State,
	worldSettings: WorldSettings,
	explicitUpdates: SettingUpdate[] = [],
): Promise<SettingUpdate[]> {
	if (explicitUpdates.length > 0) {
		return explicitUpdates.filter((update) => worldSettings[update.key]);
	}

	const { requiredUnconfigured, optionalUnconfigured } =
		categorizeSettings(worldSettings);

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

	try {
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
				contextCheckLevel: 0,
				maxRetries: 1,
			},
		});

		if (!result) {
			return [];
		}

		return extractValidSettings(result, worldSettings);
	} catch (error) {
		logger.error({ error }, "Error extracting settings:");
		return [];
	}
}

async function processSettingUpdates(
	runtime: IAgentRuntime,
	serverId: string,
	worldSettings: WorldSettings,
	updates: SettingUpdate[],
): Promise<{ updatedAny: boolean; messages: string[] }> {
	if (!updates.length) {
		return { updatedAny: false, messages: [] };
	}

	const messages: string[] = [];
	let updatedAny = false;

	try {
		const updatedState = { ...worldSettings };

		for (const update of updates) {
			const setting = updatedState[update.key] as Setting | undefined;
			if (!setting) continue;

			if (setting.dependsOn?.length) {
				const dependenciesMet = setting.dependsOn.every(
					(dep) => (updatedState[dep] as Setting | undefined)?.value !== null,
				);
				if (!dependenciesMet) {
					messages.push(`Cannot update ${setting.name} - dependencies not met`);
					continue;
				}
			}

			updatedState[update.key] = {
				...setting,
				value: update.value,
			};

			messages.push(`Updated ${setting.name} successfully`);
			updatedAny = true;

			if (setting.onSetAction) {
				const actionMessage = setting.onSetAction(update.value);
				if (actionMessage) {
					messages.push(actionMessage);
				}
			}
		}

		if (updatedAny) {
			const saved = await updateWorldSettings(runtime, serverId, updatedState);

			if (!saved) {
				throw new Error("Failed to save updated state to world metadata");
			}

			const savedState = await getWorldSettings(runtime, serverId);
			if (!savedState) {
				throw new Error("Failed to verify state save");
			}
		}

		return { updatedAny, messages };
	} catch (error) {
		logger.error({ error }, "Error processing setting updates:");
		return {
			updatedAny: false,
			messages: ["Error occurred while updating settings"],
		};
	}
}

async function handleOnboardingComplete(
	runtime: IAgentRuntime,
	worldSettings: WorldSettings,
	_state: State,
	callback: HandlerCallback,
): Promise<void> {
	try {
		const prompt = composePrompt({
			state: {
				settingsStatus: formatSettingsList(worldSettings),
			},
			template: completionTemplate,
		});

		const response = await runtime.useModel(ModelType.TEXT_LARGE, {
			prompt,
		});

		const responseContent = parseGeneratedContent(response);

		await callback({
			text: responseContent.text,
			actions: ["ONBOARDING_COMPLETE"],
			source: "discord",
		});
	} catch (error) {
		logger.error(`Error handling settings completion: ${error}`);
		await callback({
			text: "Great! All required settings have been configured. Your server is now fully set up and ready to use.",
			actions: ["ONBOARDING_COMPLETE"],
			source: "discord",
		});
	}
}

async function generateSuccessResponse(
	runtime: IAgentRuntime,
	worldSettings: WorldSettings,
	state: State,
	messages: string[],
	callback: HandlerCallback,
): Promise<void> {
	try {
		const { requiredUnconfigured } = categorizeSettings(worldSettings);

		if (requiredUnconfigured.length === 0) {
			await handleOnboardingComplete(runtime, worldSettings, state, callback);
			return;
		}

		const requiredUnconfiguredString = requiredUnconfigured
			.map(([key, setting]) => `${key}: ${setting.name}`)
			.join("\n");

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
		});

		const responseContent = parseGeneratedContent(response);

		await callback({
			text: responseContent.text,
			actions: ["SETTING_UPDATED"],
			source: "discord",
		});
	} catch (error) {
		logger.error(`Error generating success response: ${error}`);
		await callback({
			text: "Settings updated successfully. Please continue with the remaining configuration.",
			actions: ["SETTING_UPDATED"],
			source: "discord",
		});
	}
}

async function generateFailureResponse(
	runtime: IAgentRuntime,
	worldSettings: WorldSettings,
	state: State,
	callback: HandlerCallback,
): Promise<void> {
	try {
		const { requiredUnconfigured } = categorizeSettings(worldSettings);

		if (requiredUnconfigured.length === 0) {
			await handleOnboardingComplete(runtime, worldSettings, state, callback);
			return;
		}

		const requiredUnconfiguredString = requiredUnconfigured
			.map(([key, setting]) => `${key}: ${setting.name}`)
			.join("\n");

		const prompt = composePrompt({
			state: {
				nextSetting: requiredUnconfiguredString,
				remainingRequired: requiredUnconfigured.length.toString(),
			},
			template: failureTemplate,
		});

		const response = await runtime.useModel(ModelType.TEXT_LARGE, {
			prompt,
		});

		const responseContent = parseGeneratedContent(response);

		await callback({
			text: responseContent.text,
			actions: ["SETTING_UPDATE_FAILED"],
			source: "discord",
		});
	} catch (error) {
		logger.error(`Error generating failure response: ${error}`);
		await callback({
			text: "I couldn't understand your settings update. Please try again with a clearer format.",
			actions: ["SETTING_UPDATE_FAILED"],
			source: "discord",
		});
	}
}

async function generateErrorResponse(
	runtime: IAgentRuntime,
	state: State,
	callback: HandlerCallback,
): Promise<void> {
	try {
		const prompt = composePromptFromState({
			state,
			template: errorTemplate,
		});

		const response = await runtime.useModel(ModelType.TEXT_LARGE, {
			prompt,
		});

		const responseContent = parseGeneratedContent(response);

		await callback({
			text: responseContent.text,
			actions: ["SETTING_UPDATE_ERROR"],
			source: "discord",
		});
	} catch (error) {
		logger.error(`Error generating error response: ${error}`);
		await callback({
			text: "I'm sorry, but I encountered an error while processing your request. Please try again or contact support if the issue persists.",
			actions: ["SETTING_UPDATE_ERROR"],
			source: "discord",
		});
	}
}

export const updateSettingsAction: ElizaAction = {
	name: "TRUST_UPDATE_SETTINGS",
	contexts: ["settings", "admin"],
	roleGate: { minRole: "OWNER" },
	suppressPostActionContinuation: true,
	similes: ["UPDATE_SETTING", "SAVE_SETTING", "SET_CONFIGURATION", "CONFIGURE"],
	description:
		"Saves a configuration setting during the onboarding process, or update an existing setting. Use this when you are onboarding with a world owner or admin.",
	parameters: [
		{
			name: "key",
			description: "Exact setting key to update.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "value",
			description:
				"Setting value to save. Use strings for text settings and boolean-like settings.",
			required: false,
			schema: { type: "string" as const },
		},
	],

	validate: async (
		runtime: IAgentRuntime,
		message: Memory,
		state?: State,
		options?: Record<string, unknown>,
	): Promise<boolean> => {
		const params =
			options?.parameters && typeof options.parameters === "object"
				? (options.parameters as Record<string, unknown>)
				: {};
		const hasStructuredUpdate =
			typeof params.key === "string" && params.key.trim().length > 0;
		const hasSettingsIntent =
			hasStructuredUpdate ||
			hasActionContextOrKeyword(message, state, {
				contexts: ["settings", "secrets", "connectors"],
				keywords: [
					"update settings",
					"save setting",
					"set configuration",
					"configure setting",
				],
			});
		if (!hasSettingsIntent || message.content.channelType !== ChannelType.DM) {
			return false;
		}

		try {
			const worlds = await findWorldsForOwner(runtime, message.entityId);
			if (!worlds) {
				return false;
			}

			const world = worlds.find((world) => world.metadata?.settings);
			const worldSettings = world?.metadata?.settings;

			return Boolean(worldSettings);
		} catch (error) {
			logger.error(`Error validating settings action: ${error}`);
			return false;
		}
	},

	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		state?: State,
		_options?: Record<string, unknown>,
		callback?: HandlerCallback,
	): Promise<ActionResult> => {
		try {
			if (!state) {
				throw new Error("State is required for settings handler");
			}

			if (!message) {
				throw new Error("Message is required for settings handler");
			}

			if (!callback) {
				throw new Error("Callback is required for settings handler");
			}

			const worlds = await findWorldsForOwner(runtime, message.entityId);
			const serverOwnership = worlds?.find((world) => world.metadata?.settings);
			if (!serverOwnership) {
				await generateErrorResponse(runtime, state, callback);
				return {
					success: false,
					text: "No server found where you are the owner",
					data: {
						actionName: "TRUST_UPDATE_SETTINGS",
						error: "NO_SERVER_OWNERSHIP",
					},
				};
			}

			const serverId = serverOwnership?.messageServerId;

			if (!serverId) {
				return {
					success: false,
					text: "No server ID found",
					data: { actionName: "TRUST_UPDATE_SETTINGS", error: "NO_SERVER_ID" },
				};
			}

			const worldSettings = await getWorldSettings(runtime, serverId);

			if (!worldSettings) {
				await generateErrorResponse(runtime, state, callback);
				return {
					success: false,
					text: "No settings state found for server",
					data: {
						actionName: "TRUST_UPDATE_SETTINGS",
						error: "NO_SETTINGS_STATE",
					},
				};
			}

			const params =
				_options?.parameters && typeof _options.parameters === "object"
					? (_options.parameters as Record<string, unknown>)
					: {};
			const explicitValue = normalizeSettingValue(params.value);
			const explicitUpdates =
				typeof params.key === "string" &&
				params.key.trim().length > 0 &&
				explicitValue !== null
					? [{ key: params.key.trim(), value: explicitValue }]
					: [];
			const extractedSettings = await extractSettingValues(
				runtime,
				message,
				state,
				worldSettings,
				explicitUpdates,
			);

			const updateResults = await processSettingUpdates(
				runtime,
				serverId,
				worldSettings,
				extractedSettings,
			);

			if (updateResults.updatedAny) {
				const updatedWorldSettings = await getWorldSettings(runtime, serverId);
				if (!updatedWorldSettings) {
					await generateErrorResponse(runtime, state, callback);
					return {
						success: false,
						text: "Failed to retrieve updated settings state",
						data: {
							actionName: "TRUST_UPDATE_SETTINGS",
							error: "SETTINGS_RETRIEVAL_FAILED",
						},
					};
				}

				await generateSuccessResponse(
					runtime,
					updatedWorldSettings,
					state,
					updateResults.messages,
					callback,
				);

				return {
					success: true,
					text: updateResults.messages.join(". "),
					data: {
						actionName: "TRUST_UPDATE_SETTINGS",
						success: true,
						updatedSettings: extractedSettings,
						messages: updateResults.messages,
					},
				};
			} else {
				await generateFailureResponse(runtime, worldSettings, state, callback);

				return {
					success: false,
					text: "No settings were updated from your message",
					data: {
						actionName: "TRUST_UPDATE_SETTINGS",
						success: false,
						reason: "NO_VALID_SETTINGS_FOUND",
					},
				};
			}
		} catch (error) {
			logger.error(`Error in settings handler: ${error}`);
			if (state && callback) {
				await generateErrorResponse(runtime, state, callback);
			}

			return {
				success: false,
				text: "An error occurred while updating settings",
				data: {
					actionName: "TRUST_UPDATE_SETTINGS",
					error: error instanceof Error ? error.message : "UNKNOWN_ERROR",
				},
			};
		}
	},
	examples: [
		[
			{
				name: "{{name1}}",
				content: {
					text: "I want to set up the welcome channel to #general",
					source: "discord",
				},
			},
			{
				name: "{{name2}}",
				content: {
					text: "Perfect! I've updated your welcome channel to #general. Next, we should configure the automated greeting message.",
					actions: ["SETTING_UPDATED"],
					source: "discord",
				},
			},
		],
		[
			{
				name: "{{name1}}",
				content: { text: "Let's set the bot prefix to !", source: "discord" },
			},
			{
				name: "{{name2}}",
				content: {
					text: "Great choice! I've set the command prefix to '!'. Now you can use commands like !help, !info, etc.",
					actions: ["SETTING_UPDATED"],
					source: "discord",
				},
			},
		],
	] as ActionExample[][],
};
