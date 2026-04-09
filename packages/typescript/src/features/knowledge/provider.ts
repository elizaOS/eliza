import type { IAgentRuntime, Memory, Provider } from "../../types";
import { addHeader } from "../../utils";
import type { KnowledgeService } from "./service.ts";

export const knowledgeProvider: Provider = {
	name: "KNOWLEDGE",
	description:
		"Knowledge from the knowledge base that the agent knows, retrieved whenever the agent needs to answer a question about their expertise.",
	dynamic: true,
	get: async (runtime: IAgentRuntime, message: Memory) => {
		const knowledgeService = runtime.getService(
			"knowledge",
		) as KnowledgeService;
		const knowledgeData = await knowledgeService?.getKnowledge(message);

		// Early return when no knowledge exists - provider will be skipped in context
		// (runtime filters providers with empty/whitespace text)
		if (!knowledgeData || knowledgeData.length === 0) {
			return {
				text: "",
				values: { knowledge: "", knowledgeUsed: false },
				data: { knowledge: "", ragMetadata: null, knowledgeUsed: false },
			};
		}

		const firstFiveKnowledgeItems = knowledgeData.slice(0, 5);

		let knowledge = addHeader(
			"# Knowledge",
			firstFiveKnowledgeItems
				.map((item) => `- ${item.content.text}`)
				.join("\n"),
		);

		const tokenLength = 3.5;
		const maxChars = 4000 * tokenLength;

		if (knowledge.length > maxChars) {
			knowledge = knowledge.slice(0, maxChars);
		}

		const ragMetadata = {
			retrievedFragments: knowledgeData.map((fragment) => {
				const fragmentMetadata = fragment.metadata as
					| Record<string, unknown>
					| undefined;
				return {
					fragmentId: fragment.id,
					documentTitle:
						(fragmentMetadata?.filename as string) ||
						(fragmentMetadata?.title as string) ||
						"",
					similarityScore: (fragment as { similarity?: number }).similarity,
					contentPreview: `${(fragment.content?.text || "").substring(0, 100)}...`,
				};
			}),
			queryText: message.content?.text || "",
			totalFragments: knowledgeData.length,
			retrievalTimestamp: Date.now(),
		};

		knowledgeService.setPendingRAGMetadata(ragMetadata);
		setTimeout(async () => {
			await knowledgeService.enrichRecentMemoriesWithPendingRAG();
		}, 2000);

		return {
			data: {
				knowledge,
				ragMetadata,
				knowledgeUsed: true,
			},
			values: {
				knowledge,
				knowledgeUsed: true,
			},
			text: knowledge,
			ragMetadata,
			knowledgeUsed: true,
		};
	},
};
