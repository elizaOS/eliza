/**
 * Post-ASR hallucination gate, ported from Vexa
 * (services/vexa-bot/core/src/services/hallucination-filter.ts, Apache-2.0 —
 * see NOTICE). Three layers:
 *
 *  1. Known-phrase corpus match (exact lowercase, then with trailing
 *     punctuation normalized both ways).
 *  2. Too-short junk (single word under 10 chars).
 *  3. Repetition loop: the same 3–6 word phrase repeated 3+ times.
 */

import { HALLUCINATION_PHRASES } from "./hallucinations";

/** True when the text is a known hallucination / junk and must be dropped. */
export function isHallucination(text: string): boolean {
  if (!text?.trim()) return true;

  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  // Layer 1: known phrase (exact, then retry with normalized punctuation)
  if (HALLUCINATION_PHRASES.has(lower)) return true;
  const stripped = lower.replace(/[.!?…]+$/g, "").replace(/\.{2,}$/g, "");
  if (stripped !== lower) {
    if (
      HALLUCINATION_PHRASES.has(stripped) ||
      HALLUCINATION_PHRASES.has(`${stripped}...`) ||
      HALLUCINATION_PHRASES.has(`${stripped}.`)
    ) {
      return true;
    }
  }

  // Layer 2: too short (single word < 10 chars)
  const words = trimmed.split(/\s+/);
  if (words.length <= 1 && trimmed.length < 10) return true;

  // Layer 3: repetition loop — same 3-6 word phrase repeated 3+ times
  if (words.length >= 9) {
    for (let len = 3; len <= 6; len++) {
      const phrase = words.slice(0, len).join(" ").toLowerCase();
      let count = 0;
      for (let i = 0; i <= words.length - len; i += len) {
        if (
          words
            .slice(i, i + len)
            .join(" ")
            .toLowerCase() === phrase
        ) {
          count++;
        }
      }
      if (count >= 3) return true;
    }
  }

  return false;
}
