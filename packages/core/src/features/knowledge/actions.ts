import * as fs from "node:fs";
import * as path from "node:path";
import {
	findKeywordTermMatch,
	getValidationKeywordTerms,
} from "../../i18n/validation-keywords.ts";
import { logger } from "../../logger";
import type {
	Action,
	ActionExample,
	ActionResult,
	Content,
	HandlerCallback,
	HandlerOptions,
	IAgentRuntime,
	Memory,
	SearchCategoryRegistration,
	State,
	UUID,
} from "../../types";
import { hasActionContextOrKeyword } from "../../utils/action-validation.ts";
import { addKnowledgeFromFilePath } from "./docs-loader.ts";
import { KnowledgeService } from "./service.ts";
import { fetchKnowledgeFromUrl, isYouTubeUrl } from "./url-ingest.ts";
import { createKnowledgeNoteFilename, deriveKnowledgeTitle } from "./utils.ts";

type ExtendedValidator = (
	runtime: IAgentRuntime,
	message: Memory,
	state?: State,
	options?: unknown,
) => Promise<boolean>;

const PROCESS_KNOWLEDGE_TERMS = getValidationKeywordTerms(
	"action.processKnowledge.request",
	{
		includeAllLocales: true,
	},
);
const SEARCH_KNOWLEDGE_TERMS = getValidationKeywordTerms(
	"action.searchKnowledge.request",
	{
		includeAllLocales: true,
	},
);
const KNOWLEDGE_PATH_PATTERN =
	/(?:\/[\w.-]+)+|(?:[a-zA-Z]:[\\/][\w\s.-]+(?:[\\/][\w\s.-]+)*)/;

const KNOWLEDGE_SEARCH_CATEGORY: SearchCategoryRegistration = {
	category: "knowledge",
	label: "Knowledge base",
	description: "Search stored knowledge documents and fragments.",
	contexts: ["knowledge"],
	filters: [
		{
			name: "scope",
			label: "Scope",
			description: "Optional scope: room, world, entity, or agent.",
			type: "enum",
			options: [
				{ label: "Room", value: "room" },
				{ label: "World", value: "world" },
				{ label: "Entity", value: "entity" },
				{ label: "Agent", value: "agent" },
			],
		},
	],
	resultSchemaSummary:
		"StoredKnowledgeItem[] with id, content.text, similarity, metadata, and worldId.",
	capabilities: ["semantic", "documents", "fragments"],
	source: "core:knowledge",
	serviceType: KnowledgeService.serviceType,
};

function hasSearchCategory(runtime: IAgentRuntime, category: string): boolean {
	try {
		runtime.getSearchCategory(category, { includeDisabled: true });
		return true;
	} catch {
		return false;
	}
}

export function registerKnowledgeSearchCategory(runtime: IAgentRuntime): void {
	if (!hasSearchCategory(runtime, KNOWLEDGE_SEARCH_CATEGORY.category)) {
		runtime.registerSearchCategory(KNOWLEDGE_SEARCH_CATEGORY);
	}
}

