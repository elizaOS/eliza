// File: /swarm/shared/settings/provider.ts
// Updated to use world metadata instead of cache

import { logger } from "../logger";
import { findWorldForOwner } from "../roles";
import { getWorldSettings } from "../settings";
import {
	ChannelType,
	type IAgentRuntime,
	type Memory,
	type Provider,
	type ProviderResult,
	type Setting,
	type State,
	type WorldSettings,
} from "../types";

/**
 * Formats a setting value for display, respecting privacy flags
 */
const formatSettingValue = (
	setting: Setting,
	isOnboarding: boolean,
): string => {
	if (setting.value === null) return "Not set";
	if (setting.secret && !isOnboarding) return "****************";
	return String(setting.value);
};

/**
 * Generates a status message based on the current settings state
 */
function generateStatusMessage(
	runtime: IAgentRuntime,
	worldSettings: WorldSettings,
	isOnboarding: boolean,
	state?: State,
): string {
	try {
		// Format settings for display
		const formattedSettings = Object.entries(worldSettings)
			.map(([key, setting]) => {
				if (typeof setting !== "object" || !setting.name) return null;

				const description = setting.description || "";
				const usageDescription = setting.usageDescription || "";

				// Skip settings that should be hidden based on visibility function
				if (setting.visibleIf && !setting.visibleIf(worldSettings)) {
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

		// Count required settings that are not configured
		const requiredUnconfigured = formattedSettings.filter(
			(s) => s.required && !s.configured,
		).length;

		// Generate appropriate message
		if (isOnboarding) {
			if (requiredUnconfigured > 0) {
				return `# PRIORITY TASK: Onboarding with ${state.senderName}\n${
					runtime.character.name
				} still needs to configure ${requiredUnconfigured} required settings:\n\n${formattedSettings
					.filter((s) => s.required && !s.configured)
					.map((s) => `${s.key}: ${s.value}\n(${s.name}) ${s.usageDescription}`)
					.join("\n\n")}\n\nValid settings keys: ${Object.keys(
					worldSettings,
				).join(
					", ",
				)}\n\nIf the user gives any information related to the settings, ${
					runtime.character.name
				} should use the UPDATE_SETTINGS action to update the settings with this new information. ${
					runtime.character.name
				} can update any, some or all settings.`;
			}
			return `All required settings have been configured! Here's the current configuration:\n\n${formattedSettings
				.map((s) => `${s.name}: ${s.description}\nValue: ${s.value}`)
				.join("\n")}`;
		}
		// Non-onboarding context - list all public settings with values and descriptions
		return `## Current Configuration\n\n${
			requiredUnconfigured > 0
				? `IMPORTANT!: ${requiredUnconfigured} required settings still need configuration. ${runtime.character.name} should get onboarded with the OWNER as soon as possible.\n\n`
				: "All required settings are configured.\n\n"
		}${formattedSettings
			.map(
				(s) =>
					`### ${s.name}\n**Value:** ${s.value}\n**Description:** ${s.description}`,
			)
			.join("\n\n")}`;
	} catch (error) {
		logger.error(`Error generating status message: ${error}`);
		return "Error generating configuration status.";
	}
}

/**
 * Creates an settings provider with the given configuration
 * Updated to use world metadata instead of cache
 */
export const settingsProvider: Provider = {
	name: "SETTINGS",
	description: "Current settings for the server",
	get: async (
		runtime: IAgentRuntime,
		message: Memory,
		state?: State,
	): Promise<ProviderResult> => {
		try {
			// Parallelize the initial database operations to improve performance
			// These operations can run simultaneously as they don't depend on each other
			const [room, userWorld] = await Promise.all([
				runtime.getRoom(message.roomId),
				findWorldForOwner(runtime, message.entityId),
			]).catch((error) => {
				logger.error(`Error fetching initial data: ${error}`);
				throw new Error("Failed to retrieve room or user world information");
			});

			if (!room) {
				logger.error("No room found for settings provider");
				return {
					data: {
						settings: [],
					},
					values: {
						settings: "Error: Room not found",
					},
					text: "Error: Room not found",
				};
			}

			const type = room.type;
			const isOnboarding = type === ChannelType.DM;

			let world;
			let serverId;
			let worldSettings;

			if (isOnboarding) {
				// In onboarding mode, use the user's world directly
				world = userWorld;

				if (!world) {
					logger.error("No world found for user during onboarding");
					throw new Error("No server ownership found for onboarding");
				}

				serverId = world.serverId;

				// Fetch world settings based on the server ID
				try {
					worldSettings = await getWorldSettings(runtime, serverId);
				} catch (error) {
					logger.error(`Error fetching world settings: ${error}`);
					throw new Error(`Failed to retrieve settings for server ${serverId}`);
				}
			} else {
				// For non-onboarding, we need to get the world associated with the room
				try {
					world = await runtime.getWorld(room.worldId);
					console.log("*** world", world);
					console.log("*** room", room);
					
					serverId = world.serverId;

					// Once we have the serverId, get the settings
					if (serverId) {
						worldSettings = await getWorldSettings(runtime, serverId);
					} else {
						logger.error(`No server ID found for world ${room.worldId}`);
					}
				} catch (error) {
					logger.error(`Error processing world data: ${error}`);
					throw new Error("Failed to process world information");
				}
			}

			// If no server found after recovery attempts
			if (!serverId) {
				logger.info(
					`No server ownership found for user ${message.entityId} after recovery attempt`,
				);
				return isOnboarding
					? {
							data: {
								settings: [],
							},
							values: {
								settings:
									"The user doesn't appear to have ownership of any servers. They should make sure they're using the correct account.",
							},
							text: "The user doesn't appear to have ownership of any servers. They should make sure they're using the correct account.",
						}
					: {
							data: {
								settings: [],
							},
							values: {
								settings: "Error: No configuration access",
							},
							text: "Error: No configuration access",
						};
			}

			if (!worldSettings) {
				logger.info(`No settings state found for server ${serverId}`);
				return isOnboarding
					? {
							data: {
								settings: [],
							},
							values: {
								settings:
									"The user doesn't appear to have any settings configured for this server. They should configure some settings for this server.",
							},
							text: "The user doesn't appear to have any settings configured for this server. They should configure some settings for this server.",
						}
					: {
							data: {
								settings: [],
							},
							values: {
								settings: "Configuration has not been completed yet.",
							},
							text: "Configuration has not been completed yet.",
						};
			}

			// Generate the status message based on the settings
			const output = generateStatusMessage(
				runtime,
				worldSettings,
				isOnboarding,
				state,
			);

			return {
				data: {
					settings: worldSettings,
				},
				values: {
					settings: output,
				},
				text: output,
			};
		} catch (error) {
			logger.error(`Critical error in settings provider: ${error}`);
			return {
				data: {
					settings: [],
				},
				values: {
					settings:
						"Error retrieving configuration information. Please try again later.",
				},
				text: "Error retrieving configuration information. Please try again later.",
			};
		}
	},
};
