/**
 * Archetypes Module
 *
 * Central service for managing agent archetype configurations and behaviors.
 */

export {
  type ArchetypeActionWeights,
  type ArchetypeConfig,
  ArchetypeConfigService,
  type ArchetypeTraits,
  archetypeConfigService,
} from "./ArchetypeConfigService";

export {
  type ArchetypeResolver,
  createArchetypeResolver,
  deriveArchetype,
  getRoleArchetype,
  getValidArchetypes,
  type NPCCharacteristics,
} from "./derive-archetype";
