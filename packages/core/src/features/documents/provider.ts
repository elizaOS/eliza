import {
	type IAgentRuntime,
	type Memory,
	MemoryType,
	type Provider,
} from "../../types";
import { addHeader } from "../../utils";
import { DocumentService } from "./service.ts";
import type { DocumentMetadataExtended } from "./types.ts";
import { normalizeDocumentSourceValue } from "./utils.ts";

const MAX_RELEVANT_SNIPPETS = 5;
const MAX_RECENT_DOCUMENTS = 10;
const MAX_AVAILABLE_DOCUMENTS = 25;

function getDocumentTitle(memory: Memory, index: number): string {
	const metadata = memory.metadata as DocumentMetadataExtended | undefined;
	const title =
		metadata?.title ?? metadata?.filename ?? metadata?.documentTitle;
	return typeof title === "string" && title.trim().length > 0
		? title.trim()
		: `Document ${index + 1}`;
}

function summarizeDocument(memory: Memory, index: number) {
	const metadata = memory.metadata as DocumentMetadataExtended | undefined;
	return {
		id: memory.id,
		name: getDocumentTitle(memory, index),
		scope: metadata?.scope ?? "global",
		source: normalizeDocumentSourceValue(metadata?.source),
		updatedAt:
			typeof metadata?.editedAt === "number"
				? metadata.editedAt
				: memory.createdAt,
	};
}

export const documentsProvider: Provider = {
	name: "DOCUMENTS",
	description:
		"Relevant and recent documents from the agent document store, including snippets and document IDs for follow-up reads.",
	position: -10,
	dynamic: true,
	contexts: ["documents"],
	contextGate: { anyOf: ["documents"] },
	cacheStable: false,
	cacheScope: "turn",
	roleGate: { minRole: "USER" },

	get: async (runtime: IAgentRuntime, message: Memory) => {
		const service = runtime.getService<DocumentService>(
			DocumentService.serviceType,
		);
		if (!service) {
			return {
				text: "",
				values: {
					documentsAvailable: false,
					documentsRelevant: [],
					documents: [],
				},
				data: { available: false },
			};
		}

		const relevantSnippets = (await service.searchDocuments(message))
			.slice(0, MAX_RELEVANT_SNIPPETS)
			.map((fragment, index) => {
				const metadata = fragment.metadata as
					| DocumentMetadataExtended
					| undefined;
				return {
					id: fragment.id,
					documentId: metadata?.documentId,
					name:
						metadata?.filename ??
						metadata?.title ??
						(typeof metadata?.documentTitle === "string"
							? metadata.documentTitle
							: undefined) ??
						`Snippet ${index + 1}`,
					text: fragment.content?.text ?? "",
					score: fragment.similarity,
					scope: metadata?.scope ?? "global",
				};
			});

		const documents = await service.listDocuments(message, {
			limit: MAX_AVAILABLE_DOCUMENTS,
		});
		const summaries = documents
			.filter((memory) => memory.metadata?.type === MemoryType.DOCUMENT)
			.map(summarizeDocument);
		const recentDocuments = summaries.slice(0, MAX_RECENT_DOCUMENTS);

		const snippetsText = relevantSnippets
			.map((item) => `- [${item.name}] ${item.text}`)
			.join("\n");
		const recentText = recentDocuments
			.map((item) => `- ${item.name} (${item.id}, ${item.scope})`)
			.join("\n");
		const text = addHeader(
			"# Documents",
			[snippetsText, recentText ? `Recent documents:\n${recentText}` : ""]
				.filter(Boolean)
				.join("\n\n"),
		);

		const payload = {
			documents: summaries,
			documentsAvailable: summaries.length > 0,
			documentsRelevant: relevantSnippets,
			recentDocuments,
			documentsCount: summaries.length,
		};

		return {
			text,
			values: payload,
			data: {
				...payload,
				available: true,
			},
		};
	},
};
