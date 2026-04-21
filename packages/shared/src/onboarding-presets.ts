import {
  CHARACTER_LANGUAGES,
  type CharacterLanguage,
  type StylePreset,
} from "./contracts/onboarding.js";
import {
  CHARACTER_DEFINITIONS,
  type CharacterDefinition,
} from "./onboarding-presets.characters.js";
import { SHARED_STYLE_RULES } from "./onboarding-presets.shared.js";

export { SHARED_STYLE_RULES };

const DEFAULT_LANGUAGE: CharacterLanguage = "en";

const LANGUAGE_REPLY_RULES: Record<CharacterLanguage, string> = {
  en: "Default to natural English unless the user clearly switches languages.",
  "zh-CN":
    "Default to natural simplified Chinese unless the user clearly switches languages.",
  ko: "Default to natural Korean unless the user clearly switches languages.",
  es: "Default to natural Spanish unless the user clearly switches languages.",
  pt: "Default to natural Brazilian Portuguese unless the user clearly switches languages.",
  vi: "Default to natural Vietnamese unless the user clearly switches languages.",
  tl: "Default to natural Tagalog unless the user clearly switches languages.",
};

function addLanguageRule(system: string, language: CharacterLanguage): string {
  const rule = LANGUAGE_REPLY_RULES[language];
  return `${system} ${rule}`;
}

export function normalizeCharacterLanguage(input: unknown): CharacterLanguage {
  if (typeof input !== "string") {
    return DEFAULT_LANGUAGE;
  }

  const trimmed = input.trim();
  if (!trimmed) {
    return DEFAULT_LANGUAGE;
  }

  if ((CHARACTER_LANGUAGES as readonly string[]).includes(trimmed as string)) {
    return trimmed as CharacterLanguage;
  }

  const lower = trimmed.toLowerCase();
  if (lower === "zh" || lower === "zh-cn" || lower.startsWith("zh-hans")) {
    return "zh-CN";
  }
  if (lower.startsWith("ko")) {
    return "ko";
  }
  if (lower.startsWith("es")) {
    return "es";
  }
  if (lower.startsWith("pt")) {
    return "pt";
  }
  if (lower.startsWith("vi")) {
    return "vi";
  }
  if (lower.startsWith("tl") || lower.startsWith("fil")) {
    return "tl";
  }
  return DEFAULT_LANGUAGE;
}

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
