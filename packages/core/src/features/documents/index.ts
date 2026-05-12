import type { Plugin } from "../../types";
import { documentActions } from "./actions";
import { documentsProvider } from "./provider";
import { DocumentService } from "./service";

export interface DocumentsPluginConfig {
	enableActions?: boolean;
	enableProviders?: boolean;
}

export function createDocumentsPlugin(
	config: DocumentsPluginConfig = {},
): Plugin {
	const { enableActions = true, enableProviders = true } = config;

	return {
		name: "documents",
		description:
			"Native Retrieval Augmented Generation capabilities, including document ingestion and retrieval.",
		services: [DocumentService],
		providers: enableProviders ? [documentsProvider] : [],
		actions: enableActions ? documentActions : [],
	};
}

export const documentsPlugin = createDocumentsPlugin();
export const documentsPluginCore = createDocumentsPlugin({
	enableActions: false,
	enableProviders: true,
});
export const documentsPluginHeadless = createDocumentsPlugin({
	enableActions: true,
	enableProviders: true,
});

export default documentsPlugin;

export { documentAction, documentActions } from "./actions";
export type { Bm25Document, Bm25Options, Bm25Score } from "./bm25";
export { bm25Scores, normalizeBm25Scores, tokenize } from "./bm25";
export { documentsProvider } from "./provider";
export type { SearchMode } from "./service";
export { DocumentService } from "./service";
export * from "./types";
export type {
	FetchDocumentFromUrlOptions,
	FetchedDocumentUrl,
	FetchedDocumentUrlKind,
} from "./url-ingest";
export {
	__setDocumentUrlFetchImplForTests,
	fetchDocumentFromUrl,
	isYouTubeUrl,
} from "./url-ingest";