export const processKnowledgeAction: Action = {
	name: "PROCESS_KNOWLEDGE",
	contexts: ["knowledge"],
	contextGate: { anyOf: ["knowledge"] },
	roleGate: { minRole: "USER" },
	description:
		"Process and store knowledge from a file path or text content into the knowledge base",
	suppressPostActionContinuation: true,
	parameters: [
		{
			name: "filePath",
			description: "Optional local file path to ingest into knowledge.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "content",
			description: "Optional text content to store in knowledge.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "title",
			description: "Optional title for text-backed knowledge.",
			required: false,
			schema: { type: "string" as const },
		},
	],

	similes: [],

	examples: [
		[
			{
				name: "user",
				content: {
					text: "Process the document at /path/to/document.pdf",
				},
			},
			{
				name: "assistant",
				content: {
					text: "I'll process the document at /path/to/document.pdf and add it to my knowledge base.",
					actions: ["PROCESS_KNOWLEDGE"],
				},
			},
		],
		[
			{
				name: "user",
				content: {
					text: "Add this to your knowledge: The capital of France is Paris.",
				},
			},
			{
				name: "assistant",
				content: {
					text: "I'll add that information to my knowledge base.",
					actions: ["PROCESS_KNOWLEDGE"],
				},
			},
		],
	],

	validate: async (
		runtime: IAgentRuntime,
		message: Memory,
		state?: State,
		options?: unknown,
	): Promise<boolean> => {
		registerKnowledgeSearchCategory(runtime);
		const __avLegacyValidate: ExtendedValidator = async (
			runtime: IAgentRuntime,
			message: Memory,
			_state?: State,
			_options?: unknown,
		) => {
			const text = message.content.text ?? "";
			const hasKeyword =
				findKeywordTermMatch(text, PROCESS_KNOWLEDGE_TERMS) !== undefined;
			const hasPath = KNOWLEDGE_PATH_PATTERN.test(text);
			const service = runtime.getService(KnowledgeService.serviceType);
			if (!service) {
				logger.warn(
					"Knowledge service not available for PROCESS_KNOWLEDGE action",
				);
				return false;
			}

			return hasKeyword || hasPath;
		};
		try {
			const hasLegacySignal = await __avLegacyValidate(
				runtime,
				message,
				state,
				options,
			);
			return (
				hasLegacySignal ||
				hasActionContextOrKeyword(message, state, {
					contexts: ["knowledge"],
					keywordKeys: ["action.processKnowledge.request"],
					keywords: ["document", "file", "pdf", "remember this"],
				})
			);
		} catch {
			return false;
		}
	},

	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
		_options?: HandlerOptions,
		callback?: HandlerCallback,
	) => {
		try {
			registerKnowledgeSearchCategory(runtime);
			const service = runtime.getService<KnowledgeService>(
				KnowledgeService.serviceType,
			);
			if (!service) {
				throw new Error("Knowledge service not available");
			}

			const params =
				_options?.parameters && typeof _options.parameters === "object"
					? (_options.parameters as Record<string, unknown>)
					: {};
			const explicitPath =
				typeof params.filePath === "string" && params.filePath.trim()
					? params.filePath.trim()
					: undefined;
			const explicitContent =
				typeof params.content === "string" && params.content.trim()
					? params.content.trim()
					: undefined;
			const explicitTitle =
				typeof params.title === "string" && params.title.trim()
					? params.title.trim()
					: undefined;
			const text =
				explicitContent ?? explicitPath ?? message.content.text ?? "";
			const pathMatch = text.match(KNOWLEDGE_PATH_PATTERN);

			let response: Content;

			if (pathMatch) {
				const filePath = pathMatch[0];

				if (!fs.existsSync(filePath)) {
					response = {
						text: `I couldn't find the file at ${filePath}. Please check the path and try again.`,
					};

					if (callback) {
						await callback(response);
					}
					return {
						success: false,
						text: response.text,
						data: { actionName: "PROCESS_KNOWLEDGE" },
					};
				}

				const fileName = path.basename(filePath);
				const result = await addKnowledgeFromFilePath({
					service,
					agentId: runtime.agentId,
					worldId: runtime.agentId,
					roomId: runtime.agentId,
					entityId: runtime.agentId,
					filePath,
					metadata: {
						source: "learned",
						learnedVia: "PROCESS_KNOWLEDGE",
						learnedFromPath: filePath,
					},
				});

				response = {
					text: `I've successfully processed the document "${fileName}". It has been split into ${result?.fragmentCount || 0} searchable fragments and added to my knowledge base.`,
				};
			} else {
				const knowledgeContent = text
					.replace(
						/^(add|store|remember|process|learn)\s+(this|that|the following)?:?\s*/i,
						"",
					)
					.trim();

				if (!knowledgeContent) {
					response = {
						text: "I need some content to add to my knowledge base. Please provide text or a file path.",
					};

					if (callback) {
						await callback(response);
					}
					return {
						success: false,
						text: response.text,
						data: { actionName: "PROCESS_KNOWLEDGE" },
					};
				}

				const title =
					explicitTitle ??
					deriveKnowledgeTitle(knowledgeContent, "Learned knowledge");
				const filename = createKnowledgeNoteFilename(title);
				const knowledgeOptions = {
					clientDocumentId: "" as UUID,
					contentType: "text/plain",
					originalFilename: filename,
					worldId: runtime.agentId,
					content: knowledgeContent,
					roomId: runtime.agentId,
					entityId: runtime.agentId,
					metadata: {
						source: "learned",
						learnedVia: "PROCESS_KNOWLEDGE",
						title,
						filename,
						originalFilename: filename,
						fileExt: "txt",
						fileType: "text/plain",
						contentType: "text/plain",
						fileSize: Buffer.byteLength(knowledgeContent, "utf8"),
						textBacked: true,
					},
				};

				await service.addKnowledge(knowledgeOptions);

				response = {
					text: `I've added that information to my knowledge base. It has been stored and indexed for future reference.`,
				};
			}

			if (callback) {
				await callback(response);
			}
			return {
				success: true,
				text: response.text,
				data: { actionName: "PROCESS_KNOWLEDGE" },
			};
		} catch (error) {
			logger.error({ error }, "Error in PROCESS_KNOWLEDGE action");

			const errorResponse: Content = {
				text: `I encountered an error while processing the knowledge: ${error instanceof Error ? error.message : String(error)}`,
			};

			if (callback) {
				await callback(errorResponse);
			}
			return {
				success: false,
				text: errorResponse.text,
				error: error instanceof Error ? error.message : String(error),
				data: { actionName: "PROCESS_KNOWLEDGE" },
			};
		}
	},
};

