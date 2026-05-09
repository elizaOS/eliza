import { logger } from "../../../logger.ts";
import { findWorldsForOwner } from "../../../roles.ts";
import { getWorldSettings } from "../../../settings.ts";
import {
	ChannelType,
	type IAgentRuntime,
	type Memory,
	type Provider,
	type ProviderResult,
	type Setting,
	type State,
	type World,
	type WorldSettings,
} from "../../../types/index.ts";

function isSettingEntry(value: unknown): value is Setting {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		"name" in value &&
		"value" in value
	);
}

function worldSettingEntries(
	worldSettings: WorldSettings,
): Array<[string, Setting]> {
	return Object.entries(worldSettings).filter(
		(entry): entry is [string, Setting] =>
			entry[0] !== "settings" && isSettingEntry(entry[1]),
	);
}

const formatSettingValue = (
	setting: Setting,
	isOnboarding: boolean,
): string => {
	if (setting.value === null) return "Not set";
	if (setting.secret && !isOnboarding) return "****************";
	return String(setting.value);
};

function generateStatusMessage(
	runtime: IAgentRuntime,
	worldSettings: WorldSettings,
	isOnboarding: boolean,
	state?: State,
): string {
	try {
		const settingsByKey = Object.fromEntries(worldSettingEntries(worldSettings));
		const formattedSettings = Object.entries(settingsByKey)
			.map(([key, setting]) => {
				const description = setting.description || "";
				const usageDescription = setting.usageDescription || "";

				if (
					setting.visibleIf &&
					!setting.visibleIf(settingsByKey)
				) {
					return null;
				}

				return {
					key,
					name: setting.name,
					value: formatSettingValue(setting, isOnboarding),
					description,
					usageDescription,
					required: setting.required,
					configured: setting.value !== null,
				};
			})
			.filter(Boolean);

		const requiredUnconfigured = formattedSettings.filter(
			(s) => s?.required && !s.configured,
		).length;

		if (isOnboarding) {
			const settingsList = formattedSettings
				.map((s) => {
					const label = s?.required ? "(Required)" : "(Optional)";
					return `${s?.key}: ${s?.value} ${label}\n(${s?.name}) ${s?.usageDescription}`;
				})
				.join("\n\n");

			const validKeys = `Valid setting keys: ${Object.keys(worldSettings).join(", ")}`;

			const commonInstructions = `Instructions for ${runtime.character.name}:
      - Only update settings if the user is clearly responding to a setting you are currently asking about.
      - If the user's reply clearly maps to a trust setting and a valid value, call the corresponding settings update action with the correct key and value. Do not just respond with a message saying it's updated -- it must be an action.
      - Never hallucinate settings or respond with values not listed above.
      - Do not update a setting just because the user has started onboarding or you think a setting needs to be configured. Only update when the user clearly provides a specific value for a trust setting you are currently asking about.
      - Answer setting-related questions using only the name, description, and value from the list.`;

			if (requiredUnconfigured > 0) {
				return `# PRIORITY TASK: Onboarding with ${state?.senderName}

        ${runtime.character.name} needs to help the user configure ${requiredUnconfigured} required settings:

        ${settingsList}

        ${validKeys}

        ${commonInstructions}

        - Prioritize configuring required settings before optional ones.`;
			}

			return `All required settings have been configured. Here's the current configuration:

        ${settingsList}

        ${validKeys}

        ${commonInstructions}`;
		}

		return `## Current Configuration\n\n${
			requiredUnconfigured > 0
				? `IMPORTANT!: ${requiredUnconfigured} required settings still need configuration. ${runtime.character.name} should get onboarded with the OWNER as soon as possible.\n\n`
				: "All required settings are configured.\n\n"
		}${formattedSettings
			.map(
				(s) =>
					`### ${s?.name}\n**Value:** ${s?.value}\n**Description:** ${s?.description}`,
			)
			.join("\n\n")}`;
	} catch (error) {
		logger.error(`Error generating status message: ${error}`);
		return "Error generating configuration status.";
	}
}

export const settingsProvider: Provider = {
	name: "SETTINGS",
	description: "Current settings for the server",
	dynamic: true,
	contexts: ["settings"],
	contextGate: { anyOf: ["settings"] },
	cacheStable: false,
	cacheScope: "turn",
	roleGate: { minRole: "ADMIN" },

	get: async (
		runtime: IAgentRuntime,
		message: Memory,
		state?: State,
	): Promise<ProviderResult> => {
		try {
			const [room, userWorlds] = await Promise.all([
				runtime.getRoom(message.roomId),
				findWorldsForOwner(runtime, message.entityId),
			]).catch((error) => {
				logger.error(`Error fetching initial data: ${error}`);
				throw new Error("Failed to retrieve room or user world information");
			});

			if (!room) {
				return {
					data: { settings: [] },
					values: { settings: "No room context available for settings." },
					text: "No room context available for settings.",
				};
			}

			if (!room.worldId) {
				return {
					data: { settings: [] },
					values: {
						settings:
							"Room does not have a worldId -- settings provider will be skipped",
					},
					text: "Room does not have a worldId -- settings provider will be skipped",
				};
			}

			const type = room.type;
			const isOnboarding = type === ChannelType.DM;

			let world: World | null | undefined = null;
			let serverId: string | undefined;
			let worldSettings: WorldSettings | null = null;

			if (isOnboarding) {
				world = userWorlds?.find(
					(world) => world.metadata?.settings !== undefined,
				);

				if (!world && userWorlds && userWorlds.length > 0) {
					world = userWorlds[0];
					if (!world.metadata) {
						world.metadata = {};
					}
					world.metadata.settings = {};
					await runtime.updateWorld(world);
				}

				if (!world) {
					logger.warn(
						{
							src: "trust:provider:settings",
							agentId: runtime.agentId,
						},
						"No world found for user during onboarding -- settings provider will be skipped",
					);
					return {
						data: { settings: [] },
						values: {
							settings:
								"No onboarding world found for the user -- settings provider will be skipped",
						},
						text: "No onboarding world found for the user -- settings provider will be skipped",
					};
				}

				serverId = world.messageServerId;

				try {
					if (!serverId) {
						throw new Error(`No server ID found for world ${world.id}`);
					}
					worldSettings = await getWorldSettings(runtime, serverId);
				} catch (error) {
					logger.error(`Error fetching world settings: ${error}`);
					throw new Error(`Failed to retrieve settings for server ${serverId}`);
				}
			} else {
				try {
					world = await runtime.getWorld(room.worldId);

					if (!world) {
						throw new Error(`No world found for room ${room.worldId}`);
					}

					serverId = world.messageServerId;

					if (serverId) {
						worldSettings = await getWorldSettings(runtime, serverId);
					}
				} catch (error) {
					logger.error(`Error processing world data: ${error}`);
					throw new Error("Failed to process world information");
				}
			}

			if (!serverId) {
				return isOnboarding
					? {
							data: { settings: [] },
							values: {
								settings:
									"The user doesn't appear to have ownership of any servers. They should make sure they're using the correct account.",
							},
							text: "The user doesn't appear to have ownership of any servers.",
						}
					: {
							data: { settings: [] },
							values: { settings: "Error: No configuration access" },
							text: "Error: No configuration access",
						};
			}

			if (!worldSettings) {
				return isOnboarding
					? {
							data: { settings: [] },
							values: {
								settings:
									"The user doesn't appear to have any settings configured for this server.",
							},
							text: "The user doesn't appear to have any settings configured for this server.",
						}
					: {
							data: { settings: [] },
							values: { settings: "Configuration has not been completed yet." },
							text: "Configuration has not been completed yet.",
						};
			}

			const output = generateStatusMessage(
				runtime,
				worldSettings,
				isOnboarding,
				state,
			);

			return {
				data: { settings: worldSettings },
				values: { settings: output },
				text: output,
			};
		} catch (error) {
			logger.error(`Critical error in settings provider: ${error}`);
			return {
				data: { settings: [] },
				values: {
					settings:
						"Error retrieving configuration information. Please try again later.",
				},
				text: "Error retrieving configuration information. Please try again later.",
			};
		}
	},
};
