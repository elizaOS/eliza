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

const spec = requireProviderSpec("discordServerInfo");

interface ServerInfoEntry {
	id: string;
	name: string;
	ownerId: string;
	createdAt: string;
	memberCount: number;
	channelCount: number;
	roleCount: number;
	premiumTier: number;
	premiumSubscriptionCount: number;
	textChannels: number;
	voiceChannels: number;
	categories: number;
	description: string | null;
	vanityUrlCode: string | null;
}

export const discordServerInfoProvider: Provider = {
	name: spec.name,
	description: spec.description,
	descriptionCompressed: spec.descriptionCompressed,
	dynamic: true,
	contexts: ["social", "connectors"],
	get: async (
		runtime: IAgentRuntime,
		message: Memory,
		state: State,
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

		const room = state.data?.room || (await runtime.getRoom(message.roomId));
		const serverId = room?.messageServerId;
		if (!serverId) {
			return { data: {}, values: {}, text: "" };
		}

		const guild = await discordService.client.guilds
			.fetch(serverId)
			.catch(() => null);
		if (!guild) {
			return { data: {}, values: {}, text: "" };
		}

		let textChannels = 0;
		let voiceChannels = 0;
		let categories = 0;
		guild.channels.cache.forEach((channel) => {
			if (channel.isTextBased() && !channel.isVoiceBased()) textChannels++;
			else if (channel.isVoiceBased()) voiceChannels++;
			else if (channel.type === 4) categories++;
		});

		const entry: ServerInfoEntry = {
			id: guild.id,
			name: guild.name,
			ownerId: guild.ownerId,
			createdAt: guild.createdAt.toISOString(),
			memberCount: guild.memberCount,
			channelCount: guild.channels.cache.size,
			roleCount: guild.roles.cache.size,
			premiumTier: guild.premiumTier,
			premiumSubscriptionCount: guild.premiumSubscriptionCount ?? 0,
			textChannels,
			voiceChannels,
			categories,
			description: guild.description,
			vanityUrlCode: guild.vanityURLCode,
		};

		return {
			data: { server: entry },
			values: {
				serverId: entry.id,
				serverName: entry.name,
				memberCount: entry.memberCount,
				channelCount: entry.channelCount,
			},
			text: JSON.stringify({ discord_server: entry }),
		};
	},
};

export default discordServerInfoProvider;