export const searchKnowledgeAction: Action = {
	name: "SEARCH_KNOWLEDGE",
	contexts: ["knowledge"],
	contextGate: { anyOf: ["knowledge"] },
	roleGate: { minRole: "USER" },
	description: "Search the knowledge base for specific information",
	suppressPostActionContinuation: true,
	parameters: [
		{
			name: "query",
			description: "Knowledge base search query.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "limit",
			description: "Maximum number of matching knowledge items to include.",
			required: false,
			schema: { type: "number" as const, minimum: 1, maximum: 20, default: 3 },
		},
	],

	similes: [
		"search knowledge",
		"find information",
		"look up",
		"query knowledge base",
		"search documents",
		"find in knowledge",
	],

	examples: [
		[
			{
				name: "user",
				content: {
					text: "Search your knowledge for information about quantum computing",
				},
			},
			{
				name: "assistant",
				content: {
					text: "I'll search my knowledge base for information about quantum computing.",
					actions: ["SEARCH_KNOWLEDGE"],
				},
			},
		],
	],

	validate: async (
		runtime: IAgentRuntime,
		message: Memory,
		state?: State,
		options?: unknown,
	): Promise<boolean> => {
		const __avLegacyValidate: ExtendedValidator = async (
			runtime: IAgentRuntime,
			message: Memory,
			_state?: State,
			_options?: unknown,
		) => {
			const params =
				_options && typeof _options === "object"
					? ((_options as Record<string, unknown>).parameters as
							| Record<string, unknown>
							| undefined)
					: undefined;
			if (typeof params?.query === "string" && params.query.trim()) {
				return Boolean(runtime.getService(KnowledgeService.serviceType));
			}
			const text = message.content.text ?? "";
			const hasSearchKeyword =
				findKeywordTermMatch(text, SEARCH_KNOWLEDGE_TERMS) !== undefined;
			const service = runtime.getService(KnowledgeService.serviceType);
			if (!service) {
				return false;
			}

			return hasSearchKeyword;
		};
		try {
			return Boolean(
				await __avLegacyValidate(runtime, message, state, options),
			);
		} catch {
			return false;
		}
	},

	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
		_options?: HandlerOptions,
		callback?: HandlerCallback,
	) => {
		try {
			const service = runtime.getService<KnowledgeService>(
				KnowledgeService.serviceType,
			);
			if (!service) {
				throw new Error("Knowledge service not available");
			}

			const params = _options?.parameters as
				| { query?: string; limit?: number }
				| undefined;
			const text = message.content.text || "";

			const query =
				typeof params?.query === "string" && params.query.trim()
					? params.query.trim()
					: text
							.replace(
								/^(search|find|look up|query)\s+(your\s+)?knowledge\s+(base\s+)?(for\s+)?/i,
								"",
							)
							.trim();

			if (!query) {
				const response: Content = {
					text: "What would you like me to search for in my knowledge base?",
				};

				if (callback) {
					await callback(response);
				}
				return {
					success: false,
					text: response.text,
					data: { actionName: "SEARCH_KNOWLEDGE" },
				};
			}

			const searchMessage: Memory = {
				...message,
				content: {
					text: query,
				},
			};

			const results = await service.getKnowledge(searchMessage);

			let response: Content;

			if (results.length === 0) {
				response = {
					text: `I couldn't find any information about "${query}" in my knowledge base.`,
				};
			} else {
				const limit =
					typeof params?.limit === "number"
						? Math.max(1, Math.min(20, Math.floor(params.limit)))
						: 3;
				const formattedResults = results
					.slice(0, limit)
					.map((item, index) => `${index + 1}. ${item.content.text}`)
					.join("\n\n");

				response = {
					text: `Here's what I found about "${query}":\n\n${formattedResults}`,
				};
			}

			if (callback) {
				await callback(response);
			}
			return {
				success: true,
				text: response.text,
				data: { actionName: "SEARCH_KNOWLEDGE" },
			};
		} catch (error) {
			logger.error({ error }, "Error in SEARCH_KNOWLEDGE action");

			const errorResponse: Content = {
				text: `I encountered an error while searching the knowledge base: ${error instanceof Error ? error.message : String(error)}`,
			};

			if (callback) {
				await callback(errorResponse);
			}
			return {
				success: false,
				text: errorResponse.text,
				error: error instanceof Error ? error.message : String(error),
				data: { actionName: "SEARCH_KNOWLEDGE" },
			};
		}
	},
};

