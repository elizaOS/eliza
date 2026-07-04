/**
 * Cleans assistant text for display by detecting and stripping roleplay stage
 * directions (`*beams*`, `*blushes*`, …). The leading-word set gates which
 * asterisk-wrapped spans are treated as stage directions rather than emphasis.
 */
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

function collapseInlineWhitespace(input: string): string {
  return input.replace(/[ \t]+/g, " ").trim();
}

function looksLikeStageDirection(input: string): boolean {
  const normalized = collapseInlineWhitespace(input).trim();
  if (!normalized || normalized.length > 100) return false;

  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ASCII-range check to reject non-ASCII input
  if (/[^\x00-\x7F]/.test(normalized)) {
    return false;
  }

  const wordMatch = normalized.match(/^[^\w]*([A-Za-z]+)/);
  if (!wordMatch) return false;

  const firstWord = wordMatch[1].toLowerCase();
  return STAGE_DIRECTION_FIRST_WORDS.has(firstWord);
}

function stripWrappedStageDirections(input: string, pattern: RegExp): string {
  return input.replace(
    pattern,
    (match: string, inner: string, offset: number, source: string) => {
      const prev = source[offset - 1] ?? "";
      const next = source[offset + match.length] ?? "";
      const hasSafeLeftBoundary =
        offset === 0 || /[\s([{>"'“‘.!?,;:-]/.test(prev);
      const hasSafeRightBoundary =
        offset + match.length >= source.length ||
        /[\s)\]}<"'”’.!?,;:-]/.test(next);
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
  const safe = input.length > 200_000 ? input.slice(0, 200_000) : input;
  return safe
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ ?([,.;!?])/g, "$1")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")");
}

function tryParseObject(input: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(input);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function isResponseHandlerPayload(
  value: Record<string, unknown>,
): value is Record<string, unknown> & { replyText: string } {
  const shouldRespond = value.shouldRespond;
  return (
    typeof value.replyText === "string" &&
    (shouldRespond === "RESPOND" ||
      shouldRespond === "IGNORE" ||
      shouldRespond === "STOP" ||
      Array.isArray(value.contexts) ||
      Array.isArray(value.intents) ||
      Array.isArray(value.threadOps) ||
      Array.isArray(value.candidateActionNames))
  );
}

// Structural keys an elizaOS reply object may legitimately carry alongside the
// user-facing `reply`. When a parsed object's keys are ALL within this set and
// it has a string `reply`, the model emitted its whole response object as text
// (e.g. `{"reply":"107"}` or `{"reply":"…","action":"NONE"}`) — unwrap it. The
// allow-list keeps us from stripping real chat content that merely happens to be
// JSON with a `reply` field plus unrelated data.
const REPLY_PAYLOAD_KEYS = new Set([
  "reply",
  "response",
  "text",
  "message",
  "thought",
  "action",
  "actions",
  "simple",
  "providers",
  "evaluators",
  "inReplyTo",
  "attachments",
]);

// The model wraps its answer under `reply` or `response` (the key drifts by
// model/image — both observed on cloud agents). Return the primitive value from
// whichever is present, but only when EVERY key is a known response-shape key,
// so ordinary chat text that merely contains JSON is never rewritten. Allows a
// primitive value (`{"reply":42}` / `{"response":true}`), not just strings;
// objects/arrays aren't user-facing text and are rejected.
const PRIMARY_REPLY_KEYS = ["reply", "response"] as const;

function getSimpleReplyValue(value: Record<string, unknown>): string | null {
  let found: string | number | boolean | undefined;
  for (const key of PRIMARY_REPLY_KEYS) {
    const candidate = value[key];
    if (
      typeof candidate === "string" ||
      typeof candidate === "number" ||
      typeof candidate === "boolean"
    ) {
      found = candidate;
      break;
    }
  }
  if (found === undefined) return null;
  for (const key of Object.keys(value)) {
    if (!REPLY_PAYLOAD_KEYS.has(key)) return null;
  }
  return String(found);
}

/**
 * Extracts the user-facing reply from a response-handler payload that leaked as
 * plain text. Local models can emit tool arguments as text when function-call
 * transport is unavailable, for example:
 *
 *   "RESPOND", "contexts": ["simple"], "replyText": "Hello"
 *
 * That string is valid object content once the first value is named
 * `shouldRespond`, so parse that shape without touching ordinary chat text.
 */
export function extractAssistantReplyText(input: string): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();

  // Shape 1: a leaked response-handler payload keyed by `replyText` — either the
  // full object or a bare argument fragment (`"RESPOND", "replyText": "Hi"`).
  if (trimmed.includes("replyText")) {
    const candidates = [trimmed];
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
      candidates.push(`{"shouldRespond":${trimmed}}`);
      if (trimmed.endsWith("}")) {
        candidates.push(`{"shouldRespond":${trimmed.slice(0, -1)}}`);
      }
    }

    for (const candidate of candidates) {
      const parsed = tryParseObject(candidate);
      if (!parsed || !isResponseHandlerPayload(parsed)) continue;
      const replyText = parsed.replyText.trim();
      if (!replyText) return null;
      return stripAssistantStageDirections(replyText).trim() || null;
    }
  }

  // Shape 2: the model emitted its whole reply object as text, e.g.
  // `{"reply":"107"}`, `{"response":"54"}`, or `{"reply":"…","action":"NONE"}`
  // (observed from gpt-oss/glm on cloud agents; the wrapper key drifts between
  // `reply` and `response`). Only unwrap a well-formed object whose keys are all
  // known response-shape keys, so ordinary chat text that merely contains JSON
  // is never rewritten.
  if (
    trimmed.startsWith("{") &&
    trimmed.endsWith("}") &&
    (trimmed.includes('"reply"') || trimmed.includes('"response"'))
  ) {
    const parsed = tryParseObject(trimmed);
    const reply = parsed ? getSimpleReplyValue(parsed) : null;
    if (reply !== null) {
      const trimmedReply = reply.trim();
      if (!trimmedReply) return null;
      return stripAssistantStageDirections(trimmedReply).trim() || null;
    }
  }

  return null;
}

export function stripAssistantStageDirections(input: string): string {
  if (typeof input !== "string") return "";
  let normalized = input;
  normalized = stripWrappedStageDirections(normalized, /\*([^*\n]+)\*/g);
  normalized = stripWrappedStageDirections(normalized, /_([^_\n]+)_/g);
  return tidyAssistantTextSpacing(normalized);
}
