/**
 * Resolves the greeting-animation asset path for a character: an explicit
 * override wins, otherwise it falls back to the greetingAnimation of the style
 * preset matching the character's avatar index. Paths are normalized to be
 * root-relative (leading slashes stripped) so callers can join them uniformly.
 */
import { getStylePresets } from "@elizaos/shared";

function normalizeGreetingAnimationPath(path: string | null | undefined) {
  const trimmed = path?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.replace(/^\/+/, "");
}

export function resolveCharacterGreetingAnimation(args: {
  avatarIndex?: number | null;
  greetingAnimation?: string | null;
}): string | null {
  const explicitPath = normalizeGreetingAnimationPath(args.greetingAnimation);
  if (explicitPath) {
    return explicitPath;
  }
  const avatarIndex =
    typeof args.avatarIndex === "number" && args.avatarIndex > 0
      ? args.avatarIndex
      : null;
  if (!avatarIndex) {
    return null;
  }
  const preset = getStylePresets("en").find(
    (candidate) => candidate.avatarIndex === avatarIndex,
  );
  return normalizeGreetingAnimationPath(preset?.greetingAnimation);
}
