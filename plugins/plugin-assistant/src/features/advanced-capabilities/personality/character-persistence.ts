/**
 * Defines the personality feature's persistence port for character edits.
 * Hosts implement config, database and history writes; assistant callers resolve
 * the port without importing host process code. This entry point has no runtime
 * dependencies, so hosts can share its contract without loading assistant policy.
 */
import type { IAgentRuntime } from "@elizaos/core";

export const CHARACTER_PERSISTENCE_SERVICE = "eliza_character_persistence";

export type CharacterPersistenceSource = "manual" | "agent" | "restore";

export type PersistableCharacter = {
  name?: string;
  username?: string;
  bio?: string | string[];
  system?: string;
  adjectives?: string[];
  topics?: string[];
  style?: {
    all?: string[];
    chat?: string[];
    post?: string[];
  };
  postExamples?: string[];
  messageExamples?: unknown;
  settings?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

export interface PersistCharacterParams {
  character?: PersistableCharacter;
  previousCharacter?: PersistableCharacter;
  previousName?: string;
  source?: CharacterPersistenceSource;
}

export interface PersistCharacterResult {
  success: boolean;
  error?: string;
}

export interface CharacterPersistenceServiceLike {
  persistCharacter(
    params?: PersistCharacterParams,
  ): Promise<PersistCharacterResult>;
}

export function isCharacterPersistenceService(
  service: unknown,
): service is CharacterPersistenceServiceLike {
  return (
    typeof service === "object" &&
    service !== null &&
    "persistCharacter" in service &&
    typeof service.persistCharacter === "function"
  );
}

export function getCharacterPersistenceService(
  runtime: IAgentRuntime,
): CharacterPersistenceServiceLike | null {
  const service = runtime.getService(CHARACTER_PERSISTENCE_SERVICE);
  return isCharacterPersistenceService(service) ? service : null;
}
