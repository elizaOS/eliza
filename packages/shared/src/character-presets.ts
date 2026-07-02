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

// avatarIndex is a VRM art-asset index, not a unique persona key — multiple
// personas can share one art asset (the default Eliza and Chen both render
// asset 1). Build this lookup first-wins so an ambiguous index resolves
// deterministically to the earliest-declared persona (the default preset is
// CHARACTER_DEFINITIONS[0]) instead of the Map constructor's last-wins
// semantics letting a later persona silently clobber it.
const CHARACTER_DEFINITION_BY_AVATAR_INDEX = new Map<
  number,
  CharacterDefinition
>();
for (const definition of CHARACTER_DEFINITIONS) {
  if (!CHARACTER_DEFINITION_BY_AVATAR_INDEX.has(definition.avatarIndex)) {
    CHARACTER_DEFINITION_BY_AVATAR_INDEX.set(
      definition.avatarIndex,
      definition,
    );
  }
}

// The first/default character ("eliza") is the app's default agent. A
// white-label app rebrands that default to its own app name (e.g. "Milady")
// via setDefaultAgentName(), set once at boot from app.config.ts. Only the
// default preset is renamed — the other named personas (Chen, Jin, …) keep
// their identities. The character bio/system use {{name}}, so the rename
// cascades when the character is built. A null/empty/"Eliza" override is a
// no-op, so the canonical Eliza app is unaffected.
const DEFAULT_PRESET_ID = "eliza";
let DEFAULT_AGENT_NAME_OVERRIDE: string | null = null;

export function setDefaultAgentName(name: string | null | undefined): void {
  const trimmed = typeof name === "string" ? name.trim() : "";
  DEFAULT_AGENT_NAME_OVERRIDE =
    trimmed && trimmed.toLowerCase() !== "eliza" ? trimmed : null;
}

export function getDefaultAgentName(): string {
  return DEFAULT_AGENT_NAME_OVERRIDE ?? "Eliza";
}

function applyDefaultAgentName(preset: StylePreset): StylePreset {
  if (!DEFAULT_AGENT_NAME_OVERRIDE || preset.id !== DEFAULT_PRESET_ID) {
    return preset;
  }
  return { ...preset, name: DEFAULT_AGENT_NAME_OVERRIDE };
}

export function getStylePresets(
  language: unknown = DEFAULT_LANGUAGE,
): StylePreset[] {
  const presets = STYLE_PRESET_CACHE[normalizeCharacterLanguage(language)];
  return DEFAULT_AGENT_NAME_OVERRIDE
    ? presets.map((preset) => applyDefaultAgentName(preset))
    : presets;
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
    ? applyDefaultAgentName(resolveCharacterVariant(definition, normalized))
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
  // The rebranded default agent ("Milady") is the "eliza" preset renamed, so a
  // lookup by the override name must resolve to it (the by-name map only knows
  // the original "eliza" key).
  const lookupName =
    DEFAULT_AGENT_NAME_OVERRIDE &&
    name.toLowerCase() === DEFAULT_AGENT_NAME_OVERRIDE.toLowerCase()
      ? DEFAULT_PRESET_ID
      : name.toLowerCase();
  const definition = CHARACTER_DEFINITION_BY_NAME.get(lookupName);
  return definition
    ? applyDefaultAgentName(resolveCharacterVariant(definition, normalized))
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
    ? applyDefaultAgentName(resolveCharacterVariant(definition, normalized))
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
  // Use getStylePresets() (not the STYLE_PRESETS const) so the default-agent
  // rename from setDefaultAgentName() is reflected in the white-label catalog.
  const presets = getStylePresets(DEFAULT_LANGUAGE);
  // Assets are keyed by avatarIndex (the VRM art asset), which multiple
  // personas can share — dedupe first-wins so the shared asset is titled after
  // the earliest-declared persona instead of emitting duplicate asset ids.
  const assetsByAvatarIndex = new Map<
    number,
    { id: number; slug: string; title: string; sourceName: string }
  >();
  for (const preset of presets) {
    if (!assetsByAvatarIndex.has(preset.avatarIndex)) {
      assetsByAvatarIndex.set(preset.avatarIndex, {
        id: preset.avatarIndex,
        slug: `eliza-${preset.avatarIndex}`,
        title: preset.name,
        sourceName: preset.name,
      });
    }
  }
  const assets = [...assetsByAvatarIndex.values()].sort(
    (left, right) => left.id - right.id,
  );

  const injectedCharacters = presets.map((preset) => ({
    catchphrase: preset.catchphrase,
    name: preset.name,
    avatarAssetId: preset.avatarIndex,
    voicePresetId: preset.voicePresetId,
  }));

  return { assets, injectedCharacters };
}
