/**
 * App-core wrapper around `@elizaos/agent`'s `buildCharacterFromConfig` that
 * layers dashboard branding onto the built character. Normalizes message
 * examples and fills style, adjectives, topics, and post/message examples from
 * the matched bundled style preset (resolved by preset id, avatar index, then
 * name) — but only where both the agent-list entry and the built character
 * leave them unset, so explicit config always wins.
 */
import { buildCharacterFromConfig as upstreamBuildCharacterFromConfig } from "@elizaos/agent";
import {
  getDefaultStylePreset,
  normalizeCharacterLanguage,
  normalizeCharacterMessageExamples,
  resolveStylePresetByAvatarIndex,
  resolveStylePresetById,
  resolveStylePresetByName,
} from "@elizaos/shared";

function resolveAppPreset(
  config: Parameters<typeof upstreamBuildCharacterFromConfig>[0],
  name: string | undefined,
) {
  const uiConfig = (config.ui ?? {}) as {
    presetId?: string;
    avatarIndex?: number;
    language?: unknown;
  };
  const language = normalizeCharacterLanguage(uiConfig.language);
  const matchedPreset =
    (typeof uiConfig.presetId === "string" && uiConfig.presetId
      ? resolveStylePresetById(uiConfig.presetId, language)
      : undefined) ??
    resolveStylePresetByAvatarIndex(uiConfig.avatarIndex, language) ??
    resolveStylePresetByName(name, language);
  if (matchedPreset) {
    return matchedPreset;
  }
  return name ? undefined : getDefaultStylePreset(language);
}

export function buildCharacterFromConfig(
  ...args: Parameters<typeof upstreamBuildCharacterFromConfig>
): ReturnType<typeof upstreamBuildCharacterFromConfig> {
  const [config] = args;
  const character = upstreamBuildCharacterFromConfig(...args);

  const agentEntry = config.agents?.list?.[0];
  const bundledPreset = resolveAppPreset(config, character.name);
  if ((character.messageExamples?.length ?? 0) > 0) {
    character.messageExamples = normalizeCharacterMessageExamples(
      character.messageExamples,
      character.name,
    );
  }
  if (bundledPreset) {
    if (!agentEntry?.style && !character.style && bundledPreset.style) {
      character.style = {
        all: [...bundledPreset.style.all],
        chat: [...bundledPreset.style.chat],
        post: [...bundledPreset.style.post],
      } as NonNullable<(typeof character)["style"]>;
    }
    if (
      !agentEntry?.adjectives &&
      (!character.adjectives || character.adjectives.length === 0) &&
      bundledPreset.adjectives.length > 0
    ) {
      character.adjectives = [...bundledPreset.adjectives];
    }
    if (
      !agentEntry?.topics &&
      (!Array.isArray(character.topics) || character.topics.length === 0) &&
      Array.isArray(bundledPreset.topics) &&
      bundledPreset.topics.length > 0
    ) {
      character.topics = [...bundledPreset.topics];
    }
    if (
      !agentEntry?.postExamples &&
      (character.postExamples?.length ?? 0) === 0
    ) {
      character.postExamples = [...bundledPreset.postExamples];
    }
    if (
      !agentEntry?.messageExamples &&
      (character.messageExamples?.length ?? 0) === 0
    ) {
      character.messageExamples = normalizeCharacterMessageExamples(
        bundledPreset.messageExamples,
        character.name,
      );
    }
  }

  return character;
}
