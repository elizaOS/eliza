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
  return input
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
    // error-policy:J3 input is not a JSON object
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

/**
 * Scans markdown text for fenced code blocks (both backtick and tilde fences)
 * according to CommonMark rules:
 * 1. An opening fence begins at a line start with 0 or more spaces of indentation,
 *    followed by 3 or more backticks (`) or tildes (~).
 * 2. Leading line indentation is included in the preserved block so that
 *    list-nested code blocks (e.g. 4 spaces) retain their indentation symmetrically.
 * 3. The closing fence must match the opening delimiter character and have at
 *    least as many delimiter characters as the opening fence (e.g. a 4-backtick
 *    block can contain 3-backtick blocks and only closes on 4 or more backticks).
 * 4. Unterminated / streaming code blocks extend to the end of the input.
 */
function normalizeProse(prose: string): string {
  let normalized = prose;
  normalized = stripWrappedStageDirections(normalized, /\*([^*\n]+)\*/g);
  normalized = stripWrappedStageDirections(normalized, /_([^_\n]+)_/g);
  // Ordinary replies may contain exact quotes or intentional spacing. Only
  // tidy spacing introduced when a stage direction was actually removed.
  return normalized === prose ? prose : tidyAssistantTextSpacing(normalized);
}

/**
 * Scans markdown text for fenced code blocks (both backtick and tilde fences)
 * according to CommonMark rules:
 * 1. An opening fence begins at a line start with 0 or more spaces of indentation,
 *    followed by 3 or more backticks (`) or tildes (~).
 * 2. Leading line indentation is included in the preserved block so that
 *    list-nested code blocks (e.g. 4 spaces) retain their indentation symmetrically.
 * 3. The closing fence must match the opening delimiter character and have at
 *    least as many delimiter characters as the opening fence (e.g. a 4-backtick
 *    block can contain 3-backtick blocks and only closes on 4 or more backticks).
 * 4. Unterminated / streaming code blocks extend to the end of the input.
 *
 * Normalizes stage directions and spacing exclusively in prose segments while
 * preserving code blocks byte-for-byte without placeholders or sentinel tokens.
 */
export function stripAssistantStageDirections(input: string): string {
  if (typeof input !== "string") return "";

  const len = input.length;
  let out = "";
  let lastIdx = 0;
  let idx = 0;

  while (idx < len) {
    const lineStart = idx;
    let pos = idx;

    // Capture leading whitespace on the line
    while (pos < len && (input[pos] === " " || input[pos] === "\t")) {
      pos++;
    }

    if (pos < len && (input[pos] === "`" || input[pos] === "~")) {
      const fenceChar = input[pos];
      let fenceCount = 0;
      while (pos < len && input[pos] === fenceChar) {
        fenceCount++;
        pos++;
      }

      if (fenceCount >= 3) {
        // Valid opening fence. Read the rest of the opening line.
        while (pos < len && input[pos] !== "\n") {
          pos++;
        }
        if (pos < len && input[pos] === "\n") {
          pos++;
        }

        // Scan for closing fence of matching delimiter with length >= fenceCount
        let blockClosed = false;
        let blockEnd = pos;

        while (pos < len) {
          let closePos = pos;
          while (
            closePos < len &&
            (input[closePos] === " " || input[closePos] === "\t")
          ) {
            closePos++;
          }

          if (closePos < len && input[closePos] === fenceChar) {
            let closeCount = 0;
            while (closePos < len && input[closePos] === fenceChar) {
              closeCount++;
              closePos++;
            }

            if (closeCount >= fenceCount) {
              // Closing fence line allows only optional whitespace until line end
              let afterFence = closePos;
              while (
                afterFence < len &&
                (input[afterFence] === " " ||
                  input[afterFence] === "\t" ||
                  input[afterFence] === "\r")
              ) {
                afterFence++;
              }
              if (afterFence >= len || input[afterFence] === "\n") {
                blockClosed = true;
                blockEnd = afterFence;
                break;
              }
            }
          }

          // Advance to next line
          while (pos < len && input[pos] !== "\n") {
            pos++;
          }
          if (pos < len && input[pos] === "\n") {
            pos++;
          }
          blockEnd = pos;
        }

        if (!blockClosed) {
          blockEnd = len;
        }

        // Normalize prose segment preceding this code block
        if (lineStart > lastIdx) {
          out += normalizeProse(input.slice(lastIdx, lineStart));
        }

        // Preserve code block byte-for-byte without placeholders or sentinels
        out += input.slice(lineStart, blockEnd);

        lastIdx = blockEnd;
        idx = blockEnd;
        continue;
      }
    }

    // Move to next line
    while (idx < len && input[idx] !== "\n") {
      idx++;
    }
    if (idx < len && input[idx] === "\n") {
      idx++;
    }
  }

  // Normalize remaining prose segment
  if (lastIdx < len) {
    out += normalizeProse(input.slice(lastIdx));
  }

  return out;
}
