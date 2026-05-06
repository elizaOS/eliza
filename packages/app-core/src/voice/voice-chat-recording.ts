/**
 * Recording / STT logic for voice chat — transcript merging and normalization.
 */

import { mergeStreamingText } from "../utils/streaming-text";
import { collapseWhitespace } from "./voice-chat-playback";

// ── Transcript merging ────────────────────────────────────────────────

export function normalizeTranscriptWord(word: string): string {
  return word
    .normalize("NFKC")
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

export function mergeTranscriptWindows(
  existing: string,
  incoming: string,
): string {
  const left = collapseWhitespace(existing);
  const right = collapseWhitespace(incoming);

  if (!left) return right;
  if (!right) return left;

  const exactMerged = mergeStreamingText(left, right);
  if (
    exactMerged === right ||
    exactMerged === left ||
    exactMerged === `${left}${right}`
  ) {
    const leftWords = left.split(" ");
    const rightWords = right.split(" ");
    const maxOverlap = Math.min(leftWords.length, rightWords.length);

    for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
      let matches = true;
      for (let index = 0; index < overlap; index += 1) {
        const leftWord = normalizeTranscriptWord(
          leftWords[leftWords.length - overlap + index] ?? "",
        );
        const rightWord = normalizeTranscriptWord(rightWords[index] ?? "");
        if (!leftWord || !rightWord || leftWord !== rightWord) {
          matches = false;
          break;
        }
      }
      if (!matches) continue;

      if (overlap === rightWords.length) {
        return left;
      }
      return [...leftWords, ...rightWords.slice(overlap)].join(" ");
    }
  }

  return exactMerged;
}
