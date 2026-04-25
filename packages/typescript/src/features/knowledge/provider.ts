import type { IAgentRuntime, Memory, Provider } from "../../types";
import { addHeader } from "../../utils";
import type { KnowledgeService } from "./service.ts";
import { normalizeKnowledgeSourceValue } from "./utils.ts";

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

		const documentMemories = await knowledgeService.getMemories({
			tableName: "documents",
			roomId: runtime.agentId,
			count: 100,
		});
		const uploadedDocumentIds = documentMemories
			.filter((document) => {
				const metadata = document.metadata as
					| Record<string, unknown>
					| undefined;
				return normalizeKnowledgeSourceValue(metadata?.source) === "upload";
			})
			.map((document) => document.id)
			.filter(
				(documentId): documentId is string => typeof documentId === "string",
			);
		const soleUploadedDocumentId =
			uploadedDocumentIds.length === 1 ? uploadedDocumentIds[0] : null;
		const preferredKnowledgeData =
			soleUploadedDocumentId === null
				? knowledgeData
				: (() => {
						const uploadedMatches = knowledgeData.filter((fragment) => {
							const metadata = fragment.metadata as
								| Record<string, unknown>
								| undefined;
							return metadata?.documentId === soleUploadedDocumentId;
						});
						return uploadedMatches.length > 0 ? uploadedMatches : knowledgeData;
					})();

		const rankedKnowledgeData = [...preferredKnowledgeData].sort(
			(left, right) => {
				const leftMetadata = left.metadata as
					| Record<string, unknown>
					| undefined;
				const rightMetadata = right.metadata as
					| Record<string, unknown>
					| undefined;
				const leftUploadRank =
					normalizeKnowledgeSourceValue(leftMetadata?.source) === "upload"
						? 0
						: 1;
				const rightUploadRank =
					normalizeKnowledgeSourceValue(rightMetadata?.source) === "upload"
						? 0
						: 1;
				if (leftUploadRank !== rightUploadRank) {
					return leftUploadRank - rightUploadRank;
				}

				const leftSimilarity =
					typeof left.similarity === "number" ? left.similarity : -Infinity;
				const rightSimilarity =
					typeof right.similarity === "number" ? right.similarity : -Infinity;
				return rightSimilarity - leftSimilarity;
			},
		);
		const firstFiveKnowledgeItems = rankedKnowledgeData.slice(0, 5);

		let knowledge = addHeader(
			"# Knowledge",
			firstFiveKnowledgeItems
				.map((item) => {
					const metadata = item.metadata as Record<string, unknown> | undefined;
					const documentTitle =
						typeof metadata?.filename === "string" &&
						metadata.filename.trim().length > 0
							? metadata.filename.trim()
							: typeof metadata?.title === "string" &&
									metadata.title.trim().length > 0
								? metadata.title.trim()
								: typeof metadata?.documentTitle === "string" &&
										metadata.documentTitle.trim().length > 0
									? metadata.documentTitle.trim()
									: "Unknown document";
					return `- [${documentTitle}] ${item.content.text}`;
				})
				.join("\n"),
		);

		const tokenLength = 3.5;
		const maxChars = 4000 * tokenLength;

		if (knowledge.length > maxChars) {
			knowledge = knowledge.slice(0, maxChars);
		}

		const ragMetadata = {
			retrievedFragments: rankedKnowledgeData.map((fragment) => {
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
