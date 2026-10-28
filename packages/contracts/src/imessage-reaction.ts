/** Add-only current-message reactions. Provider operation prefixes are not user choices. */
export const IMESSAGE_CLASSIC_REACTIONS = [
  "love",
  "like",
  "dislike",
  "laugh",
  "emphasize",
  "question",
] as const;

// Unicode's complete RGI sequences include flags, modifiers, ZWJ and keycaps.
// Also admit a standalone text-default emoji (e.g. ❤), but not components/digits.
// Keep the runtime's Unicode v semantics without requiring every transitive
// TypeScript consumer to emit ES2024 regular-expression literal syntax.
// biome-ignore lint/complexity/useRegexLiterals: A v-flag literal fails ES2022 consumers; the supported runtime still evaluates identical Unicode sets.
const emoji = new RegExp(
  "^(?:\\p{RGI_Emoji}|[\\p{Emoji}--\\p{Emoji_Component}])$",
  "v",
);
const grapheme = new Intl.Segmenter("und", { granularity: "grapheme" });

export function parseImessageReaction(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || /\p{Cc}/u.test(value))
    return undefined;
  if ((IMESSAGE_CLASSIC_REACTIONS as readonly string[]).includes(value))
    return value;
  if (/^\p{Emoji_Component}$/u.test(value)) return undefined;
  if (!emoji.test(value) || [...grapheme.segment(value)].length !== 1)
    return undefined;
  return value;
}
