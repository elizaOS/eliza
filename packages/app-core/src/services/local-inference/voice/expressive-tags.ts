/**
 * Expressive (emotion / singing) inline-tag handling for the voice path.
 *
 * The canonical schema is the **omnivoice-singing inline-tag vocabulary,
 * verbatim** (no SSML, no new format — it is exactly what the fine-tuned
 * `omnivoice-singing` GGUF understands when the tags appear inline in the
 * text passed to `eliza_inference_tts_synthesize` / `/v1/audio/speech`):
 *
 *   emotion tags     [happy] [sad] [angry] [nervous] [calm] [excited] [whisper]
 *   singing tag      [singing]
 *   preserved        [laughter] [sigh]   (non-verbals — passed through, not
 *                                          consumed as a scope-setting tag)
 *
 * Tags are *inline* and *scoped*: a tag applies from where it appears to the
 * next tag (or end of text). Mid-sentence shifts are allowed
 * (`"that's [excited] amazing"`). `parseExpressiveTags` segments the text by
 * tag boundaries so the chunker / TTS backend can carry the in-scope emotion
 * with each phrase.
 *
 * Two consumers:
 *   - the *singing* TTS GGUF: it parses the tags itself, so the bridge passes
 *     the tag-bearing text through (`segment.text` keeps `[happy]` etc. — see
 *     `makeTextToSpeechHandler`, which deliberately does NOT strip them).
 *   - a *base* TTS GGUF (no `emotion-tags` / `singing` capability): the tags
 *     would otherwise be spoken literally, so `stripExpressiveTags` removes
 *     them before synthesis. (The model shouldn't have emitted them when the
 *     bundle lacks the capability — but defense in depth.)
 *
 * Coordinates with:
 *   - `manifest/schema.ts` → `ELIZA_1_VOICE_CAPABILITIES` (`emotion-tags` /
 *     `singing` gate whether the prompt instructs the model to emit tags).
 *   - WS-4's Stage-1 envelope `emotion` enum field (one-line field-evaluator
 *     registration there) — `EXPRESSIVE_EMOTION_ENUM` is the shared value set.
 *   - WS-3's `voice_emotion` fine-tune corpus task — both forms (inline tags +
 *     the `emotion` field) are populated on voice-mode rows.
 */

// ---------------------------------------------------------------------------
// The tag vocabulary
// ---------------------------------------------------------------------------

/** Emotion tags that set the affect scope for the text that follows. */
export const EXPRESSIVE_EMOTION_TAGS = [
  "happy",
  "sad",
  "angry",
  "nervous",
  "calm",
  "excited",
  "whisper",
] as const;

export type ExpressiveEmotion = (typeof EXPRESSIVE_EMOTION_TAGS)[number];

/**
 * The Stage-1 envelope `emotion` enum value set (decision #2 in
 * `.swarm/IMPLEMENTATION_PLAN.md` §1 — the optional field-evaluator WS-4 wires
 * registers exactly this enum). `none` is the default / "no expressive cue"
 * value so the field is always present and structured-decode can singleton-fill
 * it. `whisper` is included because it travels the same inline-tag channel even
 * though it is a delivery style rather than an affect.
 */
export const EXPRESSIVE_EMOTION_ENUM = [
  "none",
  ...EXPRESSIVE_EMOTION_TAGS,
] as const;

export type ExpressiveEmotionEnum = (typeof EXPRESSIVE_EMOTION_ENUM)[number];

/** The singing tag — a style flag, not an affect; orthogonal to emotion. */
export const EXPRESSIVE_SINGING_TAG = "singing" as const;

/**
 * Preserved non-verbals — these are *rendered* as sound effects by the TTS,
 * not consumed as scope-setting tags. They pass straight through the bridge.
 */
export const EXPRESSIVE_NONVERBAL_TAGS = ["laughter", "sigh"] as const;

export type ExpressiveNonverbal = (typeof EXPRESSIVE_NONVERBAL_TAGS)[number];

/**
 * The full inline-tag vocabulary (emotion + singing + preserved non-verbals),
 * verbatim — the union the `omnivoice-singing` GGUF understands. Use this for
 * the prompt clause and the `tagLeakage` check.
 */
