import { withCanonicalActionDocs } from "../action-docs";
import {
	addContactAction,
	deleteMessageAction,
	editMessageAction,
	getUserAction,
	joinChannelAction,
	leaveChannelAction,
	listChannelsAction,
	listServersAction,
	messageAction,
	pinMessageAction,
	postAction,
	reactToMessageAction,
	readFeedAction,
	readMessagesAction,
	removeContactAction,
	scheduleFollowUpAction,
	searchContactsAction,
	searchMessagesAction,
	searchPostsAction,
	sendMessageAction,
	sendPostAction,
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
	__setDocumentUrlFetchImplForTests,
	documentsPlugin,
	DocumentService,
	type FetchedDocumentUrl,
	type FetchedDocumentUrlKind,
	type FetchDocumentFromUrlOptions,
	fetchDocumentFromUrl,
	isYouTubeUrl,
} from "../features/documents/index";
import { trajectoriesPlugin } from "../features/trajectories/index";
import { FollowUpService } from "../services/followUp";
import { RelationshipsService } from "../services/relationships";
import type { Plugin } from "../types/plugin";

export type NativeRuntimeFeature =
	| "documents"
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
		messageAction,
		postAction,
		// MESSAGE sub-actions — explicit per-op canonical actions (v4 plan).
		// Registered alongside the MESSAGE umbrella so the planner can pick
		// either the high-level intent or a precise op directly.
		sendMessageAction,
		readMessagesAction,
		searchMessagesAction,
		listChannelsAction,
		listServersAction,
		reactToMessageAction,
		editMessageAction,
		deleteMessageAction,
		pinMessageAction,
		joinChannelAction,
		leaveChannelAction,
		getUserAction,
		// POST sub-actions.
		sendPostAction,
		readFeedAction,
		searchPostsAction,
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
	relationships: relationshipsPlugin.name,
	trajectories: trajectoriesPlugin.name,
};

export const nativeRuntimeFeatureDefaults: Record<
	NativeRuntimeFeature,
	boolean
> = {
	documents: true,
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
	documentsPlugin,
	documentsPluginCore,
	documentsPluginHeadless,
} from "../features/documents/index";
export type {
	FetchedDocumentUrl,
	FetchedDocumentUrlKind,
	FetchDocumentFromUrlOptions,
};
export {
	__setDocumentUrlFetchImplForTests,
	DocumentService,
	FollowUpService,
	fetchDocumentFromUrl,
	isYouTubeUrl,
	RelationshipsService,
	trajectoriesPlugin,
};
