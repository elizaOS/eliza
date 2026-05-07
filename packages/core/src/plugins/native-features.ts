import { withCanonicalActionDocs } from "../action-docs";
import {
	addContactAction,
	removeContactAction,
	scheduleFollowUpAction,
	searchContactsAction,
	sendMessageAction,
	updateContactAction,
	updateEntityAction,
} from "../features/advanced-capabilities/actions/index";
import {
	factExtractorAction,
	reflectionAction,
	relationshipExtractionAction,
} from "../features/advanced-capabilities/evaluators/index";
import {
	contactsProvider,
	factsProvider,
	followUpsProvider,
	relationshipsProvider,
} from "../features/advanced-capabilities/providers/index";
import {
	__setKnowledgeUrlFetchImplForTests,
	documentsPlugin,
	type FetchedKnowledgeUrl,
	type FetchedKnowledgeUrlKind,
	type FetchKnowledgeFromUrlOptions,
	fetchKnowledgeFromUrl,
	isYouTubeUrl,
	KnowledgeService,
	knowledgePlugin,
} from "../features/documents/index";
import { trajectoriesPlugin } from "../features/trajectories/index";
import { FollowUpService } from "../services/followUp";
import { RelationshipsService } from "../services/relationships";
import type { Plugin } from "../types/plugin";

export type NativeRuntimeFeature =
	| "documents"
	| "knowledge" // legacy alias for "documents"
	| "relationships"
	| "trajectories";

export const relationshipsPlugin: Plugin = {
	name: "relationships",
	description:
		"Native relationship, contact, follow-up, and social memory capabilities.",
	actions: [
		withCanonicalActionDocs(addContactAction),
		withCanonicalActionDocs(removeContactAction),
		withCanonicalActionDocs(scheduleFollowUpAction),
		withCanonicalActionDocs(searchContactsAction),
		withCanonicalActionDocs(sendMessageAction),
		withCanonicalActionDocs(updateContactAction),
		withCanonicalActionDocs(updateEntityAction),
		// ALWAYS_AFTER actions (post-message work; replaces legacy evaluators).
		factExtractorAction,
		reflectionAction,
		// ALWAYS_BEFORE actions (pre-Stage 1 heuristics; runs even on IGNORE/STOP).
		relationshipExtractionAction,
	],
	providers: [
		contactsProvider,
		factsProvider,
		followUpsProvider,
		relationshipsProvider,
	],
	evaluators: [],
	services: [RelationshipsService, FollowUpService],
};

export const nativeRuntimeFeaturePlugins: Record<NativeRuntimeFeature, Plugin> =
	{
		documents: documentsPlugin,
		knowledge: knowledgePlugin, // legacy alias
		relationships: relationshipsPlugin,
		trajectories: trajectoriesPlugin,
	};

export function getNativeRuntimeFeaturePlugin(
	feature: NativeRuntimeFeature,
): Plugin {
	return nativeRuntimeFeaturePlugins[feature];
}

export const nativeRuntimeFeaturePluginNames: Record<
	NativeRuntimeFeature,
	string
> = {
	documents: documentsPlugin.name,
	knowledge: knowledgePlugin.name, // legacy alias
	relationships: relationshipsPlugin.name,
	trajectories: trajectoriesPlugin.name,
};

export const nativeRuntimeFeatureDefaults: Record<
	NativeRuntimeFeature,
	boolean
> = {
	documents: true,
	knowledge: true, // legacy alias
	relationships: true,
	trajectories: true,
};

export function resolveNativeRuntimeFeatureFromPluginName(
	pluginName: string | null | undefined,
): NativeRuntimeFeature | null {
	if (!pluginName) {
		return null;
	}

	for (const feature of Object.keys(
		nativeRuntimeFeaturePluginNames,
	) as NativeRuntimeFeature[]) {
		if (nativeRuntimeFeaturePluginNames[feature] === pluginName) {
			return feature;
		}
	}

	return null;
}

export {
	createDocumentsPlugin,
	createKnowledgePlugin,
	documentsPlugin,
	documentsPluginCore,
	documentsPluginHeadless,
	knowledgePlugin,
	knowledgePluginCore,
	knowledgePluginHeadless,
} from "../features/documents/index";
export type {
	FetchedKnowledgeUrl,
	FetchedKnowledgeUrlKind,
	FetchKnowledgeFromUrlOptions,
};
export {
	__setKnowledgeUrlFetchImplForTests,
	FollowUpService,
	fetchKnowledgeFromUrl,
	isYouTubeUrl,
	KnowledgeService,
	RelationshipsService,
	trajectoriesPlugin,
};
