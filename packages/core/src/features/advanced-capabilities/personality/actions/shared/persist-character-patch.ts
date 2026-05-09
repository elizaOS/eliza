import { logger } from "../../../../../logger.ts";
import type { Character, IAgentRuntime } from "../../../../../types/index.ts";
import { getCharacterPersistenceService } from "../../character-persistence.ts";

/**
 * Apply a partial replacement patch to the runtime character and persist it
 * through the same `eliza_character_persistence` service that
 * `MODIFY_CHARACTER` (CharacterFileManager.applyModification) uses.
 *
 * Unlike `applyModification`, this performs a shallow field replacement
 * (no merge/append of arrays) so callers can implement remove/edit/reorder
 * semantics on top of it. Caller is responsible for computing the next value
 * of any array fields (`style`, `messageExamples`, `postExamples`, etc.).
 *
 * Updates `runtime.character` only after persistence succeeds.
 */
export async function persistCharacterPatch(
	runtime: IAgentRuntime,
	patch: Partial<Character>,
): Promise<{ success: boolean; error?: string }> {
	if (Object.keys(patch).length === 0) {
		return { success: true };
	}

	const previousCharacter = { ...runtime.character } as Record<string, unknown>;
	const previousName =
		typeof runtime.character.name === "string"
			? runtime.character.name
			: undefined;

	const nextCharacter = {
		...runtime.character,
		...patch,
	} as Record<string, unknown>;

	const persistenceService = getCharacterPersistenceService(runtime);

	if (persistenceService) {
		const result = await persistenceService.persistCharacter({
			character: nextCharacter,
			previousCharacter,
			previousName,
			source: "agent",
		});
		if (!result.success) {
			logger.warn(
				{ error: result.error },
				"persistCharacterPatch: persistence service returned failure",
			);
			return result;
		}
	}

	Object.assign(runtime.character, patch);
	return { success: true };
}
