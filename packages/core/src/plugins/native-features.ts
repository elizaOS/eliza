// Direct leaf-file imports — see comment in
// ../features/advanced-capabilities/index.ts for the Bun.build mis-rewrite
// that requires bypassing the barrels here too.
import { promoteSubactionsToActions } from "../actions/promote-subactions";
import { messageAction } from "../features/advanced-capabilities/actions/message";
import { postAction } from "../features/advanced-capabilities/actions/post";
import { reflectionItems } from "../features/advanced-capabilities/evaluators/reflection-items";
import { skillItems } from "../features/advanced-capabilities/evaluators/skill-items";
import { advancedContactsProvider } from "../features/advanced-capabilities/providers/contacts";
import { factsProvider } from "../features/advanced-capabilities/providers/facts";
import { followUpsProvider } from "../features/advanced-capabilities/providers/followUps";
import { relationshipsProvider } from "../features/advanced-capabilities/providers/relationships";
import {
	__setDocumentUrlFetchImplForTests,
	DocumentService,
	documentsPlugin,
	type FetchDocumentFromUrlOptions,
	type FetchedDocumentUrl,
	type FetchedDocumentUrlKind,
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
		// Contact / Rolodex / entity ops are consolidated into the
		// `CONTACT` parent action in `@elizaos/agent`
		// (packages/agent/src/actions/contact.ts). The old
		// addContactAction / removeContactAction / searchContactsAction /
		// updateContactAction / updateEntityAction leaves are no longer
		// registered here — their similes live on CONTACT's similes list.
		// MESSAGE and POST register the parent umbrella plus virtual
		// MESSAGE_<SUB> / POST_<SUB> actions for every subaction. The
		// virtuals delegate to the parent's handler with `subaction:`
		// injected, so the planner can pick a specific verb directly OR
		// call the parent with custom params.
		...promoteSubactionsToActions(messageAction),
		...promoteSubactionsToActions(postAction),
	],
	evaluators: [...reflectionItems, ...skillItems],
	providers: [
		advancedContactsProvider,
		factsProvider,
		followUpsProvider,
		relationshipsProvider,
	],
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
	FetchDocumentFromUrlOptions,
	FetchedDocumentUrl,
	FetchedDocumentUrlKind,
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
