import {
  addLanguageRule,
  DEFAULT_CHARACTER_LANGUAGE as DEFAULT_LANGUAGE,
  normalizeCharacterLanguage,
} from "./character-language.js";
import {
  CHARACTER_DEFINITIONS,
  type CharacterDefinition,
} from "./character-presets.characters.js";
import { SHARED_STYLE_RULES } from "./character-presets.shared.js";
import type {
  CharacterLanguage,
  StylePreset,
} from "./contracts/first-run-options.js";
import { CHARACTER_LANGUAGES } from "./contracts/first-run-options.js";

// Re-export for backward compatibility — the data-free implementation now lives
// in ./character-language.js so the i18n keyword matcher can import it without
// pulling the ~49KB CHARACTER_DEFINITIONS data that this module builds below.
export { normalizeCharacterLanguage, SHARED_STYLE_RULES };

function mergeSharedStyleRules(all: readonly string[]): string[] {
  const merged = [...all];
  for (const rule of SHARED_STYLE_RULES) {
    if (!merged.includes(rule)) {
      merged.push(rule);
    }
  }
  return merged;
}

function resolveCharacterVariant(
  definition: CharacterDefinition,
  language: CharacterLanguage,
): StylePreset {
  const variant = definition.variants[language] ?? definition.variants.en;

  return {
    id: definition.id,
    name: definition.name,
    avatarIndex: definition.avatarIndex,
    voicePresetId: definition.voicePresetId,
    greetingAnimation: definition.greetingAnimation,
    catchphrase: variant.catchphrase,
    hint: variant.hint,
    bio: [...definition.bio],
    system: addLanguageRule(definition.system, language),
    adjectives: [...definition.adjectives],
    style: {
      all: mergeSharedStyleRules(definition.style.all),
      chat: [...definition.style.chat],
      post: [...definition.style.post],
    },
    topics: [...definition.topics],
    postExamples: [...variant.postExamples],
    messageExamples: [...definition.messageExamples],
  };
}

const STYLE_PRESET_CACHE = Object.fromEntries(
  CHARACTER_LANGUAGES.map((language) => [
    language,
    CHARACTER_DEFINITIONS.map((definition) =>
      resolveCharacterVariant(definition, language),
    ),
  ]),
) as Record<CharacterLanguage, StylePreset[]>;

const CHARACTER_DEFINITION_BY_ID = new Map(
  CHARACTER_DEFINITIONS.map((definition) => [
    definition.id.toLowerCase(),
    definition,
  ]),
);

const CHARACTER_DEFINITION_BY_NAME = new Map(
  CHARACTER_DEFINITIONS.map((definition) => [
    definition.name.toLowerCase(),
    definition,
  ]),
);

const CHARACTER_DEFINITION_BY_AVATAR_INDEX = new Map(
  CHARACTER_DEFINITIONS.map((definition) => [
    definition.avatarIndex,
    definition,
  ]),
);

export function getStylePresets(
  language: unknown = DEFAULT_LANGUAGE,
): StylePreset[] {
  return STYLE_PRESET_CACHE[normalizeCharacterLanguage(language)];
}

export const STYLE_PRESETS: StylePreset[] =
  STYLE_PRESET_CACHE[DEFAULT_LANGUAGE];

export function getDefaultStylePreset(
  language: unknown = DEFAULT_LANGUAGE,
): StylePreset {
  const preset = getStylePresets(language)[0];
  if (!preset) {
    throw new Error("No style presets are configured.");
  }
  return preset;
}

export function resolveStylePresetById(
  id: string | null | undefined,
  language: unknown = DEFAULT_LANGUAGE,
): StylePreset | undefined {
  if (!id) {
    return undefined;
  }
  const normalized = normalizeCharacterLanguage(language);
  const definition = CHARACTER_DEFINITION_BY_ID.get(id.toLowerCase());
  return definition
    ? resolveCharacterVariant(definition, normalized)
    : undefined;
}

export function resolveStylePresetByName(
  name: string | null | undefined,
  language: unknown = DEFAULT_LANGUAGE,
): StylePreset | undefined {
  if (!name) {
    return undefined;
  }
  const normalized = normalizeCharacterLanguage(language);
  const definition = CHARACTER_DEFINITION_BY_NAME.get(name.toLowerCase());
  return definition
    ? resolveCharacterVariant(definition, normalized)
    : undefined;
}

export function resolveStylePresetByAvatarIndex(
  avatarIndex: number | null | undefined,
  language: unknown = DEFAULT_LANGUAGE,
): StylePreset | undefined {
  if (typeof avatarIndex !== "number" || !Number.isFinite(avatarIndex)) {
    return undefined;
  }
  const normalized = normalizeCharacterLanguage(language);
  const definition = CHARACTER_DEFINITION_BY_AVATAR_INDEX.get(avatarIndex);
  return definition
    ? resolveCharacterVariant(definition, normalized)
    : undefined;
}

export const CHARACTER_PRESETS = STYLE_PRESETS.map((preset) => ({
  id: preset.id,
  name: preset.name,
  catchphrase: preset.catchphrase,
  description: preset.hint,
  style: preset.id,
}));

export const CHARACTER_PRESET_META: Record<
  string,
  {
    id: string;
    name: string;
    avatarIndex: number;
    voicePresetId?: string;
    catchphrase: string;
  }
> = Object.fromEntries(
  STYLE_PRESETS.map((preset) => [
    preset.catchphrase,
    {
      id: preset.id,
      name: preset.name,
      avatarIndex: preset.avatarIndex,
      voicePresetId: preset.voicePresetId,
      catchphrase: preset.catchphrase,
    },
  ]),
);

export function getPresetNameMap(
  language: unknown = DEFAULT_LANGUAGE,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const preset of getStylePresets(language)) {
    result[preset.name] = preset.catchphrase;
  }
  return result;
}

export function buildElizaCharacterCatalog(): {
  assets: Array<{
    id: number;
    slug: string;
    title: string;
    sourceName: string;
  }>;
  injectedCharacters: Array<{
    catchphrase: string;
    name: string;
    avatarAssetId: number;
    voicePresetId?: string;
  }>;
} {
  const assets = STYLE_PRESETS.slice()
    .sort((left, right) => left.avatarIndex - right.avatarIndex)
    .map((preset) => ({
      id: preset.avatarIndex,
      slug: `eliza-${preset.avatarIndex}`,
      title: preset.name,
      sourceName: preset.name,
    }));

  const injectedCharacters = STYLE_PRESETS.map((preset) => ({
    catchphrase: preset.catchphrase,
    name: preset.name,
    avatarAssetId: preset.avatarIndex,
    voicePresetId: preset.voicePresetId,
  }));

  return { assets, injectedCharacters };
}