type IngestKnowledgeFromUrlParameters = {
	url?: string;
	includeImageDescriptions?: unknown;
};

type UpdateKnowledgeDocumentParameters = {
	documentId?: string;
	text?: string;
};

type DeleteKnowledgeDocumentParameters = {
	documentId?: string;
};

function isUuid(value: string): value is UUID {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
		value,
	);
}

export const ingestKnowledgeFromUrlAction: Action = {
	name: "INGEST_KNOWLEDGE_FROM_URL",
	contexts: ["knowledge"],
	contextGate: { anyOf: ["knowledge"] },
	roleGate: { minRole: "ADMIN" },
	similes: [
		"FETCH_KNOWLEDGE_FROM_URL",
		"IMPORT_KNOWLEDGE_FROM_URL",
		"LOAD_KNOWLEDGE_FROM_URL",
		"ADD_KNOWLEDGE_FROM_URL",
		"INGEST_URL",
	],
	description:
		"Fetches the content of a URL and stores it in the agent's knowledge base. Use this when the user wants to add a webpage, article, or downloadable document to knowledge by providing a link.",
	suppressPostActionContinuation: true,
	parameters: [
		{
			name: "url",
			description:
				"Absolute URL of the page or file to fetch and ingest into the knowledge base.",
			required: true,
			schema: { type: "string" as const },
		},
		{
			name: "includeImageDescriptions",
			description:
				"When true, request image-description extraction from the upstream pipeline. Stored as a metadata flag on the document.",
			required: false,
			schema: { type: "boolean" as const },
		},
	],

	validate: async (
		runtime: IAgentRuntime,
		_message: Memory,
		_state?: State,
	): Promise<boolean> => {
		const service = runtime.getService(KnowledgeService.serviceType);
		return Boolean(service);
	},

	handler: async (
		runtime: IAgentRuntime,
		_message: Memory,
		_state?: State,
		options?: HandlerOptions,
		callback?: HandlerCallback,
	): Promise<ActionResult> => {
		const params = (options?.parameters ??
			{}) as IngestKnowledgeFromUrlParameters;
		const url = params.url?.trim();
		const includeImageDescriptions = params.includeImageDescriptions === true;

		if (!url) {
			const text = "I need a URL to ingest into the knowledge base.";
			await callback?.({ text });
			return {
				text,
				success: false,
				values: { error: "missing_url" },
				data: { actionName: "INGEST_KNOWLEDGE_FROM_URL" },
			};
		}

		try {
			const service = runtime.getService<KnowledgeService>(
				KnowledgeService.serviceType,
			);
			if (!service) {
				throw new Error("Knowledge service not available");
			}

			const fetched = await fetchKnowledgeFromUrl(url, {
				includeImageDescriptions,
			});
			const { filename, mimeType } = fetched;
			const isYouTube = isYouTubeUrl(url);
			const isTextBacked = fetched.contentType !== "binary";

			const result = await service.addKnowledge({
				agentId: runtime.agentId,
				worldId: runtime.agentId,
				roomId: runtime.agentId,
				entityId: runtime.agentId,
				clientDocumentId: "" as UUID,
				contentType: mimeType,
				originalFilename: filename,
				content: fetched.content,
				metadata: {
					url,
					source: isYouTube ? "youtube" : "url",
					filename,
					originalFilename: filename,
					fileType: mimeType,
					contentType: mimeType,
					textBacked: isTextBacked,
					includeImageDescriptions,
					...(fetched.contentType === "transcript"
						? { isYouTubeTranscript: true }
						: {}),
				},
			});

			const summaryLabel =
				fetched.contentType === "transcript"
					? "transcript"
					: fetched.contentType === "html"
						? "page"
						: "document";
			const text = `Ingested ${summaryLabel} from ${url}. Stored as ${filename} with ${result.fragmentCount} fragment(s).`;
			await callback?.({
				text,
				actions: ["INGEST_KNOWLEDGE_FROM_URL"],
			});

			return {
				text,
				success: true,
				values: {
					documentId: result.clientDocumentId,
					fragmentCount: result.fragmentCount,
					filename,
				},
				data: {
					actionName: "INGEST_KNOWLEDGE_FROM_URL",
					ingestData: {
						documentId: result.clientDocumentId,
						fragmentCount: result.fragmentCount,
						filename,
						url,
						contentType: mimeType,
						kind: fetched.contentType,
						isYouTubeTranscript: fetched.contentType === "transcript",
					},
				},
			};
		} catch (error) {
			logger.error(
				{ error: error instanceof Error ? error.message : String(error) },
				"Error in INGEST_KNOWLEDGE_FROM_URL action",
			);
			const text = `I couldn't ingest that URL: ${error instanceof Error ? error.message : String(error)}`;
			await callback?.({ text });
			return {
				text,
				success: false,
				values: {
					error: error instanceof Error ? error.message : String(error),
				},
				data: { actionName: "INGEST_KNOWLEDGE_FROM_URL" },
			};
		}
	},

	examples: [
		[
			{
				name: "user",
				content: {
					text: "Add https://example.com/docs/getting-started to your knowledge base.",
				},
			},
			{
				name: "assistant",
				content: {
					text: "I'll fetch that URL and add it to my knowledge base.",
					actions: ["INGEST_KNOWLEDGE_FROM_URL"],
				},
			},
		],
		[
			{
				name: "user",
				content: {
					text: "Ingest the article at https://blog.example.com/post-1 into knowledge.",
				},
			},
			{
				name: "assistant",
				content: {
					text: "Fetching the article and indexing it into my knowledge base.",
					actions: ["INGEST_KNOWLEDGE_FROM_URL"],
				},
			},
		],
	] as ActionExample[][],
};

