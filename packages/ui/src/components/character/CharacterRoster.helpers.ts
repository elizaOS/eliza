import type { StylePreset } from "@elizaos/shared";
import type { CharacterRosterEntry } from "./CharacterRoster";

export const SLANT_CLIP =
  "polygon(32px 0, 100% 0, calc(100% - 32px) 100%, 0 100%)";
export const INSET_CLIP =
  "polygon(0px 0, 100% 0, calc(100% - 4px) 100%, -8px 100%)";

export function resolveRosterEntries(
  styles: readonly StylePreset[],
): CharacterRosterEntry[] {
  return styles.map((preset, index) => {
    const fallbackName = `Character ${index + 1}`;
    return {
      id: preset.id,
      name: preset.name ?? fallbackName,
      avatarIndex: preset.avatarIndex ?? (index % 4) + 1,
      voicePresetId: preset.voicePresetId,
      catchphrase: preset.catchphrase,
      greetingAnimation: preset.greetingAnimation,
      preset,
    };
  });
}

export function createCustomPackRosterEntry(args: {
  id: string;
  name: string;
  previewUrl?: string;
  catchphrase?: string;
  voicePresetId?: string;
}): CharacterRosterEntry {
  const name = args.name.trim() || "Custom";
  return {
    id: args.id,
    name,
    avatarIndex: 0,
    previewUrl: args.previewUrl,
    voicePresetId: args.voicePresetId,
    catchphrase: args.catchphrase,
    preset: {
      id: args.id,
      name,
      avatarIndex: 0,
      voicePresetId: args.voicePresetId ?? "",
      greetingAnimation: "",
      catchphrase: args.catchphrase ?? "",
      hint: "",
      bio: [],
      system: "",
      adjectives: [],
      style: { all: [], chat: [], post: [] },
      topics: [],
      postExamples: [],
      messageExamples: [],
    },
  };
}
