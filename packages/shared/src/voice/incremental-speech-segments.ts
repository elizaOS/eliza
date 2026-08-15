import { projectVoiceOutput } from "./voice-output-envelope";

export const COMMITTED_SPEECH_PROTOCOL = "committed-segments-v1" as const;
export const COMMITTED_SPEECH_SEGMENT_VERSION = 1 as const;
export const MAX_COMMITTED_SPEECH_SEGMENTS = 8;
export const MAX_COMMITTED_SPEECH_CHARS = 600;
export const MAX_COMMITTED_SPEECH_SEGMENT_CHARS = 240;
export const MAX_COMMITTED_SPEECH_SOURCE_CHARS = 320;
export const MIN_COMMITTED_SPEECH_SEGMENT_CHARS = 32;

export interface CommittedSpeechSegment {
  type: "voice_speech_segment";
  version: typeof COMMITTED_SPEECH_SEGMENT_VERSION;
  sequence: number;
  sourceStart: number;
  sourceEnd: number;
  speechText: string;
}

export interface CommittedSpeechValidationState {
  nextSequence: number;
  sourceEnd: number;
  speechChars: number;
}

export class CommittedSpeechProtocolError extends Error {
  readonly code = "COMMITTED_SPEECH_PROTOCOL_ERROR";

  constructor(message: string) {
    super(message);
    this.name = "CommittedSpeechProtocolError";
  }
}

