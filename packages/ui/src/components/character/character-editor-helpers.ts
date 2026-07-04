/**
 * Pure, side-effect-free helpers backing the character editor: resolving
 * first-run preset styles, building a character draft from a roster preset,
 * and deciding when preset defaults should overwrite user edits. Kept separate
 * from the CharacterEditor component so the logic is unit-testable and shared
 * with AppContext without pulling in React.
 */

import type { StylePreset } from "@elizaos/shared";
import type { CharacterRosterEntry } from "./CharacterRoster";

export { replaceNameTokens } from "../../utils/name-tokens";

/* ── Roster / preset helpers ─────────────────────────────────────── */

export type FirstRunPreset = StylePreset;

export function getFirstRunPresetStyles(
  options: unknown,
): readonly FirstRunPreset[] {
  if (!options || typeof options !== "object") return [];
  const styles = (options as { styles?: unknown }).styles;
  return Array.isArray(styles) ? (styles as FirstRunPreset[]) : [];
}

export function replaceCharacterToken(value: string, name: string) {
  return value.replaceAll("{{name}}", name).replaceAll("{{agentName}}", name);
}

export function buildCharacterDraftFromPreset(entry: CharacterRosterEntry) {
  const p: FirstRunPreset = entry.preset;
  const name = entry.name;
  return {
    name,
    username: name,
    bio: p.bio.map((l: string) => replaceCharacterToken(l, name)).join("\n"),
    system: replaceCharacterToken(p.system, name),
    adjectives: [...p.adjectives],
    style: {
      all: [...p.style.all],
      chat: [...p.style.chat],
      post: [...p.style.post],
    },
    messageExamples: p.messageExamples.map(
      (convo: Array<{ user: string; content: { text: string } }>) => ({
        examples: convo.map(
          (msg: { user: string; content: { text: string } }) => ({
            name:
              msg.user === "{{agentName}}"
                ? name
                : replaceCharacterToken(msg.user, name),
            content: { text: replaceCharacterToken(msg.content.text, name) },
          }),
        ),
      }),
    ),
    postExamples: p.postExamples.map((ex: string) =>
      replaceCharacterToken(ex, name),
    ),
  };
}

/**
 * Decide whether the character editor should apply preset defaults when
 * auto-selecting a roster entry.
 *
 * Returns `true` when:
 * - The saved character has no meaningful content (fresh state), OR
 * - The active roster entry name differs from the saved character name
 *   (user switched presets — e.g. selected Momo but Chen is saved).
 */
export function shouldApplyPresetDefaults(
  hasMeaningfulContent: boolean,
  savedCharacterName: string | null | undefined,
  rosterEntryName: string,
): boolean {
  if (!hasMeaningfulContent) return true;

  const savedNorm =
    typeof savedCharacterName === "string"
      ? savedCharacterName.trim().toLowerCase()
      : null;
  const entryNorm = rosterEntryName.trim().toLowerCase();

  // Name mismatch means the user navigated to a different preset
  return savedNorm === null || savedNorm !== entryNorm;
}
