import type { Plugin } from "../../types";
import { documentActions } from "./actions";
import { documentsProvider } from "./documents-provider";
import { knowledgeProvider } from "./provider";
import { KnowledgeService } from "./service";

export interface DocumentsPluginConfig {
	enableActions?: boolean;
	enableProviders?: boolean;
}

/** @deprecated Use DocumentsPluginConfig */
export type KnowledgePluginConfig = DocumentsPluginConfig;

export function createDocumentsPlugin(
	config: DocumentsPluginConfig = {},
): Plugin {
	const { enableActions = true, enableProviders = true } = config;

	return {
		name: "documents",
		description:
			"Native Retrieval Augmented Generation capabilities, including document ingestion and retrieval.",
		services: [KnowledgeService],
		providers: enableProviders ? [knowledgeProvider, documentsProvider] : [],
		actions: enableActions ? documentActions : [],
	};
}

/** @deprecated Use createDocumentsPlugin */
export const createKnowledgePlugin = createDocumentsPlugin;

export const documentsPlugin = createDocumentsPlugin();
export const documentsPluginCore = createDocumentsPlugin({
	enableActions: false,
	enableProviders: true,
});
export const documentsPluginHeadless = createDocumentsPlugin({
	enableActions: true,
	enableProviders: true,
});

/** @deprecated Use documentsPlugin */
export const knowledgePlugin = documentsPlugin;
/** @deprecated Use documentsPluginCore */
export const knowledgePluginCore = documentsPluginCore;
/** @deprecated Use documentsPluginHeadless */
export const knowledgePluginHeadless = documentsPluginHeadless;

export default documentsPlugin;

export { documentActions } from "./actions";

/** @deprecated Use documentActions */
export const knowledgeActions = documentActions;
export type { Bm25Document, Bm25Options, Bm25Score } from "./bm25";
export { bm25Scores, normalizeBm25Scores, tokenize } from "./bm25";
export { documentsProvider } from "./documents-provider";
export { knowledgeProvider } from "./provider";
export type { SearchMode } from "./service";
export { KnowledgeService } from "./service";
export * from "./types";
export {
	__setKnowledgeUrlFetchImplForTests,
	type FetchedKnowledgeUrl,
	type FetchedKnowledgeUrlKind,
	type FetchKnowledgeFromUrlOptions,
	fetchKnowledgeFromUrl,
	isYouTubeUrl,
} from "./url-ingest";
