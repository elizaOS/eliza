/** Applies app display-name normalization to the canonical agent character. */
import { buildCharacterFromConfig as upstreamBuildCharacterFromConfig } from "@elizaos/agent";
import { normalizeCharacterMessageExamples } from "@elizaos/core/protocol";

export function buildCharacterFromConfig(
  ...args: Parameters<typeof upstreamBuildCharacterFromConfig>
): ReturnType<typeof upstreamBuildCharacterFromConfig> {
  const character = upstreamBuildCharacterFromConfig(...args);
  if ((character.messageExamples?.length ?? 0) > 0) {
    character.messageExamples = normalizeCharacterMessageExamples(
      character.messageExamples,
      character.name,
    );
  }
  return character;
}
