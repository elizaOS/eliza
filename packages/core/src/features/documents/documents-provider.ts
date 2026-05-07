import { logger } from "../../logger";
import type { IAgentRuntime, Memory, Provider, State } from "../../types";
import { addHeader } from "../../utils";
import type { KnowledgeService } from "./service.ts";
import type { DocumentMetadataExtended } from "./types.ts";
import { normalizeKnowledgeSourceValue } from "./utils.ts";

const MAX_DOCUMENT_PROVIDER_ITEMS = 25;

export const documentsProvider: Provider = {
	name: "AVAILABLE_DOCUMENTS",
	description:
		"List of documents available in the knowledge base. Shows which documents the agent can reference and retrieve information from.",
	dynamic: true,
	companionProviders: ["KNOWLEDGE"],
	contexts: ["knowledge"],
	contextGate: { anyOf: ["knowledge"] },
	cacheStable: false,
	cacheScope: "turn",
	roleGate: { minRole: "USER" },

	get: async (runtime: IAgentRuntime, _message: Memory, _state?: State) => {
		try {
			const knowledgeService = runtime.getService(
				"knowledge",
			) as KnowledgeService;

			if (!knowledgeService) {
				logger.warn("Knowledge service not available for documents provider");
				return {
					data: { documents: [] },
					values: {
						documentsCount: 0,
						documents: "",
						availableDocuments: "",
					},
					text: "",
				};
			}

			const allMemories = await knowledgeService.getMemories({
				tableName: "documents",
				roomId: runtime.agentId,
				count: 100,
			});

			const documents = allMemories.filter((memory) => {
				const metadata = memory.metadata as
					| DocumentMetadataExtended
					| undefined;
				return (
					metadata?.documentId === memory.id ||
					metadata?.type === "document" ||
					metadata?.type === "custom"
				);
			});

			if (!documents || documents.length === 0) {
				return {
					data: { documents: [] },
					values: {
						documentsCount: 0,
						documents: "",
						availableDocuments: "",
					},
					text: "",
				};
			}

			const visibleDocuments = documents.slice(0, MAX_DOCUMENT_PROVIDER_ITEMS);
			const documentsList = visibleDocuments
				.map((doc, index) => {
					const metadata = doc.metadata as
						| DocumentMetadataExtended
						| undefined;
					const filename =
						metadata?.filename || metadata?.title || `Document ${index + 1}`;
					const fileType = metadata?.fileExt || metadata?.fileType || "";
					const source = normalizeKnowledgeSourceValue(metadata?.source);
					const fileSize = metadata?.fileSize;

					const parts = [filename];

					if (fileType) {
						parts.push(fileType);
					}

					if (fileSize) {
						const sizeKB = Math.round(fileSize / 1024);
						if (sizeKB > 1024) {
							parts.push(`${Math.round(sizeKB / 1024)}MB`);
						} else {
							parts.push(`${sizeKB}KB`);
						}
					}

					if (source !== "upload" && source !== "unknown") {
						parts.push(`from ${source}`);
					}

					return parts.join(" - ");
				})
				.join("\n");

			const documentsText = addHeader(
				"# Available Documents",
				`${documents.length} document(s) in knowledge base${documents.length > visibleDocuments.length ? ` (showing ${visibleDocuments.length})` : ""}:\n${documentsList}`,
			);

			return {
				data: {
					documents: visibleDocuments.map((doc) => ({
						id: doc.id,
						filename:
							(doc.metadata as DocumentMetadataExtended | undefined)
								?.filename ||
							(doc.metadata as DocumentMetadataExtended | undefined)?.title,
						fileType:
							(doc.metadata as DocumentMetadataExtended | undefined)
								?.fileType ||
							(doc.metadata as DocumentMetadataExtended | undefined)?.fileExt,
						source: (doc.metadata as DocumentMetadataExtended | undefined)
							?.source,
					})),
					count: documents.length,
					truncated: documents.length > visibleDocuments.length,
				},
				values: {
					documentsCount: documents.length,
					documents: documentsList,
					availableDocuments: documentsText,
				},
				text: documentsText,
			};
		} catch (error) {
			logger.error(
				"Error in documents provider:",
				error instanceof Error ? error.message : String(error),
			);
			return {
				data: {
					documents: [],
					error: error instanceof Error ? error.message : String(error),
				},
				values: {
					documentsCount: 0,
					documents: "",
					availableDocuments: "",
				},
				text: "",
			};
		}
	},
};
