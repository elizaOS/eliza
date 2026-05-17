/**
 * Chat text normalization helpers.
 *
 * Shared between server.ts and chat-routes.ts. Extracted to avoid
 * duplication when both modules need stage-direction stripping and
 * no-response detection.
 */

// ---------------------------------------------------------------------------
// Stage-direction vocabulary
// ---------------------------------------------------------------------------

const STAGE_DIRECTION_FIRST_WORDS = new Set([
  "beam",
  "beams",
  "beaming",
  "blink",
  "blinks",
  "blinking",
  "blush",
  "blushes",
  "blushing",
  "bow",
  "bows",
  "bowing",
  "breathe",
  "breathes",
  "breathing",
  "cheer",
  "cheers",
  "cheering",
  "chuckle",
  "chuckles",
  "chuckling",
  "clap",
  "claps",
  "clapping",
  "cry",
  "cries",
  "crying",
  "curtsy",
  "curtsies",
  "curtsying",
  "dance",
  "dances",
  "dancing",
  "frown",
  "frowns",
  "frowning",
  "gasp",
  "gasps",
  "gasping",
  "gesture",
  "gestures",
  "gesturing",
  "giggle",
  "giggles",
  "giggling",
  "glance",
  "glances",
  "glancing",
  "grin",
  "grins",
  "grinning",
  "laugh",
  "laughs",
  "laughing",
  "lean",
  "leans",
  "leaning",
  "look",
  "looks",
  "looking",
  "nod",
  "nods",
  "nodding",
  "pause",
  "pauses",
  "pausing",
  "point",
  "points",
  "pointing",
  "pose",
  "poses",
  "posing",
  "pout",
  "pouts",
  "pouting",
  "raise",
  "raises",
  "raising",
  "shrug",
  "shrugs",
  "shrugging",
  "sigh",
  "sighs",
  "sighing",
  "smile",
  "smiles",
  "smiling",
  "smirk",
  "smirks",
  "smirking",
  "spin",
  "spins",
  "spinning",
  "stare",
  "stares",
  "staring",
  "stretch",
  "stretches",
  "stretching",
  "sway",
  "sways",
  "swaying",
  "tilt",
  "tilts",
  "tilting",
  "wave",
  "waves",
  "waving",
  "whisper",
  "whispers",
  "whispering",
  "wink",
  "winks",
  "winking",
  "yawn",
  "yawns",
  "yawning",
]);

// ---------------------------------------------------------------------------
// Exported helpers
// ---------------------------------------------------------------------------

export function isNoResponsePlaceholder(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length === 0 || /^\(?no response\)?$/i.test(trimmed);
}

function collapseInlineWhitespace(input: string): string {
  return input.replace(/[ \t]+/g, " ").trim();
}

function looksLikeStageDirection(input: string): boolean {
  const normalized = collapseInlineWhitespace(input)
    .replace(/^[^A-Za-z]+/, "")
    .replace(/[^A-Za-z'-]+$/, "");
  if (!normalized) return false;
  const [firstWord = ""] = normalized.toLowerCase().split(/\s+/, 1);
  return STAGE_DIRECTION_FIRST_WORDS.has(firstWord);
}

function stripWrappedStageDirections(input: string, pattern: RegExp): string {
  return input.replace(
    pattern,
    (match: string, inner: string, offset: number, source: string) => {
      const prev = source[offset - 1] ?? "";
      const next = source[offset + match.length] ?? "";
      const hasSafeLeftBoundary =
        offset === 0 || /[\s([{>"'"'.!?,;:-]/.test(prev);
      const hasSafeRightBoundary =
        offset + match.length >= source.length ||
        /[\s)\]}<"'"'.!?,;:-]/.test(next);
      if (
        !hasSafeLeftBoundary ||
        !hasSafeRightBoundary ||
        !looksLikeStageDirection(inner)
      ) {
        return match;
      }
      return " ";
    },
  );
}

function tidyAssistantTextSpacing(input: string): string {
  const safe = input.length > 100_000 ? input.slice(0, 100_000) : input;
  return safe
    .replace(/[ \t]{1,1024}\n/g, "\n")
    .replace(/\n[ \t]{1,1024}/g, "\n")
    .replace(/[ \t]{2,1024}/g, " ")
    .replace(/ ?([,.;!?])/g, "$1")
    .replace(/\(\s{1,1024}/g, "(")
    .replace(/\s{1,1024}\)/g, ")");
}

export function stripAssistantStageDirections(input: string): string {
  let normalized = input;
  normalized = stripWrappedStageDirections(normalized, /\*([^*\n]+)\*/g);
  normalized = stripWrappedStageDirections(normalized, /_([^_\n]+)_/g);
  return tidyAssistantTextSpacing(normalized);
}

export function isClientVisibleNoResponse(text: string): boolean {
  if (isNoResponsePlaceholder(text)) return true;
  return isNoResponsePlaceholder(stripAssistantStageDirections(text));
}
