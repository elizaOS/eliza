import type { SpeechCharacterTiming } from "@elizaos/cloud-sdk/native-speech-stream";

export interface SpeechWordRange {
  /** UTF-16 offsets into the exact caption supplied by the host. */
  from: number;
  to: number;
  start: number;
  end: number;
}

/** Assemble words across frames whose seconds are relative to one utterance.
 * No frame offsets or rate multipliers are inferred. Query with media.currentTime,
 * including after seek/rate changes. Missing, reset or mismatched alignment
 * invalidates the timeline; the host keeps its full, unhighlighted caption.
 * A fresh timeline is required for each utterance and replay. */
export function createSpeechWordTimeline(text: string) {
  let valid = text.length > 0 && text.length <= 50000;
  let finished = false;
  let offset = 0;
  let previousStart = -1;
  let previousEnd = -1;
  let pending: SpeechWordRange | undefined;
  const words: SpeechWordRange[] = [];
  const invalidate = () => {
    valid = false;
    words.length = 0;
    pending = undefined;
  };
  const flush = () => {
    if (pending) words.push(pending);
    pending = undefined;
  };
  return {
    get valid() {
      return valid;
    },
    append(timing: SpeechCharacterTiming | null) {
      if (!valid) return;
      if (
        finished ||
        !timing ||
        !Array.isArray(timing.characters) ||
        !Array.isArray(timing.characterStartTimesSeconds) ||
        !Array.isArray(timing.characterEndTimesSeconds) ||
        timing.characters.length !== timing.characterStartTimesSeconds.length ||
        timing.characters.length !== timing.characterEndTimesSeconds.length ||
        timing.characters.length > 50000
      ) {
        invalidate();
        return;
      }
      for (let i = 0; i < timing.characters.length; i++) {
        const part = timing.characters[i],
          start = timing.characterStartTimesSeconds[i],
          end = timing.characterEndTimesSeconds[i];
        if (
          typeof part !== "string" ||
          !part.length ||
          part.length > 16 ||
          !Number.isFinite(start) ||
          !Number.isFinite(end) ||
          start < 0 ||
          end < start ||
          end > 3600 ||
          start < previousStart ||
          end < previousEnd ||
          !text.startsWith(part, offset) ||
          (/\s/u.test(part) && part.trim().length > 0)
        ) {
          invalidate();
          return;
        }
        previousStart = start;
        previousEnd = end;
        if (/^\s+$/u.test(part)) flush();
        else if (pending) {
          pending.to = offset + part.length;
          pending.end = end;
        } else pending = { from: offset, to: offset + part.length, start, end };
        offset += part.length;
      }
    },
    finish() {
      if (finished) return;
      finished = true;
      if (offset !== text.length) invalidate();
      if (valid) flush();
    },
    at(seconds: number): SpeechWordRange | null {
      if (!valid || !Number.isFinite(seconds) || seconds < 0) return null;
      // Binary search supports long replies, seeking and playback replay.
      let low = 0,
        high = words.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (words[middle].start <= seconds) low = middle + 1;
        else high = middle;
      }
      const word = words[low - 1];
      return word && seconds < word.end ? { ...word } : null;
    },
  };
}