export const EXPRESSIVE_TAGS = [
  ...EXPRESSIVE_EMOTION_TAGS,
  EXPRESSIVE_SINGING_TAG,
  ...EXPRESSIVE_NONVERBAL_TAGS,
] as const;

export type ExpressiveTag = (typeof EXPRESSIVE_TAGS)[number];

const EMOTION_SET: ReadonlySet<string> = new Set(EXPRESSIVE_EMOTION_TAGS);
const NONVERBAL_SET: ReadonlySet<string> = new Set(EXPRESSIVE_NONVERBAL_TAGS);
const ALL_TAG_SET: ReadonlySet<string> = new Set(EXPRESSIVE_TAGS);

/** `true` iff `tag` (without brackets, case-insensitive) is a legal expressive tag. */
export function isExpressiveTag(tag: string): tag is ExpressiveTag {
  return ALL_TAG_SET.has(tag.trim().toLowerCase());
}

/** `true` iff `value` is a legal `emotion` enum value (incl. `"none"`). */
export function isExpressiveEmotionEnum(
  value: string,
): value is ExpressiveEmotionEnum {
  return value === "none" || EMOTION_SET.has(value);
}

// Match `[tag]` with optional surrounding whitespace inside the brackets.
// Anchored to the bracket characters; the inner text is captured for lookup.
// **A fresh regex per call** — a global regex carries `lastIndex` state, and
// `parseExpressiveTags` calls `String.prototype.replace` (which resets a
// shared regex's `lastIndex` to 0) from inside its own `exec` loop on the same
// pattern; sharing one object there is an infinite loop. `tagRegex()` hands
// out independent instances.
const TAG_RE_SOURCE = "\\[\\s*([a-zA-Z][a-zA-Z-]*)\\s*\\]";
function tagRegex(): RegExp {
  return new RegExp(TAG_RE_SOURCE, "g");
}

// ---------------------------------------------------------------------------
// parseExpressiveTags
// ---------------------------------------------------------------------------

/** One scoped segment of an expressive `replyText`. */
export interface ExpressiveSegment {
  /**
   * The segment text. For the singing-GGUF path this *keeps* the leading
   * scope-setting emotion/singing tag and any inline non-verbals (the GGUF
   * parses them); for a base-TTS path use `cleanText` / `stripExpressiveTags`.
   */
  text: string;
  /** The segment text with every recognized expressive tag removed. */
  cleanText: string;
  /** The emotion in scope for this segment (`null` = no emotion cue). */
  emotion: ExpressiveEmotion | null;
  /** Whether `[singing]` is in scope for this segment. */
  singing: boolean;
  /** Preserved non-verbals that appeared inside this segment, in order. */
  nonverbals: ExpressiveNonverbal[];
}

export interface ParsedExpressiveText {
  /** The whole `replyText` with every recognized expressive tag removed. */
  cleanText: string;
  /** The text split at every emotion/singing scope boundary. */
  segments: ExpressiveSegment[];
  /** The dominant (first scope-setting) emotion across the text, or `null`. */
  dominantEmotion: ExpressiveEmotion | null;
  /** `true` iff any `[singing]` tag appeared. */
  anySinging: boolean;
  /** `true` iff any recognized expressive tag appeared. */
  hasTags: boolean;
  /** Literal `[token]` occurrences that look like a tag but aren't in the
   *  vocabulary (e.g. a hallucinated `[grumpy]`) — recorded, not silently
   *  dropped, so the `tagLeakage` check can flag them. */
  unknownTags: string[];
}

/**
 * Parse a `replyText` into expressive segments. A scope-setting tag is an
 * emotion tag or `[singing]`; a `[laughter]` / `[sigh]` is a non-verbal that
 * is recorded on the current segment but does not start a new one. The
 * segment text retains the scope tag (for the singing-GGUF pass-through) and
 * `cleanText` is the same text with all expressive tags removed.
 *
 * Empty / whitespace-only segments between two adjacent scope tags are
 * dropped (a leading `[happy][whisper]hi` → one segment, scope = whisper).
 */
