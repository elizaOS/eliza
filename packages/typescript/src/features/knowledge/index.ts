import type { Plugin } from "../../types";
import { knowledgeActions } from "./actions";
import { documentsProvider } from "./documents-provider";
import { knowledgeProvider } from "./provider";
import { KnowledgeService } from "./service";

export interface KnowledgePluginConfig {
	enableActions?: boolean;
	enableProviders?: boolean;
}

export function createKnowledgePlugin(
	config: KnowledgePluginConfig = {},
): Plugin {
	const { enableActions = true, enableProviders = true } = config;

	return {
		name: "knowledge",
		description:
			"Native Retrieval Augmented Generation capabilities, including knowledge ingestion and retrieval.",
		services: [KnowledgeService],
		providers: enableProviders ? [knowledgeProvider, documentsProvider] : [],
		actions: enableActions ? knowledgeActions : [],
	};
}

export const knowledgePlugin = createKnowledgePlugin();
export const knowledgePluginCore = createKnowledgePlugin({
	enableActions: false,
	enableProviders: true,
});
export const knowledgePluginHeadless = createKnowledgePlugin({
	enableActions: true,
	enableProviders: true,
});

export default knowledgePlugin;

export { knowledgeActions } from "./actions";
export { documentsProvider } from "./documents-provider";
export { knowledgeProvider } from "./provider";
export { KnowledgeService } from "./service";
export * from "./types";
