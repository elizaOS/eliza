import { getVoiceConnection } from "@discordjs/voice";
import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import { ChannelType } from "@elizaos/core";

const voiceStateProvider: Provider = {
	name: "voiceState",
	get: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
		// Voice doesn't get a discord message, so we need to use the channel for guild data
		const room = await runtime.getDatabaseAdapter().getRoom(message.roomId);
		if (!room) {
			throw new Error("No room found");
		}

		if (room.type !== ChannelType.GROUP) {
			// only handle in a group scenario for now
			return {
				data: {
					isInVoiceChannel: false,
					room,
				},
				values: {
					isInVoiceChannel: "false",
					roomType: room.type,
				},
				text: "",
			};
		}

		const serverId = room.serverId;

		if (!serverId) {
			throw new Error("No server ID found 10");
		}

		const connection = getVoiceConnection(serverId);
		const agentName = state?.agentName || "The agent";

		if (!connection) {
			return {
				data: {
					isInVoiceChannel: false,
					room,
					serverId,
				},
				values: {
					isInVoiceChannel: "false",
					serverId,
				},
				text: `${agentName} is not currently in a voice channel`,
			};
		}

		const worldId = room.worldId;

		// get the world from the runtime.getDatabaseAdapter().getWorld
		const world = await runtime.getDatabaseAdapter().getWorld(worldId);

		if (!world) {
			throw new Error("No world found");
		}

		const worldName = world.name;
		const roomType = room.type;
		const channelId = room.channelId;
		const channelName = room.name;

		if (!channelId) {
			return {
				data: {
					isInVoiceChannel: true,
					room,
					serverId,
					world,
					connection,
				},
				values: {
					isInVoiceChannel: "true",
					serverId,
					worldName,
					roomType,
				},
				text: `${agentName} is in an invalid voice channel`,
			};
		}

		return {
			data: {
				isInVoiceChannel: true,
				room,
				serverId,
				world,
				connection,
				channelId,
				channelName,
			},
			values: {
				isInVoiceChannel: "true",
				serverId,
				worldName,
				roomType,
				channelId,
				channelName,
			},
			text: `${agentName} is currently in the voice channel: ${channelName} (ID: ${channelId})`,
		};
	},
};

export default voiceStateProvider;
