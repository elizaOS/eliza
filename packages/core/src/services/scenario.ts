import { v4 as uuidv4 } from "uuid";
import { createUniqueUuid } from "../entities";
import { logger } from "../logger";
import {
	ChannelType,
	type HandlerCallback,
	type IAgentRuntime,
	type Memory,
	Service,
	type UUID,
} from "../types";

export class ScenarioService extends Service {
	static serviceType = "scenario";
	capabilityDescription =
		"The agent is currently in a scenario testing environment. It can create rooms, send messages, and talk to other agents in a live interactive testing environment.";
	private messageHandlers: Map<UUID, HandlerCallback[]> = new Map();
	private rooms: Map<string, { roomId: UUID }> = new Map();

	constructor(protected runtime: IAgentRuntime) {
		super(runtime);
	}

	static async start(runtime: IAgentRuntime) {
		const service = new ScenarioService(runtime);
		return service;
	}

	static async stop(runtime: IAgentRuntime) {
		// get the service from the runtime
		const service = runtime.getService(ScenarioService.serviceType);
		if (!service) {
			throw new Error("Scenario service not found");
		}
		service.stop();
	}

	async stop() {
		this.messageHandlers.clear();
		this.rooms.clear();
	}

	// Create a room for an agent
	async createRoom(agentId: string, name?: string) {
		const roomId = uuidv4() as UUID;

		await this.runtime.ensureRoomExists({
			id: roomId as UUID,
			name: name || `Room for ${agentId}`,
			source: "scenario",
			type: ChannelType.GROUP,
			channelId: roomId,
			serverId: null,
		});

		this.rooms.set(agentId, { roomId: roomId as UUID });
	}

	// Save a message in all agents' memory without emitting events
	async saveMessage(
		sender: IAgentRuntime,
		receivers: IAgentRuntime[],
		text: string,
	) {
		for (const receiver of receivers) {
			const roomData = this.rooms.get(receiver.agentId);
			if (!roomData) continue;
			const entityId = createUniqueUuid(receiver, sender.agentId);

			// Ensure connection exists
			await receiver.ensureConnection({
				entityId,
				roomId: roomData.roomId,
				userName: sender.character.name,
				name: sender.character.name,
				source: "scenario",
				type: ChannelType.GROUP,
			});

			const memory: Memory = {
				entityId,
				agentId: receiver.agentId,
				roomId: roomData.roomId,
				content: {
					text,
					source: "scenario",
					name: sender.character.name,
					userName: sender.character.name,
					channelType: ChannelType.GROUP,
				},
			};

			await receiver.getMemoryManager("messages").createMemory(memory);
		}
	}

	// Send a live message that triggers handlers
	async sendMessage(
		sender: IAgentRuntime,
		receivers: IAgentRuntime[],
		text: string,
	) {
		for (const receiver of receivers) {
			const roomData = this.rooms.get(receiver.agentId);
			if (!roomData) continue;

			const entityId = createUniqueUuid(receiver, sender.agentId);

			if (receiver.agentId !== sender.agentId) {
				// Ensure connection exists
				await receiver.ensureConnection({
					entityId,
					roomId: roomData.roomId,
					userName: sender.character.name,
					name: sender.character.name,
					source: "scenario",
					type: ChannelType.GROUP,
				});
			} else {
				await receiver.ensureConnection({
					entityId: sender.agentId,
					roomId: roomData.roomId,
					userName: sender.character.name,
					name: sender.character.name,
					source: "scenario",
					type: ChannelType.GROUP,
				});
			}

			const memory: Memory = {
				entityId:
					receiver.agentId !== sender.agentId ? entityId : sender.agentId,
				agentId: receiver.agentId,
				roomId: roomData.roomId,
				content: {
					text,
					source: "scenario",
					name: sender.character.name,
					userName: sender.character.name,
					channelType: ChannelType.GROUP,
				},
			};

			receiver.emitEvent("MESSAGE_RECEIVED", {
				runtime: receiver,
				message: memory,
				roomId: roomData.roomId,
				entityId:
					receiver.agentId !== sender.agentId ? entityId : sender.agentId,
				source: "scenario",
				type: ChannelType.GROUP,
			});
		}
	}

	// Get conversation history for all participants
	async getConversations(participants: IAgentRuntime[]) {
		const conversations = await Promise.all(
			participants.map(async (member) => {
				const roomData = this.rooms.get(member.agentId);
				if (!roomData) return [];
				return member.getMemoryManager("messages").getMemories({
					roomId: roomData.roomId,
				});
			}),
		);

		logger.info("\nConversation logs per agent:");
		conversations.forEach((convo, i) => {
			logger.info(`\n${participants[i].character.name}'s perspective:`);
			convo.forEach((msg) =>
				logger.info(`${msg.content.name}: ${msg.content.text}`),
			);
		});

		return conversations;
	}
}

// Updated scenario implementation using the new client
const scenarios = [
	async function scenario1(members: IAgentRuntime[]) {
		// Create and register test client
		const service = await ScenarioService.start(members[0]);
		members[0].registerService(ScenarioService);

		// Create rooms for all members
		for (const member of members) {
			await service.createRoom(
				member.agentId,
				`Test Room for ${member.character.name}`,
			);
		}

		// Set up conversation history
		await service.saveMessage(
			members[0],
			members,
			"Earlier message from conversation...",
		);
		// await client.saveMessage(
		//   members[1],
		//   members,
		//   "Previous reply in history..."
		// );

		// // Send live message that triggers handlers
		// await client.sendMessage(members[0], members, "Hello everyone!");

		// // Get and display conversation logs
		// // wait 5 seconds
		// await new Promise((resolve) => setTimeout(resolve, 5000));
		// await client.getConversations(members);

		// Send a message to all members
		//   await client.sendMessage(members[0], members, "Hello everyone!");
	},
];

export async function startScenario(members: IAgentRuntime[]) {
	for (const scenario of scenarios) {
		await scenario(members);
	}
}
