/**
 * Advanced Capabilities
 *
 * Extended functionality that can be enabled with `advancedCapabilities: true`
 * in plugin initialization.
 *
 * These provide additional non-rolodex agent features.
 *
 * Relationship extraction/management is owned by `@elizaos/plugin-rolodex`
 * to avoid duplicate evaluators and duplicated social-memory handling.
 */

import { withCanonicalActionDocs } from "../action-docs.ts";
import { TriggerDispatchService } from "../services/triggerWorker.ts";
import type { ServiceClass } from "../types/plugin.ts";

// Re-export action, provider, and evaluator modules
export * from "./actions/index.ts";
export * from "./evaluators/index.ts";
export * from "./providers/index.ts";

// Import for local use
import * as actions from "./actions/index.ts";
import * as providers from "./providers/index.ts";

/**
 * Advanced providers - extended context and state management
 */
export const advancedProviders = [
  providers.knowledgeProvider,
  providers.roleProvider,
  providers.settingsProvider,
];

/**
 * Advanced actions - extended agent capabilities
 */
export const advancedActions = [
  withCanonicalActionDocs(actions.createTaskAction),
  withCanonicalActionDocs(actions.followRoomAction),
  withCanonicalActionDocs(actions.generateImageAction),
  withCanonicalActionDocs(actions.muteRoomAction),
  withCanonicalActionDocs(actions.unfollowRoomAction),
  withCanonicalActionDocs(actions.unmuteRoomAction),
  withCanonicalActionDocs(actions.updateRoleAction),
  withCanonicalActionDocs(actions.updateSettingsAction),
];

/**
 * Relationship evaluators live in plugin-rolodex.
 */
export const advancedEvaluators = [];

/**
 * Advanced services - extended service infrastructure
 */
export const advancedServices: ServiceClass[] = [TriggerDispatchService];

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
