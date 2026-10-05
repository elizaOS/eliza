/** Optional assistant feature plugins and names used by the host plugin catalog. */
// Direct leaf-file imports — see comment in
// ../features/advanced-capabilities/index.ts for the Bun.build mis-rewrite
// that requires bypassing the barrels here too.

import type { Plugin } from "@elizaos/core";
import { promoteSubactionsToActions } from "@elizaos/core";
import { messageAction } from "../features/advanced-capabilities/actions/message";
import { postAction } from "../features/advanced-capabilities/actions/post";
import { preferenceItems } from "../features/advanced-capabilities/evaluators/preference-items";
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
import {
  TrajectoriesService,
  trajectoriesPlugin,
} from "../features/trajectories/index";
import { FollowUpService } from "../services/followUp.ts";
import { RelationshipsService } from "../services/relationships.ts";

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

export const nativeRuntimeFeaturePluginNames: Record<
  NativeRuntimeFeature,
  string
> = {
  documents: documentsPlugin.name,
  relationships: relationshipsPlugin.name,
  trajectories: trajectoriesPlugin.name,
  advancedPlanning: "advanced-planning",
  advancedMemory: "memory",
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