export const updateKnowledgeDocumentAction: Action = {
	name: "UPDATE_KNOWLEDGE_DOCUMENT",
	contexts: ["knowledge"],
	contextGate: { anyOf: ["knowledge"] },
	roleGate: { minRole: "ADMIN" },
	similes: [
		"EDIT_KNOWLEDGE_DOCUMENT",
		"REPLACE_KNOWLEDGE_DOCUMENT",
		"UPDATE_DOCUMENT_CONTENT",
		"REWRITE_KNOWLEDGE_DOCUMENT",
	],
	description:
		"Replaces the text content of an existing knowledge document and re-fragments it. Use this when the user wants to revise the body of a previously-stored document by id.",
	suppressPostActionContinuation: true,
	parameters: [
		{
			name: "documentId",
			description: "UUID of the knowledge document to update.",
			required: true,
			schema: { type: "string" as const },
		},
		{
			name: "text",
			description: "New full text content of the document.",
			required: true,
			schema: { type: "string" as const },
		},
	],

	validate: async (
		runtime: IAgentRuntime,
		_message: Memory,
		_state?: State,
	): Promise<boolean> => {
		const service = runtime.getService(KnowledgeService.serviceType);
		return Boolean(service);
	},

	handler: async (
		runtime: IAgentRuntime,
		_message: Memory,
		_state?: State,
		options?: HandlerOptions,
		callback?: HandlerCallback,
	): Promise<ActionResult> => {
		const params = (options?.parameters ??
			{}) as UpdateKnowledgeDocumentParameters;
		const documentId = params.documentId?.trim();
		const text = typeof params.text === "string" ? params.text : "";

		if (!documentId || !isUuid(documentId)) {
			const errMsg = "I need a valid documentId (UUID) to update the document.";
			await callback?.({ text: errMsg });
			return {
				text: errMsg,
				success: false,
				values: { error: "invalid_document_id" },
				data: { actionName: "UPDATE_KNOWLEDGE_DOCUMENT" },
			};
		}

		if (!text.trim()) {
			const errMsg = "I need non-empty text to update the document.";
			await callback?.({ text: errMsg });
			return {
				text: errMsg,
				success: false,
				values: { error: "missing_text" },
				data: { actionName: "UPDATE_KNOWLEDGE_DOCUMENT" },
			};
		}

		try {
			const service = runtime.getService<KnowledgeService>(
				KnowledgeService.serviceType,
			);
			if (!service) {
				throw new Error("Knowledge service not available");
			}

			const result = await service.updateKnowledgeDocument({
				documentId: documentId as UUID,
				content: text,
			});

			const summary = `Updated document ${result.documentId}. Re-fragmented into ${result.fragmentCount} piece(s).`;
			await callback?.({
				text: summary,
				actions: ["UPDATE_KNOWLEDGE_DOCUMENT"],
			});

			return {
				text: summary,
				success: true,
				values: {
					documentId: result.documentId,
					fragmentCount: result.fragmentCount,
				},
				data: {
					actionName: "UPDATE_KNOWLEDGE_DOCUMENT",
					updateData: {
						documentId: result.documentId,
						fragmentCount: result.fragmentCount,
					},
				},
			};
		} catch (error) {
			logger.error(
				{ error: error instanceof Error ? error.message : String(error) },
				"Error in UPDATE_KNOWLEDGE_DOCUMENT action",
			);
			const errMsg = `I couldn't update the document: ${error instanceof Error ? error.message : String(error)}`;
			await callback?.({ text: errMsg });
			return {
				text: errMsg,
				success: false,
				values: {
					error: error instanceof Error ? error.message : String(error),
				},
				data: { actionName: "UPDATE_KNOWLEDGE_DOCUMENT" },
			};
		}
	},

	examples: [
		[
			{
				name: "user",
				content: {
					text: "Update document 123e4567-e89b-12d3-a456-426614174000 with the revised text.",
				},
			},
			{
				name: "assistant",
				content: {
					text: "I'll replace the document content and re-index its fragments.",
					actions: ["UPDATE_KNOWLEDGE_DOCUMENT"],
				},
			},
		],
		[
			{
				name: "user",
				content: {
					text: "Replace the body of knowledge doc 7f8a3b2c-9d10-4e5f-bc12-345678901234 with the new copy.",
				},
			},
			{
				name: "assistant",
				content: {
					text: "Updating that document's text and re-fragmenting it now.",
					actions: ["UPDATE_KNOWLEDGE_DOCUMENT"],
				},
			},
		],
	] as ActionExample[][],
};

