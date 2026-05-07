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
import { KnowledgeService, type SearchMode } from "./service.ts";
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
	{ includeAllLocales: true },
);
const SEARCH_KNOWLEDGE_TERMS = getValidationKeywordTerms(
	"action.searchKnowledge.request",
	{ includeAllLocales: true },
);
const KNOWLEDGE_PATH_PATTERN =
	/(?:\/[\w.-]+)+|(?:[a-zA-Z]:[\\/][\w\s.-]+(?:[\\/][\w\s.-]+)*)/;

const DOCUMENTS_SEARCH_CATEGORY: SearchCategoryRegistration = {
	category: "documents",
	label: "Documents",
	description: "Search stored documents and fragments.",
	contexts: ["documents"],
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
		"StoredDocument[] with id, content.text, similarity, metadata, and worldId.",
	capabilities: ["semantic", "documents", "fragments"],
	source: "core:documents",
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

export function registerDocumentsSearchCategory(runtime: IAgentRuntime): void {
	if (!hasSearchCategory(runtime, DOCUMENTS_SEARCH_CATEGORY.category)) {
		runtime.registerSearchCategory(DOCUMENTS_SEARCH_CATEGORY);
	}
}

/** @deprecated Use registerDocumentsSearchCategory */
export const registerKnowledgeSearchCategory = registerDocumentsSearchCategory;

// ─── IMPORT_DOCUMENT_FROM_FILE (was PROCESS_KNOWLEDGE) ────────────────────────

export const importDocumentFromFileAction: Action = {
	name: "IMPORT_DOCUMENT_FROM_FILE",
	contexts: ["documents"],
	contextGate: { anyOf: ["documents"] },
	roleGate: { minRole: "USER" },
	description:
		"Import and store a document from a file path or text content into the document store",
	suppressPostActionContinuation: true,
	parameters: [
		{
			name: "filePath",
			description: "Optional local file path to ingest as a document.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "content",
			description: "Optional text content to store as a document.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "title",
			description: "Optional title for text-backed documents.",
			required: false,
			schema: { type: "string" as const },
		},
	],
	similes: ["PROCESS_KNOWLEDGE"],
	examples: [
		[
			{
				name: "user",
				content: { text: "Import the document at /path/to/document.pdf" },
			},
			{
				name: "assistant",
				content: {
					text: "I'll import the document at /path/to/document.pdf and add it to my document store.",
					actions: ["IMPORT_DOCUMENT_FROM_FILE"],
				},
			},
		],
		[
			{
				name: "user",
				content: {
					text: "Add this to your documents: The capital of France is Paris.",
				},
			},
			{
				name: "assistant",
				content: {
					text: "I'll add that information to my document store.",
					actions: ["IMPORT_DOCUMENT_FROM_FILE"],
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
		registerDocumentsSearchCategory(runtime);
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
					"Documents service not available for IMPORT_DOCUMENT_FROM_FILE action",
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
					contexts: ["documents"],
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
			registerDocumentsSearchCategory(runtime);
			const service = runtime.getService<KnowledgeService>(
				KnowledgeService.serviceType,
			);
			if (!service) {
				throw new Error("Documents service not available");
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
					if (callback) await callback(response);
					return {
						success: false,
						text: response.text,
						data: { actionName: "IMPORT_DOCUMENT_FROM_FILE" },
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
						learnedVia: "IMPORT_DOCUMENT_FROM_FILE",
						learnedFromPath: filePath,
					},
				});
				response = {
					text: `I've successfully imported the document "${fileName}". It has been split into ${result?.fragmentCount || 0} searchable fragments and added to my document store.`,
				};
			} else {
				const documentContent = text
					.replace(
						/^(add|store|remember|process|learn)\s+(this|that|the following)?:?\s*/i,
						"",
					)
					.trim();

				if (!documentContent) {
					response = {
						text: "I need some content to add to my document store. Please provide text or a file path.",
					};
					if (callback) await callback(response);
					return {
						success: false,
						text: response.text,
						data: { actionName: "IMPORT_DOCUMENT_FROM_FILE" },
					};
				}

				const title =
					explicitTitle ??
					deriveKnowledgeTitle(documentContent, "Stored document");
				const filename = createKnowledgeNoteFilename(title);

				await service.addKnowledge({
					clientDocumentId: "" as UUID,
					contentType: "text/plain",
					originalFilename: filename,
					worldId: runtime.agentId,
					content: documentContent,
					roomId: runtime.agentId,
					entityId: runtime.agentId,
					metadata: {
						source: "learned",
						learnedVia: "IMPORT_DOCUMENT_FROM_FILE",
						title,
						filename,
						originalFilename: filename,
						fileExt: "txt",
						fileType: "text/plain",
						contentType: "text/plain",
						fileSize: Buffer.byteLength(documentContent, "utf8"),
						textBacked: true,
					},
				});

				response = {
					text: "I've added that information to my document store. It has been stored and indexed for future reference.",
				};
			}

			if (callback) await callback(response);
			return {
				success: true,
				text: response.text,
				data: { actionName: "IMPORT_DOCUMENT_FROM_FILE" },
			};
		} catch (error) {
			logger.error({ error }, "Error in IMPORT_DOCUMENT_FROM_FILE action");
			const errorResponse: Content = {
				text: `I encountered an error while importing the document: ${error instanceof Error ? error.message : String(error)}`,
			};
			if (callback) await callback(errorResponse);
			return {
				success: false,
				text: errorResponse.text,
				error: error instanceof Error ? error.message : String(error),
				data: { actionName: "IMPORT_DOCUMENT_FROM_FILE" },
			};
		}
	},
};

/** @deprecated Use importDocumentFromFileAction */
export const processKnowledgeAction: Action = {
	...importDocumentFromFileAction,
	name: "PROCESS_KNOWLEDGE",
	similes: ["IMPORT_DOCUMENT_FROM_FILE"],
};

// ─── SEARCH_DOCUMENTS (was SEARCH_KNOWLEDGE) ──────────────────────────────────

export const searchDocumentsAction: Action = {
	name: "SEARCH_DOCUMENTS",
	contexts: ["documents"],
	contextGate: { anyOf: ["documents"] },
	roleGate: { minRole: "USER" },
	description: "Search the document store for specific information",
	suppressPostActionContinuation: true,
	parameters: [
		{
			name: "query",
			description: "Document search query.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "limit",
			description: "Maximum number of matching documents to include.",
			required: false,
			schema: { type: "number" as const, minimum: 1, maximum: 20, default: 3 },
		},
		{
			name: "searchMode",
			description:
				"Retrieval strategy: 'hybrid' (default, vector + BM25 combined), 'vector' (pure semantic), or 'keyword' (pure BM25, works without an embedding model).",
			required: false,
			schema: {
				type: "string" as const,
				enum: ["hybrid", "vector", "keyword"],
			},
		},
	],
	similes: [
		"SEARCH_KNOWLEDGE",
		"search documents",
		"find information",
		"look up",
		"query document store",
		"find in documents",
	],
	examples: [
		[
			{
				name: "user",
				content: {
					text: "Search your documents for information about quantum computing",
				},
			},
			{
				name: "assistant",
				content: {
					text: "I'll search my document store for information about quantum computing.",
					actions: ["SEARCH_DOCUMENTS"],
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
			if (!service) return false;
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
				throw new Error("Documents service not available");
			}

			const params = _options?.parameters as
				| { query?: string; limit?: number; searchMode?: string }
				| undefined;
			const text = message.content.text || "";

			const query =
				typeof params?.query === "string" && params.query.trim()
					? params.query.trim()
					: text
							.replace(
								/^(search|find|look up|query)\s+(your\s+)?(?:knowledge|documents?)\s+(?:base\s+)?(?:for\s+)?/i,
								"",
							)
							.trim();

			if (!query) {
				const response: Content = {
					text: "What would you like me to search for in my document store?",
				};
				if (callback) await callback(response);
				return {
					success: false,
					text: response.text,
					data: { actionName: "SEARCH_DOCUMENTS" },
				};
			}

			const rawMode = params?.searchMode;
			const searchMode: SearchMode | undefined =
				rawMode === "hybrid" || rawMode === "vector" || rawMode === "keyword"
					? rawMode
					: undefined;

			const searchMessage: Memory = { ...message, content: { text: query } };
			const results = await service.getKnowledge(
				searchMessage,
				undefined,
				searchMode,
			);

			let response: Content;
			if (results.length === 0) {
				response = {
					text: `I couldn't find any information about "${query}" in my document store.`,
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

			if (callback) await callback(response);
			return {
				success: true,
				text: response.text,
				data: { actionName: "SEARCH_DOCUMENTS" },
			};
		} catch (error) {
			logger.error({ error }, "Error in SEARCH_DOCUMENTS action");
			const errorResponse: Content = {
				text: `I encountered an error while searching documents: ${error instanceof Error ? error.message : String(error)}`,
			};
			if (callback) await callback(errorResponse);
			return {
				success: false,
				text: errorResponse.text,
				error: error instanceof Error ? error.message : String(error),
				data: { actionName: "SEARCH_DOCUMENTS" },
			};
		}
	},
};

/** @deprecated Use searchDocumentsAction */
export const searchKnowledgeAction: Action = {
	...searchDocumentsAction,
	name: "SEARCH_KNOWLEDGE",
	similes: ["SEARCH_DOCUMENTS"],
};

// ─── IMPORT_DOCUMENT_FROM_URL (was INGEST_KNOWLEDGE_FROM_URL) ─────────────────

type ImportDocumentFromUrlParameters = {
	url?: string;
	includeImageDescriptions?: unknown;
};

export const importDocumentFromUrlAction: Action = {
	name: "IMPORT_DOCUMENT_FROM_URL",
	contexts: ["documents"],
	contextGate: { anyOf: ["documents"] },
	roleGate: { minRole: "ADMIN" },
	similes: [
		"INGEST_KNOWLEDGE_FROM_URL",
		"FETCH_KNOWLEDGE_FROM_URL",
		"IMPORT_KNOWLEDGE_FROM_URL",
		"LOAD_KNOWLEDGE_FROM_URL",
		"ADD_KNOWLEDGE_FROM_URL",
		"INGEST_URL",
	],
	description:
		"Fetches the content of a URL and stores it in the agent's document store. Use this when the user wants to add a webpage, article, or downloadable document by providing a link.",
	suppressPostActionContinuation: true,
	parameters: [
		{
			name: "url",
			description:
				"Absolute URL of the page or file to fetch and import into the document store.",
			required: true,
			schema: { type: "string" as const },
		},
		{
			name: "includeImageDescriptions",
			description:
				"When true, request image-description extraction from the upstream pipeline.",
			required: false,
			schema: { type: "boolean" as const },
		},
	],

	validate: async (
		runtime: IAgentRuntime,
		_message: Memory,
		_state?: State,
	): Promise<boolean> => {
		return Boolean(runtime.getService(KnowledgeService.serviceType));
	},

	handler: async (
		runtime: IAgentRuntime,
		_message: Memory,
		_state?: State,
		options?: HandlerOptions,
		callback?: HandlerCallback,
	): Promise<ActionResult> => {
		const params = (options?.parameters ??
			{}) as ImportDocumentFromUrlParameters;
		const url = params.url?.trim();
		const includeImageDescriptions = params.includeImageDescriptions === true;

		if (!url) {
			const text = "I need a URL to import into the document store.";
			await callback?.({ text });
			return {
				text,
				success: false,
				values: { error: "missing_url" },
				data: { actionName: "IMPORT_DOCUMENT_FROM_URL" },
			};
		}

		try {
			const service = runtime.getService<KnowledgeService>(
				KnowledgeService.serviceType,
			);
			if (!service) {
				throw new Error("Documents service not available");
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
			const text = `Imported ${summaryLabel} from ${url}. Stored as ${filename} with ${result.fragmentCount} fragment(s).`;
			await callback?.({ text, actions: ["IMPORT_DOCUMENT_FROM_URL"] });

			return {
				text,
				success: true,
				values: {
					documentId: result.clientDocumentId,
					fragmentCount: result.fragmentCount,
					filename,
				},
				data: {
					actionName: "IMPORT_DOCUMENT_FROM_URL",
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
				"Error in IMPORT_DOCUMENT_FROM_URL action",
			);
			const text = `I couldn't import that URL: ${error instanceof Error ? error.message : String(error)}`;
			await callback?.({ text });
			return {
				text,
				success: false,
				values: {
					error: error instanceof Error ? error.message : String(error),
				},
				data: { actionName: "IMPORT_DOCUMENT_FROM_URL" },
			};
		}
	},

	examples: [
		[
			{
				name: "user",
				content: {
					text: "Add https://example.com/docs/getting-started to your documents.",
				},
			},
			{
				name: "assistant",
				content: {
					text: "I'll fetch that URL and add it to my document store.",
					actions: ["IMPORT_DOCUMENT_FROM_URL"],
				},
			},
		],
		[
			{
				name: "user",
				content: {
					text: "Import the article at https://blog.example.com/post-1.",
				},
			},
			{
				name: "assistant",
				content: {
					text: "Fetching the article and indexing it into my document store.",
					actions: ["IMPORT_DOCUMENT_FROM_URL"],
				},
			},
		],
	] as ActionExample[][],
};

/** @deprecated Use importDocumentFromUrlAction */
export const ingestKnowledgeFromUrlAction: Action = {
	...importDocumentFromUrlAction,
	name: "INGEST_KNOWLEDGE_FROM_URL",
	similes: ["IMPORT_DOCUMENT_FROM_URL"],
};

// ─── READ_DOCUMENT ─────────────────────────────────────────────────────────────

type ReadDocumentParameters = { id?: string };

function isUuid(value: string): value is UUID {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
		value,
	);
}

export const readDocumentAction: Action = {
	name: "READ_DOCUMENT",
	contexts: ["documents"],
	contextGate: { anyOf: ["documents"] },
	roleGate: { minRole: "USER" },
	similes: ["GET_DOCUMENT", "FETCH_DOCUMENT", "RETRIEVE_DOCUMENT"],
	description:
		"Fetches the full text content of a single document by its id from the document store.",
	suppressPostActionContinuation: true,
	parameters: [
		{
			name: "id",
			description: "UUID of the document to read.",
			required: true,
			schema: { type: "string" as const },
		},
	],

	validate: async (runtime: IAgentRuntime): Promise<boolean> => {
		return Boolean(runtime.getService(KnowledgeService.serviceType));
	},

	handler: async (
		runtime: IAgentRuntime,
		_message: Memory,
		_state?: State,
		options?: HandlerOptions,
		callback?: HandlerCallback,
	): Promise<ActionResult> => {
		const params = (options?.parameters ?? {}) as ReadDocumentParameters;
		const id = params.id?.trim();

		if (!id || !isUuid(id)) {
			const errMsg = "I need a valid document id (UUID) to read.";
			await callback?.({ text: errMsg });
			return {
				text: errMsg,
				success: false,
				values: { error: "invalid_id" },
				data: { actionName: "READ_DOCUMENT" },
			};
		}

		try {
			const memory = await runtime.getMemoryById(id as UUID);
			if (!memory) {
				const errMsg = `Document ${id} not found.`;
				await callback?.({ text: errMsg });
				return {
					text: errMsg,
					success: false,
					values: { error: "not_found" },
					data: { actionName: "READ_DOCUMENT" },
				};
			}

			const text = memory.content?.text ?? "";
			await callback?.({ text });
			return {
				text,
				success: true,
				values: { id, textLength: text.length },
				data: { actionName: "READ_DOCUMENT", document: memory },
			};
		} catch (error) {
			logger.error(
				{ error: error instanceof Error ? error.message : String(error) },
				"Error in READ_DOCUMENT action",
			);
			const errMsg = `I couldn't read that document: ${error instanceof Error ? error.message : String(error)}`;
			await callback?.({ text: errMsg });
			return {
				text: errMsg,
				success: false,
				values: {
					error: error instanceof Error ? error.message : String(error),
				},
				data: { actionName: "READ_DOCUMENT" },
			};
		}
	},

	examples: [
		[
			{
				name: "user",
				content: {
					text: "Read document 123e4567-e89b-12d3-a456-426614174000.",
				},
			},
			{
				name: "assistant",
				content: {
					text: "Fetching that document from the store.",
					actions: ["READ_DOCUMENT"],
				},
			},
		],
	] as ActionExample[][],
};

// ─── EDIT_DOCUMENT (was UPDATE_KNOWLEDGE_DOCUMENT) ────────────────────────────

type EditDocumentParameters = {
	id?: string;
	documentId?: string;
	text?: string;
	title?: string;
};

export const editDocumentAction: Action = {
	name: "EDIT_DOCUMENT",
	contexts: ["documents"],
	contextGate: { anyOf: ["documents"] },
	roleGate: { minRole: "ADMIN" },
	similes: [
		"UPDATE_KNOWLEDGE_DOCUMENT",
		"EDIT_KNOWLEDGE_DOCUMENT",
		"UPDATE_DOCUMENT",
		"MODIFY_DOCUMENT",
		"REPLACE_DOCUMENT",
		"REWRITE_DOCUMENT",
	],
	description:
		"Replaces the text content of an existing document and re-fragments it. Use this when the user wants to revise the body of a previously-stored document by id.",
	suppressPostActionContinuation: true,
	parameters: [
		{
			name: "id",
			description: "UUID of the document to edit.",
			required: true,
			schema: { type: "string" as const },
		},
		{
			name: "text",
			description: "New full text content of the document.",
			required: true,
			schema: { type: "string" as const },
		},
		{
			name: "title",
			description: "Optional new title for the document.",
			required: false,
			schema: { type: "string" as const },
		},
	],

	validate: async (runtime: IAgentRuntime): Promise<boolean> => {
		return Boolean(runtime.getService(KnowledgeService.serviceType));
	},

	handler: async (
		runtime: IAgentRuntime,
		_message: Memory,
		_state?: State,
		options?: HandlerOptions,
		callback?: HandlerCallback,
	): Promise<ActionResult> => {
		const params = (options?.parameters ?? {}) as EditDocumentParameters;
		const documentId = (params.id ?? params.documentId)?.trim();
		const text = typeof params.text === "string" ? params.text : "";

		if (!documentId || !isUuid(documentId)) {
			const errMsg = "I need a valid document id (UUID) to edit.";
			await callback?.({ text: errMsg });
			return {
				text: errMsg,
				success: false,
				values: { error: "invalid_id" },
				data: { actionName: "EDIT_DOCUMENT" },
			};
		}

		if (!text.trim()) {
			const errMsg = "I need non-empty text to update the document.";
			await callback?.({ text: errMsg });
			return {
				text: errMsg,
				success: false,
				values: { error: "missing_text" },
				data: { actionName: "EDIT_DOCUMENT" },
			};
		}

		try {
			const service = runtime.getService<KnowledgeService>(
				KnowledgeService.serviceType,
			);
			if (!service) {
				throw new Error("Documents service not available");
			}

			const result = await service.updateKnowledgeDocument({
				documentId: documentId as UUID,
				content: text,
			});

			const summary = `Updated document ${result.documentId}. Re-fragmented into ${result.fragmentCount} piece(s).`;
			await callback?.({ text: summary, actions: ["EDIT_DOCUMENT"] });

			return {
				text: summary,
				success: true,
				values: {
					id: result.documentId,
					documentId: result.documentId,
					fragmentCount: result.fragmentCount,
				},
				data: {
					actionName: "EDIT_DOCUMENT",
					updateData: {
						documentId: result.documentId,
						fragmentCount: result.fragmentCount,
					},
				},
			};
		} catch (error) {
			logger.error(
				{ error: error instanceof Error ? error.message : String(error) },
				"Error in EDIT_DOCUMENT action",
			);
			const errMsg = `I couldn't edit that document: ${error instanceof Error ? error.message : String(error)}`;
			await callback?.({ text: errMsg });
			return {
				text: errMsg,
				success: false,
				values: {
					error: error instanceof Error ? error.message : String(error),
				},
				data: { actionName: "EDIT_DOCUMENT" },
			};
		}
	},

	examples: [
		[
			{
				name: "user",
				content: {
					text: "Edit document 123e4567-e89b-12d3-a456-426614174000 with revised text.",
				},
			},
			{
				name: "assistant",
				content: {
					text: "I'll replace the document content and re-index its fragments.",
					actions: ["EDIT_DOCUMENT"],
				},
			},
		],
	] as ActionExample[][],
};

/** @deprecated Use editDocumentAction */
export const updateKnowledgeDocumentAction: Action = {
	...editDocumentAction,
	name: "UPDATE_KNOWLEDGE_DOCUMENT",
	similes: ["EDIT_DOCUMENT"],
};

// ─── WRITE_DOCUMENT ────────────────────────────────────────────────────────────

type WriteDocumentParameters = {
	title?: string;
	text?: string;
	tags?: string[];
};

export const writeDocumentAction: Action = {
	name: "WRITE_DOCUMENT",
	contexts: ["documents"],
	contextGate: { anyOf: ["documents"] },
	roleGate: { minRole: "USER" },
	similes: [
		"CREATE_DOCUMENT",
		"SAVE_DOCUMENT",
		"STORE_DOCUMENT",
		"ADD_DOCUMENT",
	],
	description:
		"Creates a new document in the document store from the given title and text. Use this when the user wants to save new text content as a named document.",
	suppressPostActionContinuation: true,
	parameters: [
		{
			name: "title",
			description: "Title for the new document.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "text",
			description: "Full text content of the new document.",
			required: true,
			schema: { type: "string" as const },
		},
		{
			name: "tags",
			description: "Optional list of tag strings for the document.",
			required: false,
			schema: { type: "array" as const, items: { type: "string" as const } },
		},
	],

	validate: async (runtime: IAgentRuntime): Promise<boolean> => {
		return Boolean(runtime.getService(KnowledgeService.serviceType));
	},

	handler: async (
		runtime: IAgentRuntime,
		_message: Memory,
		_state?: State,
		options?: HandlerOptions,
		callback?: HandlerCallback,
	): Promise<ActionResult> => {
		const params = (options?.parameters ?? {}) as WriteDocumentParameters;
		const text = typeof params.text === "string" ? params.text.trim() : "";
		const tags = Array.isArray(params.tags) ? params.tags : [];

		if (!text) {
			const errMsg = "I need non-empty text to create a document.";
			await callback?.({ text: errMsg });
			return {
				text: errMsg,
				success: false,
				values: { error: "missing_text" },
				data: { actionName: "WRITE_DOCUMENT" },
			};
		}

		try {
			const service = runtime.getService<KnowledgeService>(
				KnowledgeService.serviceType,
			);
			if (!service) {
				throw new Error("Documents service not available");
			}

			const title =
				typeof params.title === "string" && params.title.trim()
					? params.title.trim()
					: deriveKnowledgeTitle(text, "Stored document");
			const filename = createKnowledgeNoteFilename(title);

			const result = await service.addKnowledge({
				agentId: runtime.agentId,
				worldId: runtime.agentId,
				roomId: runtime.agentId,
				entityId: runtime.agentId,
				clientDocumentId: "" as UUID,
				contentType: "text/plain",
				originalFilename: filename,
				content: text,
				metadata: {
					source: "write_document",
					learnedVia: "WRITE_DOCUMENT",
					title,
					filename,
					originalFilename: filename,
					fileExt: "txt",
					fileType: "text/plain",
					contentType: "text/plain",
					fileSize: Buffer.byteLength(text, "utf8"),
					textBacked: true,
					...(tags.length > 0 ? { tags } : {}),
				},
			});

			const summary = `Created document "${title}" with ${result.fragmentCount} fragment(s). Document id: ${result.clientDocumentId}.`;
			await callback?.({ text: summary, actions: ["WRITE_DOCUMENT"] });

			return {
				text: summary,
				success: true,
				values: {
					id: result.clientDocumentId,
					documentId: result.clientDocumentId,
					fragmentCount: result.fragmentCount,
					title,
					filename,
				},
				data: {
					actionName: "WRITE_DOCUMENT",
					documentData: {
						documentId: result.clientDocumentId,
						fragmentCount: result.fragmentCount,
						title,
						filename,
					},
				},
			};
		} catch (error) {
			logger.error(
				{ error: error instanceof Error ? error.message : String(error) },
				"Error in WRITE_DOCUMENT action",
			);
			const errMsg = `I couldn't create that document: ${error instanceof Error ? error.message : String(error)}`;
			await callback?.({ text: errMsg });
			return {
				text: errMsg,
				success: false,
				values: {
					error: error instanceof Error ? error.message : String(error),
				},
				data: { actionName: "WRITE_DOCUMENT" },
			};
		}
	},

	examples: [
		[
			{
				name: "user",
				content: {
					text: "Save this as a document titled 'Meeting Notes': We decided to move the launch date.",
				},
			},
			{
				name: "assistant",
				content: {
					text: "I'll save that as a document in the store.",
					actions: ["WRITE_DOCUMENT"],
				},
			},
		],
	] as ActionExample[][],
};

// ─── DELETE_DOCUMENT (was DELETE_KNOWLEDGE_DOCUMENT) ──────────────────────────

type DeleteDocumentParameters = {
	id?: string;
	documentId?: string;
};

export const deleteDocumentAction: Action = {
	name: "DELETE_DOCUMENT",
	contexts: ["documents"],
	contextGate: { anyOf: ["documents"] },
	roleGate: { minRole: "ADMIN" },
	similes: [
		"DELETE_KNOWLEDGE_DOCUMENT",
		"REMOVE_DOCUMENT",
		"DROP_DOCUMENT",
		"FORGET_DOCUMENT",
	],
	description:
		"Deletes a document and all its fragments by id. Use this when the user wants to remove a previously-stored document.",
	suppressPostActionContinuation: true,
	parameters: [
		{
			name: "id",
			description: "UUID of the document to delete.",
			required: true,
			schema: { type: "string" as const },
		},
	],

	validate: async (runtime: IAgentRuntime): Promise<boolean> => {
		return Boolean(runtime.getService(KnowledgeService.serviceType));
	},

	handler: async (
		runtime: IAgentRuntime,
		_message: Memory,
		_state?: State,
		options?: HandlerOptions,
		callback?: HandlerCallback,
	): Promise<ActionResult> => {
		const params = (options?.parameters ?? {}) as DeleteDocumentParameters;
		const documentId = (params.id ?? params.documentId)?.trim();

		if (!documentId || !isUuid(documentId)) {
			const errMsg = "I need a valid document id (UUID) to delete.";
			await callback?.({ text: errMsg });
			return {
				text: errMsg,
				success: false,
				values: { error: "invalid_id" },
				data: { actionName: "DELETE_DOCUMENT" },
			};
		}

		try {
			const service = runtime.getService<KnowledgeService>(
				KnowledgeService.serviceType,
			);
			if (!service) {
				throw new Error("Documents service not available");
			}

			const existing = await runtime.getMemoryById(documentId as UUID);
			if (!existing) {
				const errMsg = `Document ${documentId} not found.`;
				await callback?.({ text: errMsg });
				return {
					text: errMsg,
					success: false,
					values: { error: "not_found" },
					data: { actionName: "DELETE_DOCUMENT" },
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
			await callback?.({ text: summary, actions: ["DELETE_DOCUMENT"] });

			return {
				text: summary,
				success: true,
				values: {
					id: documentId,
					documentId,
					deletedFragments: relatedFragmentIds.length,
				},
				data: {
					actionName: "DELETE_DOCUMENT",
					deleteData: {
						documentId,
						deletedFragments: relatedFragmentIds.length,
					},
				},
			};
		} catch (error) {
			logger.error(
				{ error: error instanceof Error ? error.message : String(error) },
				"Error in DELETE_DOCUMENT action",
			);
			const errMsg = `I couldn't delete that document: ${error instanceof Error ? error.message : String(error)}`;
			await callback?.({ text: errMsg });
			return {
				text: errMsg,
				success: false,
				values: {
					error: error instanceof Error ? error.message : String(error),
				},
				data: { actionName: "DELETE_DOCUMENT" },
			};
		}
	},

	examples: [
		[
			{
				name: "user",
				content: {
					text: "Delete document 123e4567-e89b-12d3-a456-426614174000.",
				},
			},
			{
				name: "assistant",
				content: {
					text: "I'll remove that document and its fragments from the store.",
					actions: ["DELETE_DOCUMENT"],
				},
			},
		],
	] as ActionExample[][],
};

/** @deprecated Use deleteDocumentAction */
export const deleteKnowledgeDocumentAction: Action = {
	...deleteDocumentAction,
	name: "DELETE_KNOWLEDGE_DOCUMENT",
	similes: ["DELETE_DOCUMENT"],
};

// ─── LIST_DOCUMENTS ────────────────────────────────────────────────────────────

type ListDocumentsParameters = { limit?: number; query?: string };

export const listDocumentsAction: Action = {
	name: "LIST_DOCUMENTS",
	contexts: ["documents"],
	contextGate: { anyOf: ["documents"] },
	roleGate: { minRole: "USER" },
	similes: ["ENUMERATE_DOCUMENTS", "SHOW_DOCUMENTS", "LIST_KNOWLEDGE"],
	description:
		"Lists stored documents in the document store, optionally filtered by a search query.",
	suppressPostActionContinuation: true,
	parameters: [
		{
			name: "limit",
			description: "Maximum number of documents to return (default 20).",
			required: false,
			schema: {
				type: "number" as const,
				minimum: 1,
				maximum: 100,
				default: 20,
			},
		},
		{
			name: "query",
			description:
				"Optional search query to filter documents by title or content.",
			required: false,
			schema: { type: "string" as const },
		},
	],

	validate: async (runtime: IAgentRuntime): Promise<boolean> => {
		return Boolean(runtime.getService(KnowledgeService.serviceType));
	},

	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
		options?: HandlerOptions,
		callback?: HandlerCallback,
	): Promise<ActionResult> => {
		const params = (options?.parameters ?? {}) as ListDocumentsParameters;
		const limit =
			typeof params.limit === "number"
				? Math.max(1, Math.min(100, Math.floor(params.limit)))
				: 20;
		const query =
			typeof params.query === "string" ? params.query.trim() : undefined;

		try {
			const service = runtime.getService<KnowledgeService>(
				KnowledgeService.serviceType,
			);
			if (!service) {
				throw new Error("Documents service not available");
			}

			let documents: Array<{
				id: UUID;
				content: { text?: string };
				metadata?: Record<string, unknown>;
			}>;

			if (query) {
				const searchMessage: Memory = { ...message, content: { text: query } };
				documents = await service.getKnowledge(searchMessage);
			} else {
				documents = (await service.getMemories({
					tableName: "documents",
					roomId: runtime.agentId,
					count: limit,
				})) as typeof documents;
			}

			const sliced = documents.slice(0, limit);

			if (sliced.length === 0) {
				const text = query
					? `No documents matched "${query}".`
					: "No documents found in the store.";
				await callback?.({ text });
				return {
					text,
					success: true,
					values: { count: 0 },
					data: { actionName: "LIST_DOCUMENTS", documents: [] },
				};
			}

			const formatted = sliced
				.map((doc, i) => {
					const meta = doc.metadata;
					const title =
						(meta?.title as string | undefined) ||
						(meta?.filename as string | undefined) ||
						doc.id;
					return `${i + 1}. ${title} (id: ${doc.id})`;
				})
				.join("\n");

			const text = `Found ${sliced.length} document(s):\n\n${formatted}`;
			await callback?.({ text });
			return {
				text,
				success: true,
				values: { count: sliced.length },
				data: {
					actionName: "LIST_DOCUMENTS",
					documents: sliced.map((doc) => ({
						id: doc.id,
						title:
							(doc.metadata?.title as string | undefined) ??
							(doc.metadata?.filename as string | undefined),
					})),
				},
			};
		} catch (error) {
			logger.error(
				{ error: error instanceof Error ? error.message : String(error) },
				"Error in LIST_DOCUMENTS action",
			);
			const errMsg = `I couldn't list documents: ${error instanceof Error ? error.message : String(error)}`;
			await callback?.({ text: errMsg });
			return {
				text: errMsg,
				success: false,
				values: {
					error: error instanceof Error ? error.message : String(error),
				},
				data: { actionName: "LIST_DOCUMENTS" },
			};
		}
	},

	examples: [
		[
			{
				name: "user",
				content: { text: "List all documents in your store." },
			},
			{
				name: "assistant",
				content: {
					text: "Here are the documents I have stored.",
					actions: ["LIST_DOCUMENTS"],
				},
			},
		],
	] as ActionExample[][],
};

// ─── DOCUMENTS umbrella action ─────────────────────────────────────────────────

export const documentsAction: Action = {
	name: "DOCUMENTS",
	contexts: ["documents"],
	contextGate: { anyOf: ["documents"] },
	roleGate: { minRole: "USER" },
	description:
		"Parent action for all document-store operations. Dispatches to the appropriate sub-action: SEARCH_DOCUMENTS, READ_DOCUMENT, WRITE_DOCUMENT, EDIT_DOCUMENT, DELETE_DOCUMENT, LIST_DOCUMENTS, IMPORT_DOCUMENT_FROM_FILE, or IMPORT_DOCUMENT_FROM_URL.",
	suppressPostActionContinuation: true,
	subActions: [
		"SEARCH_DOCUMENTS",
		"READ_DOCUMENT",
		"WRITE_DOCUMENT",
		"EDIT_DOCUMENT",
		"DELETE_DOCUMENT",
		"LIST_DOCUMENTS",
		"IMPORT_DOCUMENT_FROM_FILE",
		"IMPORT_DOCUMENT_FROM_URL",
	],
	parameters: [],

	validate: async (runtime: IAgentRuntime): Promise<boolean> => {
		return Boolean(runtime.getService(KnowledgeService.serviceType));
	},

	handler: async (
		_runtime: IAgentRuntime,
		_message: Memory,
		_state?: State,
		_options?: HandlerOptions,
		callback?: HandlerCallback,
	): Promise<ActionResult> => {
		const text =
			"Please use a specific document action: SEARCH_DOCUMENTS, READ_DOCUMENT, WRITE_DOCUMENT, EDIT_DOCUMENT, DELETE_DOCUMENT, LIST_DOCUMENTS, IMPORT_DOCUMENT_FROM_FILE, or IMPORT_DOCUMENT_FROM_URL.";
		await callback?.({ text });
		return {
			text,
			success: false,
			values: { error: "use_sub_action" },
			data: { actionName: "DOCUMENTS" },
		};
	},

	examples: [
		[
			{
				name: "user",
				content: { text: "Work with my documents." },
			},
			{
				name: "assistant",
				content: {
					text: "I can search, read, write, edit, delete, or list documents. What would you like to do?",
					actions: ["DOCUMENTS"],
				},
			},
		],
	] as ActionExample[][],
};

// ─── Exports ─────────────────────────────────────────────────────────────────

export const documentActions = [
	documentsAction,
	searchDocumentsAction,
	readDocumentAction,
	writeDocumentAction,
	editDocumentAction,
	deleteDocumentAction,
	listDocumentsAction,
	importDocumentFromFileAction,
	importDocumentFromUrlAction,
	// Legacy aliases kept for backward compat
	processKnowledgeAction,
	searchKnowledgeAction,
	ingestKnowledgeFromUrlAction,
	updateKnowledgeDocumentAction,
	deleteKnowledgeDocumentAction,
];

/** @deprecated Use documentActions */
export const knowledgeActions = documentActions;
