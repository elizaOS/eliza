import { MemoryManager } from "../memory.ts";
import { formatMessages } from "../prompts.ts";
import {
	type IAgentRuntime,
	type Memory,
	ModelTypes,
	type Provider,
	type State,
} from "../types.ts";

function formatFacts(facts: Memory[]) {
	return facts
		.reverse()
		.map((fact: Memory) => fact.content.text)
		.join("\n");
}

const factsProvider: Provider = {
	name: "FACTS",
	description: "Key facts that {{agentName}} knows",
	dynamic: true,
	get: async (runtime: IAgentRuntime, message: Memory, _state?: State) => {
		// Parallelize initial data fetching operations including recentInteractions
		const recentMessages = await runtime
			.getMemoryManager("messages")
			.getMemories({
				roomId: message.roomId,
				count: 10,
				unique: false,
			});

		// join the text of the last 5 messages
		const last5Messages = recentMessages
			.slice(-5)
			.map((message) => message.content.text)
			.join("\n");

		const embedding = await runtime.useModel(
			ModelTypes.TEXT_EMBEDDING,
			last5Messages,
		);

		const memoryManager = new MemoryManager({
			runtime,
			tableName: "facts",
		});

		const [relevantFacts, recentFactsData] = await Promise.all([
			memoryManager.searchMemories({
				embedding,
				roomId: message.roomId,
				count: 10,
				agentId: runtime.agentId,
			}),
			memoryManager.getMemories({
				roomId: message.roomId,
				count: 10,
				start: 0,
				end: Date.now(),
			}),
		]);

		// join the two and deduplicate
		const allFacts = [...relevantFacts, ...recentFactsData].filter(
			(fact, index, self) => index === self.findIndex((t) => t.id === fact.id),
		);

		if (allFacts.length === 0) {
			return {
				values: {
					facts: "",
				},
				data: {
					facts: allFacts,
				},
				text: "",
			};
		}

		const formattedFacts = formatFacts(allFacts);

		const text = "Key facts that {{agentName}} knows:\n{{formattedFacts}}"
			.replace("{{agentName}}", runtime.character.name)
			.replace("{{formattedFacts}}", formattedFacts);

		return {
			values: {
				facts: formattedFacts,
			},
			data: {
				facts: allFacts,
			},
			text,
		};
	},
};

export { factsProvider };