export const deleteKnowledgeDocumentAction: Action = {
	name: "DELETE_KNOWLEDGE_DOCUMENT",
	contexts: ["knowledge"],
	contextGate: { anyOf: ["knowledge"] },
	roleGate: { minRole: "ADMIN" },
	similes: [
		"REMOVE_KNOWLEDGE_DOCUMENT",
		"DELETE_DOCUMENT",
		"DROP_KNOWLEDGE_DOCUMENT",
		"FORGET_KNOWLEDGE_DOCUMENT",
	],
	description:
		"Deletes a knowledge document and all its fragments by document id. Use this when the user wants to remove a previously-stored document from the knowledge base.",
	suppressPostActionContinuation: true,
	parameters: [
		{
			name: "documentId",
			description: "UUID of the knowledge document to delete.",
			required: true,
			schema: { type: "string" as const },
		},
	],

	validate: async (
		runtime: IAgentRuntime,
		_message: Memory,
		_state?: State,
	): Promise<boolean> => {
		const service = runtime.getService(KnowledgeService.serviceType);
		return Boolean(service);
	},

	handler: async (
		runtime: IAgentRuntime,
		_message: Memory,
		_state?: State,
		options?: HandlerOptions,
		callback?: HandlerCallback,
	): Promise<ActionResult> => {
		const params = (options?.parameters ??
			{}) as DeleteKnowledgeDocumentParameters;
		const documentId = params.documentId?.trim();

		if (!documentId || !isUuid(documentId)) {
			const errMsg = "I need a valid documentId (UUID) to delete the document.";
			await callback?.({ text: errMsg });
			return {
				text: errMsg,
				success: false,
				values: { error: "invalid_document_id" },
				data: { actionName: "DELETE_KNOWLEDGE_DOCUMENT" },
			};
		}

		try {
			const service = runtime.getService<KnowledgeService>(
				KnowledgeService.serviceType,
			);
			if (!service) {
				throw new Error("Knowledge service not available");
			}

			const existing = await runtime.getMemoryById(documentId as UUID);
			if (!existing) {
				const errMsg = `Knowledge document ${documentId} not found.`;
				await callback?.({ text: errMsg });
				return {
					text: errMsg,
					success: false,
					values: { error: "not_found" },
					data: { actionName: "DELETE_KNOWLEDGE_DOCUMENT" },
				};
			}

			const fragments = await runtime.getMemories({
				tableName: "knowledge",
				agentId: runtime.agentId,
				roomId: existing.roomId,
				count: 10_000,
			});
			const relatedFragmentIds = fragments
				.filter((fragment) => {
					const meta = fragment.metadata as Record<string, unknown> | undefined;
					return meta?.documentId === documentId;
				})
				.map((fragment) => fragment.id)
				.filter((id): id is UUID => typeof id === "string");

			for (const fragmentId of relatedFragmentIds) {
				await service.deleteMemory(fragmentId);
			}

			await service.deleteMemory(documentId as UUID);

			const summary = `Deleted document ${documentId} and ${relatedFragmentIds.length} fragment(s).`;
			await callback?.({
				text: summary,
				actions: ["DELETE_KNOWLEDGE_DOCUMENT"],
			});

			return {
				text: summary,
				success: true,
				values: {
					documentId,
					deletedFragments: relatedFragmentIds.length,
				},
				data: {
					actionName: "DELETE_KNOWLEDGE_DOCUMENT",
					deleteData: {
						documentId,
						deletedFragments: relatedFragmentIds.length,
					},
				},
			};
		} catch (error) {
			logger.error(
				{ error: error instanceof Error ? error.message : String(error) },
				"Error in DELETE_KNOWLEDGE_DOCUMENT action",
			);
			const errMsg = `I couldn't delete the document: ${error instanceof Error ? error.message : String(error)}`;
			await callback?.({ text: errMsg });
			return {
				text: errMsg,
				success: false,
				values: {
					error: error instanceof Error ? error.message : String(error),
				},
				data: { actionName: "DELETE_KNOWLEDGE_DOCUMENT" },
			};
		}
	},

	examples: [
		[
			{
				name: "user",
				content: {
					text: "Delete document 123e4567-e89b-12d3-a456-426614174000 from my knowledge base.",
				},
			},
			{
				name: "assistant",
				content: {
					text: "I'll remove that document and its fragments from the knowledge base.",
					actions: ["DELETE_KNOWLEDGE_DOCUMENT"],
				},
			},
		],
		[
			{
				name: "user",
				content: {
					text: "Forget knowledge doc 7f8a3b2c-9d10-4e5f-bc12-345678901234.",
				},
			},
			{
				name: "assistant",
				content: {
					text: "Deleting that document from knowledge.",
					actions: ["DELETE_KNOWLEDGE_DOCUMENT"],
				},
			},
		],
	] as ActionExample[][],
};

export const knowledgeActions = [
	processKnowledgeAction,
	searchKnowledgeAction,
	ingestKnowledgeFromUrlAction,
	updateKnowledgeDocumentAction,
	deleteKnowledgeDocumentAction,
];
