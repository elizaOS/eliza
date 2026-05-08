/**
 * Advanced Capabilities
 *
 * Extended functionality that can be enabled with `enableExtendedCapabilities: true`
 * or `advancedCapabilities: true` in plugin initialization.
 *
 * These provide additional agent features:
 * - Extended providers (facts, contacts, relationships, roles, settings, todos, personality)
 * - Advanced actions (contacts management, room management, todos, personality, etc.)
 * - Evaluators (reflection, relationship extraction, experience learning, character evolution)
 * - Additional services (experience, todos, personality)
 */

import { withCanonicalActionDocs } from "../../action-docs.ts";
import type { IAgentRuntime } from "../../types/index.ts";
import type { ServiceClass } from "../../types/plugin.ts";
import {
	experienceEvaluator,
	experienceProvider,
	searchExperiencesAction,
} from "./experience/index.ts";

// Personality imports
import {
	characterAction,
	characterEvolutionEvaluator,
	userPersonalityProvider,
} from "./personality/index.ts";

// Todos imports
import {
	completeTodoAction,
	createTodoAction,
	deleteTodoAction,
	editTodoAction,
	listTodosAction,
	todoAction,
	todosProvider,
} from "./todos/index.ts";

// Re-export action, provider, and evaluator modules
export * from "./actions/index.ts";
export * from "./evaluators/index.ts";
export * from "./experience/index.ts";
export type * from "./form/index.ts";
export * from "./personality/index.ts";
export * from "./providers/index.ts";
export * from "./todos/index.ts";

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
	providers.relationshipsProvider,
	providers.roleProvider,
	providers.settingsProvider,
	experienceProvider,
	todosProvider,
	userPersonalityProvider,
];

/**
 * Advanced actions - extended agent capabilities
 */
export const advancedActions = [
	withCanonicalActionDocs(actions.roomOpAction),
	withCanonicalActionDocs(actions.updateRoleAction),
	withCanonicalActionDocs(searchExperiencesAction),
	actions.messageAction,
	actions.postAction,
	// Todo actions
	todoAction,
	createTodoAction,
	completeTodoAction,
	listTodosAction,
	editTodoAction,
	deleteTodoAction,
	// Personality actions
	characterAction,
];

/**
 * Advanced evaluators - memory, relationships, experience learning, form, personality
 */
export const advancedEvaluators = [
	evaluators.factExtractorEvaluator,
	evaluators.skillExtractionEvaluator,
	evaluators.skillRefinementEvaluator,
	experienceEvaluator,
	characterEvolutionEvaluator,
];

/**
 * Advanced services - extended service infrastructure
 */
export const advancedServices: ServiceClass[] = [
	{
		serviceType: "EXPERIENCE",
		start: async (runtime: IAgentRuntime) => {
			const { ExperienceService } = await import("./experience/service.ts");
			return ExperienceService.start(runtime);
		},
	} as unknown as ServiceClass,
	{
		serviceType: "CHARACTER_MANAGEMENT",
		start: async (runtime: IAgentRuntime) => {
			const { CharacterFileManager } = await import(
				"./personality/services/character-file-manager.ts"
			);
			return CharacterFileManager.start(runtime);
		},
	} as unknown as ServiceClass,
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
