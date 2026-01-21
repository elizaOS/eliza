/**
 * Advanced Capabilities
 *
 * Extended functionality that can be enabled with `enableExtendedCapabilities: true`
 * or `advancedCapabilities: true` in plugin initialization.
 *
 * These provide additional agent features:
 * - Extended providers (facts, contacts, relationships, roles, settings, knowledge)
 * - Advanced actions (contacts management, room management, image generation, etc.)
 * - Evaluators (reflection, relationship extraction)
 * - Additional services (rolodex, follow-ups)
 */

import { withCanonicalActionDocs } from "../action-docs.ts";
import { FollowUpService } from "../services/followUp.ts";
import { RolodexService } from "../services/rolodex.ts";
import type { ServiceClass } from "../types/plugin.ts";

// Re-export action, provider, and evaluator modules
export * from "./actions/index.ts";
export * from "./evaluators/index.ts";
export * from "./providers/index.ts";

// Import for local use
import * as actions from "./actions/index.ts";
import * as evaluators from "./evaluators/index.ts";
import * as providers from "./providers/index.ts";

/**
 * Advanced providers - extended context and state management
 */
export const advancedProviders = [
  providers.contactsProvider,
  providers.factsProvider,
  providers.followUpsProvider,
  providers.knowledgeProvider,
  providers.relationshipsProvider,
  providers.roleProvider,
  providers.settingsProvider,
];

/**
 * Advanced actions - extended agent capabilities
 */
export const advancedActions = [
  withCanonicalActionDocs(actions.addContactAction),
  withCanonicalActionDocs(actions.followRoomAction),
  withCanonicalActionDocs(actions.generateImageAction),
  withCanonicalActionDocs(actions.muteRoomAction),
  withCanonicalActionDocs(actions.removeContactAction),
  withCanonicalActionDocs(actions.scheduleFollowUpAction),
  withCanonicalActionDocs(actions.searchContactsAction),
  withCanonicalActionDocs(actions.sendMessageAction),
  withCanonicalActionDocs(actions.unfollowRoomAction),
  withCanonicalActionDocs(actions.unmuteRoomAction),
  withCanonicalActionDocs(actions.updateContactAction),
  withCanonicalActionDocs(actions.updateEntityAction),
  withCanonicalActionDocs(actions.updateRoleAction),
  withCanonicalActionDocs(actions.updateSettingsAction),
];

/**
 * Advanced evaluators - memory and relationship management
 */
export const advancedEvaluators = [
  evaluators.reflectionEvaluator,
  evaluators.relationshipExtractionEvaluator,
];

/**
 * Advanced services - extended service infrastructure
 */
export const advancedServices: ServiceClass[] = [
  RolodexService,
  FollowUpService,
];

/**
 * Combined advanced capabilities object
 */
export const advancedCapabilities = {
  providers: advancedProviders,
  actions: advancedActions,
  evaluators: advancedEvaluators,
  services: advancedServices,
};

export default advancedCapabilities;
