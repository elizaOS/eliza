/**
 * Registry of optional, core-compiled "native" runtime feature plugins —
 * documents, relationships, trajectories, advancedPlanning, advancedMemory — that
 * the runtime boot loop enables per character flag. Exposes the resolution tables
 * mapping each feature to its plugin, plugin name, default on/off, and owned
 * service types, plus the reverse lookups (service-type→feature, name→feature).
 * Also defines the `relationships` plugin: the native relationship / contact /
 * follow-up / social-memory capability bundle. Iterating this single registry
 * keeps per-feature enablement out of hard-coded runtime branches.
 */
// Direct leaf-file imports — see comment in
// ../features/advanced-capabilities/index.ts for the Bun.build mis-rewrite
// that requires bypassing the barrels here too.
import { promoteSubactionsToActions } from "../actions/promote-subactions";
import { messageAction } from "../features/advanced-capabilities/actions/message";
import { postAction } from "../features/advanced-capabilities/actions/post";
import { preferenceItems } from "../features/advanced-capabilities/evaluators/preference-items";
import { reflectionItems } from "../features/advanced-capabilities/evaluators/reflection-items";
import { skillItems } from "../features/advanced-capabilities/evaluators/skill-items";
import { advancedContactsProvider } from "../features/advanced-capabilities/providers/contacts";
import { factsProvider } from "../features/advanced-capabilities/providers/facts";
import { followUpsProvider } from "../features/advanced-capabilities/providers/followUps";
import { relationshipsProvider } from "../features/advanced-capabilities/providers/relationships";
import { createAdvancedMemoryPlugin } from "../features/advanced-memory/index";
import { createAdvancedPlanningPlugin } from "../features/advanced-planning/index";
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
import {
	TrajectoriesService,
	trajectoriesPlugin,
} from "../features/trajectories/index";
import { FollowUpService } from "../services/followUp";
import { RelationshipsService } from "../services/relationships";
import type { Plugin } from "../types/plugin";
import type { ServiceTypeName } from "../types/service";

// advancedPlanning/advancedMemory are core-compiled feature plugins gated by a
// character flag; they live in the native-feature registry (default off) rather
// than as bespoke if-blocks in `_initializeCore`. Constructed once — the Plugin
// object is stateless config, matching the other singleton entries below.
const advancedPlanningPlugin = createAdvancedPlanningPlugin();
const advancedMemoryPlugin = createAdvancedMemoryPlugin();

export type NativeRuntimeFeature =
	| "documents"
	| "relationships"
	| "trajectories"
	| "advancedPlanning"
	| "advancedMemory";

export const relationshipsPlugin: Plugin = {
	name: "relationships",
	description:
		"Native relationship, contact, follow-up, and social memory capabilities.",
	actions: [
		// Contact / Rolodex / entity ops live on the `CONTACT` parent action in
		// `@elizaos/agent` (packages/agent/src/actions/contact.ts), not as leaves
		// here — their similes live on CONTACT's similes list. MESSAGE and POST
		// register the parent umbrella plus virtual MESSAGE_<SUB> / POST_<SUB>
		// actions for every subaction; the virtuals delegate to the parent's
		// handler with `subaction:` injected, so the planner can pick a specific
		// verb directly OR call the parent with custom params.
		...promoteSubactionsToActions(messageAction),
		...promoteSubactionsToActions(postAction),
	],
	evaluators: [...reflectionItems, ...preferenceItems, ...skillItems],
	providers: [
		advancedContactsProvider,
		factsProvider,
		followUpsProvider,
		relationshipsProvider,
	],
	services: [RelationshipsService, FollowUpService],
	async dispose(runtime) {
		await runtime.getService(FollowUpService.serviceType)?.stop();
		await runtime.getService(RelationshipsService.serviceType)?.stop();
	},
};

export const nativeRuntimeFeaturePlugins: Record<NativeRuntimeFeature, Plugin> =
	{
		documents: documentsPlugin,
		relationships: relationshipsPlugin,
		trajectories: trajectoriesPlugin,
		advancedPlanning: advancedPlanningPlugin,
		advancedMemory: advancedMemoryPlugin,
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
	advancedPlanning: advancedPlanningPlugin.name,
	advancedMemory: advancedMemoryPlugin.name,
};

export const nativeRuntimeFeatureDefaults: Record<
	NativeRuntimeFeature,
	boolean
> = {
	documents: true,
	relationships: true,
	trajectories: true,
	advancedPlanning: false,
	advancedMemory: false,
};

export const nativeRuntimeFeatureServiceTypes: Record<
	NativeRuntimeFeature,
	ServiceTypeName[]
> = {
	documents: [DocumentService.serviceType],
	relationships: [
		RelationshipsService.serviceType,
		FollowUpService.serviceType,
	],
	trajectories: [TrajectoriesService.serviceType],
	advancedPlanning: [],
	advancedMemory: [],
};

export function resolveNativeRuntimeFeatureFromServiceType(
	serviceType: ServiceTypeName | string,
): NativeRuntimeFeature | null {
	for (const feature of Object.keys(
		nativeRuntimeFeatureServiceTypes,
	) as NativeRuntimeFeature[]) {
		if (
			nativeRuntimeFeatureServiceTypes[feature].some(
				(candidate) => candidate === serviceType,
			)
		) {
			return feature;
		}
	}

	return null;
}

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
