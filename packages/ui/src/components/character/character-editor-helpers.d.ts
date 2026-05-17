/**
 * Pure helpers extracted from CharacterEditor and AppContext
 * for testability and reuse.
 */
import type { StylePreset } from "@elizaos/shared";
import type { CharacterRosterEntry } from "./CharacterRoster";
export { replaceNameTokens } from "../../utils/name-tokens";
export type OnboardingPreset = StylePreset;
export declare function getOnboardingPresetStyles(options: unknown): readonly OnboardingPreset[];
export declare function replaceCharacterToken(value: string, name: string): string;
export declare function buildCharacterDraftFromPreset(entry: CharacterRosterEntry): {
    name: string;
    username: string;
    bio: string;
    system: string;
    adjectives: string[];
    style: {
        all: string[];
        chat: string[];
        post: string[];
    };
    messageExamples: {
        examples: {
            name: string;
            content: {
                text: string;
            };
        }[];
    }[];
    postExamples: string[];
};
/**
 * Decide whether the character editor should apply preset defaults when
 * auto-selecting a roster entry.
 *
 * Returns `true` when:
 * - The saved character has no meaningful content (fresh state), OR
 * - The active roster entry name differs from the saved character name
 *   (user switched presets — e.g. selected Momo but Chen is saved).
 */
export declare function shouldApplyPresetDefaults(hasMeaningfulContent: boolean, savedCharacterName: string | null | undefined, rosterEntryName: string): boolean;
//# sourceMappingURL=character-editor-helpers.d.ts.map