export function initialCommittedSpeechValidationState(): CommittedSpeechValidationState {
  return { nextSequence: 0, sourceEnd: 0, speechChars: 0 };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function splitsSurrogatePair(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return false;
  return (
    /[\uD800-\uDBFF]/.test(text[offset - 1] ?? "") &&
    /[\uDC00-\uDFFF]/.test(text[offset] ?? "")
  );
}

function projectPlainSpeechCandidate(sourceText: string): string | null {
  const projection = projectVoiceOutput(
    {
      policy: "both",
      display: { markdown: sourceText },
    },
    { maxSpeechChars: MAX_COMMITTED_SPEECH_SEGMENT_CHARS },
  );
  if (
    projection.speechText === null ||
    projection.captions !== projection.speechText ||
    projection.usedStructuredSummary ||
    projection.truncated ||
    projection.speechText.length < MIN_COMMITTED_SPEECH_SEGMENT_CHARS ||
    projection.speechText.length > MAX_COMMITTED_SPEECH_SEGMENT_CHARS
  ) {
    return null;
  }
  return projection.speechText;
}

export function parseCommittedSpeechSegment(
  value: unknown,
): CommittedSpeechSegment | null {
  if (!isRecord(value)) return null;
  if (
    value.type !== "voice_speech_segment" ||
    value.version !== COMMITTED_SPEECH_SEGMENT_VERSION ||
    !isNonNegativeInteger(value.sequence) ||
    !isNonNegativeInteger(value.sourceStart) ||
    !isNonNegativeInteger(value.sourceEnd) ||
    value.sourceEnd <= value.sourceStart ||
    typeof value.speechText !== "string" ||
    value.speechText.length === 0 ||
    value.speechText.length > MAX_COMMITTED_SPEECH_SEGMENT_CHARS
  ) {
    return null;
  }
  return {
    type: "voice_speech_segment",
    version: COMMITTED_SPEECH_SEGMENT_VERSION,
    sequence: value.sequence,
    sourceStart: value.sourceStart,
    sourceEnd: value.sourceEnd,
    speechText: value.speechText,
  };
}

/**
 * Validate an agent-issued speech commitment against the authoritative display
 * text already observed by the consumer. Consumers repeat the projection so a
 * malformed or compromised producer cannot bypass the speech safety boundary.
 */
export function validateCommittedSpeechSegment(
  segment: CommittedSpeechSegment,
  authoritativeText: string,
  state: CommittedSpeechValidationState,
): CommittedSpeechValidationState {
  if (
    segment.sequence !== state.nextSequence ||
    segment.sequence >= MAX_COMMITTED_SPEECH_SEGMENTS
  ) {
    throw new CommittedSpeechProtocolError(
      "Committed speech segment sequence is not contiguous",
    );
  }
  if (
    segment.sourceStart !== state.sourceEnd ||
    segment.sourceEnd > authoritativeText.length ||
    segment.sourceEnd - segment.sourceStart >
      MAX_COMMITTED_SPEECH_SOURCE_CHARS ||
    splitsSurrogatePair(authoritativeText, segment.sourceStart) ||
    splitsSurrogatePair(authoritativeText, segment.sourceEnd)
  ) {
    throw new CommittedSpeechProtocolError(
      "Committed speech segment source range is invalid",
    );
  }
  if (
    state.speechChars + segment.speechText.length >
    MAX_COMMITTED_SPEECH_CHARS
  ) {
    throw new CommittedSpeechProtocolError(
      "Committed speech segment exceeds the turn speech limit",
    );
  }
  const sourceText = authoritativeText.slice(
    segment.sourceStart,
    segment.sourceEnd,
  );
  if (projectPlainSpeechCandidate(sourceText) !== segment.speechText) {
    throw new CommittedSpeechProtocolError(
      "Committed speech segment does not match the safe source projection",
    );
  }
  return {
    nextSequence: state.nextSequence + 1,
    sourceEnd: segment.sourceEnd,
    speechChars: state.speechChars + segment.speechText.length,
  };
}

function sentenceBoundaries(text: string, start: number): number[] {
  const boundaries: number[] = [];
  const matcher = /[.!?…](?:["'’”)\]]*)(?=\s)/gu;
  matcher.lastIndex = start;
  for (let match = matcher.exec(text); match; match = matcher.exec(text)) {
    const end = match.index + match[0].length;
    if (/\S/u.test(text.slice(end))) boundaries.push(end);
  }
  return boundaries;
}

/**
 * Canonical-route speech authority. A returned segment is an irrevocable
 * prefix commitment: later snapshots and terminal text must retain its exact
 * source prefix or the turn fails closed.
 */
export class CommittedSpeechSegmenter {
  private authoritativeText = "";
  private validationState = initialCommittedSpeechValidationState();
  private frozenSourcePrefix = "";
  private disabled = false;

  get committedSourceText(): string {
    return this.frozenSourcePrefix;
  }

  get hasCommittedSpeech(): boolean {
    return this.validationState.nextSequence > 0;
  }

  disable(): void {
    this.disabled = true;
  }

  observeModelDelta(chunk: string): readonly CommittedSpeechSegment[] {
    if (!chunk) return [];
    this.authoritativeText += chunk;
    return this.drainSegments();
  }

  observeModelSnapshot(text: string): readonly CommittedSpeechSegment[] {
    this.assertRetainsCommittedPrefix(text);
    // The canonical route deliberately ignores a shorter prefix-equivalent
    // normalization while more model text is already visible. Mirror it here.
    if (
      text.length < this.authoritativeText.length &&
      this.authoritativeText.startsWith(text)
    ) {
      return [];
    }
    this.authoritativeText = text;
    return this.drainSegments();
  }

  assertTerminalText(text: string): void {
    this.assertRetainsCommittedPrefix(text);
  }

  private assertRetainsCommittedPrefix(text: string): void {
    if (this.frozenSourcePrefix && !text.startsWith(this.frozenSourcePrefix)) {
      throw new CommittedSpeechProtocolError(
        "Authoritative text diverged from an irrevocable speech commitment",
      );
    }
  }

  private drainSegments(): readonly CommittedSpeechSegment[] {
    if (
      this.disabled ||
      this.validationState.nextSequence >= MAX_COMMITTED_SPEECH_SEGMENTS ||
      this.validationState.speechChars >= MAX_COMMITTED_SPEECH_CHARS
    ) {
      return [];
    }

    const segments: CommittedSpeechSegment[] = [];
    for (;;) {
      const sourceStart = this.validationState.sourceEnd;
      const boundaries = sentenceBoundaries(
        this.authoritativeText,
        sourceStart,
      );
      let selected: { sourceEnd: number; speechText: string } | null = null;
      for (const sourceEnd of boundaries) {
        const sourceLength = sourceEnd - sourceStart;
        if (sourceLength > MAX_COMMITTED_SPEECH_SOURCE_CHARS) {
          this.disabled = true;
          return segments;
        }
        const speechText = projectPlainSpeechCandidate(
          this.authoritativeText.slice(sourceStart, sourceEnd),
        );
        if (speechText) {
          selected = { sourceEnd, speechText };
          break;
        }
      }
      if (!selected) return segments;
      if (
        this.validationState.speechChars + selected.speechText.length >
        MAX_COMMITTED_SPEECH_CHARS
      ) {
        this.disabled = true;
        return segments;
      }
      const segment: CommittedSpeechSegment = {
        type: "voice_speech_segment",
        version: COMMITTED_SPEECH_SEGMENT_VERSION,
        sequence: this.validationState.nextSequence,
        sourceStart,
        sourceEnd: selected.sourceEnd,
        speechText: selected.speechText,
      };
      this.validationState = validateCommittedSpeechSegment(
        segment,
        this.authoritativeText,
        this.validationState,
      );
      this.frozenSourcePrefix = this.authoritativeText.slice(
        0,
        this.validationState.sourceEnd,
      );
      segments.push(segment);
      if (
        this.validationState.nextSequence >= MAX_COMMITTED_SPEECH_SEGMENTS ||
        this.validationState.speechChars >= MAX_COMMITTED_SPEECH_CHARS
      ) {
        this.disabled = true;
        return segments;
      }
    }
  }
}