export function parseExpressiveTags(replyText: string): ParsedExpressiveText {
  const text = typeof replyText === "string" ? replyText : "";
  const segments: ExpressiveSegment[] = [];
  const unknownTags: string[] = [];
  let dominantEmotion: ExpressiveEmotion | null = null;
  let anySinging = false;
  let hasTags = false;

  // Walk the matches, accumulating the text between scope boundaries.
  let cursor = 0;
  let curEmotion: ExpressiveEmotion | null = null;
  let curSinging = false;
  let curRawParts: string[] = [];
  let curNonverbals: ExpressiveNonverbal[] = [];

  const flush = (): void => {
    const raw = curRawParts.join("");
    // Fresh regex — must NOT touch `re`'s `lastIndex` (we're inside `re`'s loop).
    const clean = raw.replace(tagRegex(), "").trim();
    // A segment with no visible text and no non-verbals carries nothing.
    if (clean.length === 0 && curNonverbals.length === 0) return;
    segments.push({
      text: raw,
      cleanText: clean,
      emotion: curEmotion,
      singing: curSinging,
      nonverbals: [...curNonverbals],
    });
  };

  const re = tagRegex();
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex-exec loop.
  while ((m = re.exec(text)) !== null) {
    // Zero-width matches can't happen (the pattern needs `[…]`), but guard
    // anyway so a future pattern change can't wedge the loop.
    if (m[0].length === 0) {
      re.lastIndex += 1;
      continue;
    }
    const before = text.slice(cursor, m.index);
    cursor = m.index + m[0].length;
    const inner = (m[1] ?? "").toLowerCase();
    if (EMOTION_SET.has(inner) || inner === EXPRESSIVE_SINGING_TAG) {
      // A scope-setting tag: append the lead-in text + this tag to the
      // *current* segment's raw, then flush and start a new scope. (Keeping
      // the tag in the raw text means the singing GGUF still sees it at the
      // head of the next phrase.)
      curRawParts.push(before);
      flush();
      curRawParts = [m[0]];
      curNonverbals = [];
      hasTags = true;
      if (inner === EXPRESSIVE_SINGING_TAG) {
        curSinging = true;
        anySinging = true;
      } else {
        curEmotion = inner as ExpressiveEmotion;
        if (dominantEmotion === null) dominantEmotion = curEmotion;
      }
    } else if (NONVERBAL_SET.has(inner)) {
      // A non-verbal: keep it in the raw text, record it, don't start a scope.
      curRawParts.push(before, m[0]);
      curNonverbals.push(inner as ExpressiveNonverbal);
      hasTags = true;
    } else {
      // Unknown bracket token — keep it verbatim (it's the model's text) and
      // record it for the leakage check.
      curRawParts.push(before, m[0]);
      unknownTags.push(m[0]);
    }
  }
  curRawParts.push(text.slice(cursor));
  flush();

  // If there were no tags at all, present the whole text as one neutral segment.
  if (segments.length === 0) {
    const clean = text.trim();
    if (clean.length > 0) {
      segments.push({
        text,
        cleanText: clean,
        emotion: null,
        singing: false,
        nonverbals: [],
      });
    }
  }

  return {
    cleanText: text.replace(tagRegex(), "").replace(/\s+/g, " ").trim(),
    segments,
    dominantEmotion,
    anySinging,
    hasTags,
    unknownTags,
  };
}

/** Strip every recognized expressive tag (emotion / singing / non-verbal)
 *  from `text`. Used on a base-TTS path so a literal `[happy]` never reaches
 *  the audio. Unknown bracket tokens (`[grumpy]`) are left as-is — they are
 *  the model's text, not a tag we recognise. */
