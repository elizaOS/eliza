/**
 * Advanced Capabilities
 *
 * Extended functionality that can be enabled with `enableExtendedCapabilities: true`
 * or `advancedCapabilities: true` in plugin initialization.
 *
 * These provide additional agent features:
 * - Extended providers (facts, contacts, relationships, roles, settings, todos, personality)
 * - Advanced actions (contacts management, room management, personality)
 *   Note: todo planner actions are NOT registered here. The canonical todo
 *   surfaces are TODO (plugin-todos) and OWNER_TODOS (app-lifeops).
 * - Registered post-turn evaluators (experience, skills, facts, relationships,
 *   identities, task success)
 * - Additional services (experience, todos, personality)
 */

import { withCanonicalActionDocs } from "../../action-docs.ts";
import { promoteSubactionsToActions } from "../../actions/promote-subactions.ts";
import { createService } from "../../services.ts";
import type { IAgentRuntime, RegisteredEvaluator } from "../../types/index.ts";
import type { ServiceClass } from "../../types/plugin.ts";
// Direct leaf-file imports — see comment lower in this file for the
// Bun.build mis-rewrite that requires bypassing barrels.
import { searchExperiencesAction } from "./experience/actions/search-experiences.ts";
import { experiencePatternEvaluator } from "./experience/evaluators/experience-items.ts";
import { experienceProvider } from "./experience/providers/experienceProvider.ts";
import { characterAction } from "./personality/actions/character.ts";
import { personalityAction } from "./personality/actions/personality.ts";
import { userPersonalityProvider } from "./personality/providers/user-personality.ts";
import { todosProvider } from "./todos/providers/todos.ts";

// Re-export action, provider, and post-message-action modules
export * from "./actions/index.ts";
// Explicit named re-exports for symbols that are also referenced from
// runtime capability lists below — this defeats Bun.build's tree-shaking
// of the underlying module so the symbols stay defined when external
// consumers import them via `@elizaos/core`.
export { roleAction } from "./actions/role.ts";
export * from "./evaluators/index.ts";
export * from "./experience/index.ts";
export type * from "./form/index.ts";
export * from "./personality/index.ts";
export * from "./providers/index.ts";
export * from "./todos/index.ts";

// Import for local use.
//
// We deliberately bypass the local barrels (`./actions/index.ts`,
// `./evaluators/index.ts`, `./providers/index.ts`) and reach for each
// concrete file. Bun.build (1.3.13) collapses re-export-only barrels to
// empty `init_xxx = () => {}` shims AND simultaneously drops the underlying
// `var advancedContactsProvider = ...` declarations from the bundle when
// the only references to those symbols arrive through a `export * from` /
// `export { x }` chain. The runtime then throws
// `ReferenceError: advancedContactsProvider is not defined` the first time
// `advancedProviders` is touched. Importing directly from the leaf file
// gives Bun a real per-file consumer it cannot prune.
import { messageAction } from "./actions/message.ts";
import { postAction } from "./actions/post.ts";
import { updateRoleAction } from "./actions/role.ts";
import { roomOpAction } from "./actions/room.ts";
import { reflectionItems } from "./evaluators/reflection-items.ts";
import { skillItems } from "./evaluators/skill-items.ts";
import { advancedContactsProvider } from "./providers/contacts.ts";
import { factsProvider } from "./providers/facts.ts";
import { followUpsProvider } from "./providers/followUps.ts";
import { relationshipsProvider } from "./providers/relationships.ts";
import { roleProvider } from "./providers/roles.ts";
import { settingsProvider } from "./providers/settings.ts";

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
	...promoteSubactionsToActions(withCanonicalActionDocs(roomOpAction)),
	withCanonicalActionDocs(updateRoleAction),
	withCanonicalActionDocs(searchExperiencesAction),
	...promoteSubactionsToActions(messageAction),
	...promoteSubactionsToActions(postAction),
	// Personality actions — keep CHARACTER (legacy) alongside the new
	// PERSONALITY surface so existing callers continue to resolve.
	...promoteSubactionsToActions(characterAction),
	...promoteSubactionsToActions(withCanonicalActionDocs(personalityAction)),
];

export const advancedEvaluators = [
	...reflectionItems,
	...skillItems,
	experiencePatternEvaluator,
] satisfies readonly RegisteredEvaluator[];

/**
 * Advanced services - extended service infrastructure
 */
export const advancedServices: ServiceClass[] = [
	createService("EXPERIENCE")
		.withDescription("Experience memory service")
		.withStart(async (runtime: IAgentRuntime) => {
			const { ExperienceService } = await import("./experience/service.ts");
			return ExperienceService.start(runtime);
		})
		.build(),
	createService("CHARACTER_MANAGEMENT")
		.withDescription("Character management service")
		.withStart(async (runtime: IAgentRuntime) => {
			const { CharacterFileManager } = await import(
				"./personality/services/character-file-manager.ts"
			);
			return CharacterFileManager.start(runtime);
		})
		.build(),
	createService("PERSONALITY_STORE")
		.withDescription("Structured personality slot store + named profiles")
		.withStart(async (runtime: IAgentRuntime) => {
			const { PersonalityStore } = await import(
				"./personality/services/personality-store.ts"
			);
			return PersonalityStore.start(runtime);
		})
		.build(),
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
