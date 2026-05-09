/**
 * Advanced Capabilities
 *
 * Extended functionality that can be enabled with `enableExtendedCapabilities: true`
 * or `advancedCapabilities: true` in plugin initialization.
 *
 * These provide additional agent features:
 * - Extended providers (facts, contacts, relationships, roles, settings, todos, personality)
 * - Advanced actions (contacts management, room management, todos, personality)
 * - Registered post-turn evaluators (experience, skills, facts, relationships,
 *   identities, task success)
 * - Additional services (experience, todos, personality)
 */

import { withCanonicalActionDocs } from "../../action-docs.ts";
import type { Evaluator, IAgentRuntime } from "../../types/index.ts";
import type { ServiceClass } from "../../types/plugin.ts";
import {
	experiencePatternEvaluator,
	experienceProvider,
	searchExperiencesAction,
} from "./experience/index.ts";

// Personality imports
import {
	characterAction,
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

// Re-export action, provider, and post-message-action modules
export * from "./actions/index.ts";
export * from "./evaluators/index.ts";
export * from "./experience/index.ts";
export type * from "./form/index.ts";
export * from "./personality/index.ts";
export * from "./providers/index.ts";
export * from "./todos/index.ts";

// Import for local use.
//
// Direct named imports (not `import * as ns`) — Bun.build mis-rewrites the
// namespace-access pattern (`ns.x`) when the same module is also re-exported
// via `export * from`. The alias collision produces `ReferenceError: x is
// not defined` at runtime in the on-device bundle. Direct named imports
// bypass the bug.
import {
	messageAction,
	postAction,
	roomOpAction,
	updateRoleAction,
} from "./actions/index.ts";
import { reflectionItems, skillItems } from "./evaluators/index.ts";
import {
	advancedContactsProvider,
	factsProvider,
	followUpsProvider,
	relationshipsProvider,
	roleProvider,
	settingsProvider,
} from "./providers/index.ts";

/**
 * Advanced providers - extended context and state management
 */
export const advancedProviders = [
	advancedContactsProvider,
	factsProvider,
	followUpsProvider,
	relationshipsProvider,
	roleProvider,
	settingsProvider,
	experienceProvider,
	todosProvider,
	userPersonalityProvider,
];

/**
 * Advanced actions - extended agent capabilities.
 *
 * Includes planner actions only. Post-turn evaluation is registered through
 * `advancedEvaluators` and run by the EvaluatorService in one model call.
 */
export const advancedActions = [
	withCanonicalActionDocs(roomOpAction),
	withCanonicalActionDocs(updateRoleAction),
	withCanonicalActionDocs(searchExperiencesAction),
	messageAction,
	postAction,
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

export const advancedEvaluators = [
	...reflectionItems,
	...skillItems,
	experiencePatternEvaluator,
] as unknown as Evaluator[];

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
