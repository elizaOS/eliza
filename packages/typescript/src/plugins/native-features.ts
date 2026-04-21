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
	reflectionEvaluator,
	relationshipExtractionEvaluator,
} from "../features/advanced-capabilities/evaluators/index";
import {
	contactsProvider,
	factsProvider,
	followUpsProvider,
	relationshipsProvider,
} from "../features/advanced-capabilities/providers/index";
import {
	createKnowledgePlugin,
	KnowledgeService,
	knowledgePlugin,
	knowledgePluginCore,
	knowledgePluginHeadless,
} from "../features/knowledge/index";
import { trajectoriesPlugin } from "../features/trajectories/index";
import { FollowUpService } from "../services/followUp";
import { RelationshipsService } from "../services/relationships";
import type { Plugin } from "../types/plugin";

export type NativeRuntimeFeature =
	| "knowledge"
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
	],
	providers: [
		contactsProvider,
		factsProvider,
		followUpsProvider,
		relationshipsProvider,
	],
	evaluators: [reflectionEvaluator, relationshipExtractionEvaluator],
	services: [RelationshipsService, FollowUpService],
};

export const nativeRuntimeFeaturePlugins: Record<NativeRuntimeFeature, Plugin> =
	{
		knowledge: knowledgePlugin,
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
	knowledge: knowledgePlugin.name,
	relationships: relationshipsPlugin.name,
	trajectories: trajectoriesPlugin.name,
};

export const nativeRuntimeFeatureDefaults: Record<
	NativeRuntimeFeature,
	boolean
> = {
	knowledge: true,
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
	createKnowledgePlugin,
	FollowUpService,
	KnowledgeService,
	knowledgePlugin,
	knowledgePluginCore,
	knowledgePluginHeadless,
	RelationshipsService,
	trajectoriesPlugin,
};
