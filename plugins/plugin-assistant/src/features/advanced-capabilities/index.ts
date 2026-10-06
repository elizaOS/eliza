/**
 * Advanced Capabilities
 *
 * Assistant features registered explicitly by createAssistantPlugin().
 *
 * These provide additional agent features:
 * - Extended providers (facts, contacts, relationships, roles, settings, personality)
 * - Advanced actions (contacts management, room management, personality)
 *   Note: todos are owned entirely by @elizaos/plugin-todos (the `TODO` action +
 *   `currentTodosProvider` + DB-backed TodosService) and app-lifeops
 *   (`OWNER_TODOS`). Core registers no todos provider, service, or action.
 * - Registered post-turn evaluators (experience, skills, facts, relationships,
 *   identities, task success)
 * - Additional services (experience, personality)
 */

import type {
  IAgentRuntime,
  RegisteredEvaluator,
  ServiceClass,
} from "@elizaos/core";
import { createService, promoteSubactionsToActions } from "@elizaos/core";
import { messageAction } from "./actions/message.ts";
import { postAction } from "./actions/post.ts";
import { updateRoleAction } from "./actions/role.ts";
import { roomOpAction } from "./actions/room.ts";
import { preferenceItems } from "./evaluators/preference-items.ts";
import { reflectionItems } from "./evaluators/reflection-items.ts";
import { skillItems } from "./evaluators/skill-items.ts";
import { manageExperienceAction } from "./experience/actions/manage-experience.ts";
import { searchExperiencesAction } from "./experience/actions/search-experiences.ts";
import { experiencePatternEvaluator } from "./experience/evaluators/experience-items.ts";
import { experienceProvider } from "./experience/providers/experienceProvider.ts";
import { characterAction } from "./personality/actions/character.ts";
import { personalityAction } from "./personality/actions/personality.ts";
import { characterGateNoticeProvider } from "./personality/providers/character-gate-notice.ts";
import { userPersonalityProvider } from "./personality/providers/user-personality.ts";
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
  userPersonalityProvider,
  characterGateNoticeProvider,
];

/**
 * Advanced actions - extended agent capabilities.
 *
 * Includes planner actions only. Post-turn evaluation is registered through
 * `advancedEvaluators` and run by the EvaluatorService in one model call.
 */
export const advancedActions = [
  ...promoteSubactionsToActions(roomOpAction),
  updateRoleAction,
  searchExperiencesAction,
  manageExperienceAction,
  ...promoteSubactionsToActions(messageAction),
  ...promoteSubactionsToActions(postAction),
  // Personality actions — keep CHARACTER (legacy) alongside the new
  // PERSONALITY surface so existing callers continue to resolve.
  ...promoteSubactionsToActions(characterAction),
  ...promoteSubactionsToActions(personalityAction),
];

export const advancedEvaluators = [
  ...reflectionItems,
  ...preferenceItems,
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