export function stripExpressiveTags(text: string): string {
  return text
    .replace(tagRegex(), (full, inner) =>
      ALL_TAG_SET.has(String(inner).toLowerCase()) ? "" : full,
    )
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/**
 * Map the dominant emotion (or `null`) to the Stage-1 envelope `emotion` enum
 * value (`null` → `"none"`). Inverse: `EXPRESSIVE_EMOTION_ENUM` minus `"none"`.
 */
export function emotionToEnum(
  emotion: ExpressiveEmotion | null,
): ExpressiveEmotionEnum {
  return emotion ?? "none";
}

/** Map the Stage-1 envelope `emotion` enum value back to an emotion (or `null`). */
export function enumToEmotion(
  value: ExpressiveEmotionEnum | string | null | undefined,
): ExpressiveEmotion | null {
  if (!value || value === "none") return null;
  return EMOTION_SET.has(value) ? (value as ExpressiveEmotion) : null;
}

// ---------------------------------------------------------------------------
// Optional ASR emotion metadata mapping
// ---------------------------------------------------------------------------

/**
 * Candidate labels a connector or explicitly emotion-aware ASR adapter may
 * surface as structured metadata. The local fused ASR path must not be treated
 * as model-native emotion recognition unless that backend explicitly advertises
 * such a field; callers should record heuristic attribution separately.
 */
export const QWEN3_ASR_EMOTION_LABELS = [
  "surprise",
  "calm",
  "happiness",
  "sadness",
  "disgust",
  "anger",
  "fear",
] as const;

export type Qwen3AsrEmotionLabel = (typeof QWEN3_ASR_EMOTION_LABELS)[number];

/**
 * Explicit mapping from an ASR-perceived emotion label to the tag vocab the
 * generator emits. `whisper` / `singing` are delivery styles, not affects, and
 * are excluded from the fidelity score (scored separately as "style preserved"
 * via the `instruct` round-trip). Labels with no clean tag analogue map to
 * `null` (counted as "no agreement" rather than forced).
 */
export const ASR_LABEL_TO_EMOTION_TAG: Readonly<
  Record<Qwen3AsrEmotionLabel, ExpressiveEmotion | null>
> = {
  happiness: "happy",
  sadness: "sad",
  anger: "angry",
  fear: "nervous",
  calm: "calm",
  surprise: "excited",
  disgust: null,
};

/** Normalize an arbitrary ASR-emitted emotion string (any casing, possibly an
 *  adjective form) to a `Qwen3AsrEmotionLabel` if it matches, else `null`. */
export function normalizeAsrEmotionLabel(
  raw: string | null | undefined,
): Qwen3AsrEmotionLabel | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  // Direct hit.
  if ((QWEN3_ASR_EMOTION_LABELS as readonly string[]).includes(v)) {
    return v as Qwen3AsrEmotionLabel;
  }
  // Common adjective forms → noun labels.
  const ADJ: Record<string, Qwen3AsrEmotionLabel> = {
    happy: "happiness",
    sad: "sadness",
    angry: "anger",
    fearful: "fear",
    afraid: "fear",
    scared: "fear",
    surprised: "surprise",
    disgusted: "disgust",
  };
  return ADJ[v] ?? null;
}

/** Map an ASR-perceived emotion (raw string) straight to the tag vocab, via
 *  `normalizeAsrEmotionLabel` + `ASR_LABEL_TO_EMOTION_TAG`. `null` when it
 *  doesn't map. */
export function asrEmotionToTag(
  raw: string | null | undefined,
): ExpressiveEmotion | null {
  const label = normalizeAsrEmotionLabel(raw);
  return label ? ASR_LABEL_TO_EMOTION_TAG[label] : null;
}

// ---------------------------------------------------------------------------
// The voice-output prompt clause
// ---------------------------------------------------------------------------

/**
 * The clause appended to the voice-mode response instruction telling the model
 * it MAY annotate `replyText` with inline expressive tags. Only emit this when
 * `manifest.voice.capabilities` includes `emotion-tags` (don't instruct the
 * model to emit tags a base-TTS bundle will speak literally). `singingAllowed`
 * controls whether `[singing]` is offered (gate on the `singing` capability).
 */
export function expressiveTagPromptClause(
  opts: { singingAllowed?: boolean } = {},
): string {
  const singing = opts.singingAllowed === true;
  const vocab = [
    ...EXPRESSIVE_EMOTION_TAGS.map((t) => `[${t}]`),
    ...(singing ? [`[${EXPRESSIVE_SINGING_TAG}]`] : []),
    ...EXPRESSIVE_NONVERBAL_TAGS.map((t) => `[${t}]`),
  ].join(" ");
  return (
    "When the turn is spoken aloud, you MAY annotate replyText with inline " +
    `expressive tags from this exact set: ${vocab}. ` +
    "A tag applies from where it appears to the next tag (or end of text); " +
    "mid-sentence shifts are allowed. Use them sparingly and only when the " +
    "affect is genuine. Do not use tags in text-only turns, and do not invent " +
    "tags outside this set."
  );
}
