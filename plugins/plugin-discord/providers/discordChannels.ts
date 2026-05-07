import type {
	IAgentRuntime,
	Memory,
	Provider,
	ProviderResult,
	State,
} from "@elizaos/core";
import { DISCORD_SERVICE_NAME } from "../constants";
import { requireProviderSpec } from "../generated/specs/spec-helpers";
import type { DiscordService } from "../service";

const spec = requireProviderSpec("discordChannels");

interface DiscordChannelEntry {
	id: string;
	name: string;
	mention: string;
	server: string;
}

export const discordChannelsProvider: Provider = {
	name: spec.name,
	description: spec.description,
	descriptionCompressed: spec.descriptionCompressed,
	dynamic: true,
	contexts: ["social", "connectors"],
	get: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state: State,
	): Promise<ProviderResult> => {
		if (message.content.source !== "discord") {
			return { data: {}, values: {}, text: "" };
		}

		const discordService = runtime.getService(
			DISCORD_SERVICE_NAME,
		) as DiscordService;
		if (!discordService?.client) {
			return { data: {}, values: {}, text: "" };
		}

		const allowedChannelIds = discordService.getAllowedChannels();
		if (allowedChannelIds.length === 0) {
			return {
				data: { listeningToAll: true, channels: [] },
				values: { listeningToAll: true, channelCount: 0 },
				text: JSON.stringify({
					discord_channels: { listening_to_all: true, count: 0, items: [] },
				}),
			};
		}

		const channelInfos: DiscordChannelEntry[] = [];
		for (const channelId of allowedChannelIds) {
			const channel = discordService.client
				? await discordService.client.channels
						.fetch(channelId)
						.catch(() => null)
				: null;
			if (channel?.isTextBased() && !channel.isVoiceBased()) {
				const guild = "guild" in channel ? channel.guild : null;
				channelInfos.push({
					id: channelId,
					name: "name" in channel ? (channel.name ?? "DM") : "DM",
					mention: `<#${channelId}>`,
					server: guild?.name ?? "Direct Message",
				});
			} else if (!channel) {
				channelInfos.push({
					id: channelId,
					name: "Unknown",
					mention: channelId,
					server: "Unknown or Deleted",
				});
			}
		}

		channelInfos.sort((a, b) => a.server.localeCompare(b.server));

		return {
			data: { listeningToAll: false, channels: channelInfos },
			values: {
				listeningToAll: false,
				channelCount: channelInfos.length,
			},
			text: JSON.stringify({
				discord_channels: {
					listening_to_all: false,
					count: channelInfos.length,
					items: channelInfos,
				},
			}),
		};
	},
};

export default discordChannelsProvider;
