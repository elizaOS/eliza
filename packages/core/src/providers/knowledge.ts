import { addHeader } from "../prompts";
import type { IAgentRuntime, Memory, Provider } from "../types";

export const knowledgeProvider: Provider = {
	name: "KNOWLEDGE",
	description: "Knowledge from the knowledge base that {{agentName}} knows",
	dynamic: true,
	get: async (runtime: IAgentRuntime, message: Memory) => {
		const knowledgeData = await runtime.getKnowledge(message);

		const knowledge =
			knowledgeData && knowledgeData.length > 0
				? addHeader(
						"# Knowledge",
						knowledgeData
							.map((knowledge) => `- ${knowledge.content.text}`)
							.join("\n"),
					)
				: "";

		return {
			data: {
				knowledge,
			},
			values: {
				knowledge,
			},
			text: knowledge,
		};
	},
};
