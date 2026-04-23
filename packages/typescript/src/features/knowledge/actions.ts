import * as fs from "node:fs";
import * as path from "node:path";
import {
	findKeywordTermMatch,
	getValidationKeywordTerms,
} from "../../i18n/validation-keywords.ts";
import { logger } from "../../logger";
import type {
	Action,
	Content,
	HandlerCallback,
	HandlerOptions,
	IAgentRuntime,
	Memory,
	State,
	UUID,
} from "../../types";
import { addKnowledgeFromFilePath } from "./docs-loader.ts";
import { KnowledgeService } from "./service.ts";
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

export const processKnowledgeAction: Action = {
	name: "PROCESS_KNOWLEDGE",
	description:
		"Process and store knowledge from a file path or text content into the knowledge base",

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

			const text = message.content.text || "";
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
					return;
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
					return;
				}

				const title = deriveKnowledgeTitle(
					knowledgeContent,
					"Learned knowledge",
				);
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
			return { success: true, text: response.text };
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
				error: error instanceof Error ? error.message : String(error),
			};
		}
	},
};

export const searchKnowledgeAction: Action = {
	name: "SEARCH_KNOWLEDGE",
	description: "Search the knowledge base for specific information",

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

			const text = message.content.text || "";

			const query = text
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
				return;
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
				const formattedResults = results
					.slice(0, 3)
					.map((item, index) => `${index + 1}. ${item.content.text}`)
					.join("\n\n");

				response = {
					text: `Here's what I found about "${query}":\n\n${formattedResults}`,
				};
			}

			if (callback) {
				await callback(response);
			}
			return { success: true, text: response.text };
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
				error: error instanceof Error ? error.message : String(error),
			};
		}
	},
};

export const knowledgeActions = [processKnowledgeAction, searchKnowledgeAction];
