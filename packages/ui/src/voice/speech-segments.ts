/** Browser-safe speech chunking shared by playback hosts. */
export function collapseWhitespace(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}
/** Common abbreviations that end with a period but are not sentence endings. */
const ABBREV_RE =
  /(?:Mr|Mrs|Ms|Dr|Jr|Sr|St|vs|etc|approx|Prof|Rev|Gen|Sgt|Lt|Col|Maj|Capt|Corp|Pvt|Ave|Blvd|dept|est|govt|assn)$/;
/**
 * Replace URLs with placeholders so their internal dots are not treated as
 * sentence boundaries.  Returns the cleaned string and a restore function.
 */
export function shelterUrls(input: string): {
  text: string;
  restore: (s: string) => string;
} {
  const urls: string[] = [];
  const text = input.replace(/https?:\/\/\S+/g, (m) => {
    urls.push(m);
    return `__URL${urls.length - 1}__`;
  });
  return {
    text,
    restore: (s: string) =>
      s.replace(/__URL(\d+)__/g, (_, i) => urls[Number(i)] ?? _),
  };
}
/**
 * Test whether a period match at `index` inside `value` is a real sentence
 * boundary (not an abbreviation or decimal).
 */
export function isRealSentenceEnd(value: string, matchIndex: number): boolean {
  const previousChar = matchIndex > 0 ? value[matchIndex - 1] : undefined;
  const nextChar =
    matchIndex + 1 < value.length ? value[matchIndex + 1] : undefined;
  if (previousChar !== undefined && /\d/.test(previousChar)) {
    if (nextChar === undefined || /\d/.test(nextChar)) {
      return false;
    }
  }
  const before = value.slice(0, matchIndex);
  if (ABBREV_RE.test(before)) return false;
  return true;
}
export function splitFirstSentence(text: string): {
  complete: boolean;
  firstSentence: string;
  remainder: string;
} {
  const value = collapseWhitespace(text);
  if (!value) return { complete: false, firstSentence: "", remainder: "" };
  const { text: sheltered, restore } = shelterUrls(value);
  const boundary = /([.!?;:,]+(?:["')\]]+)?)(?:\s|$)/g;
  let match: RegExpExecArray | null = null;
  while (true) {
    match = boundary.exec(sheltered);
    if (!match || typeof match.index !== "number") break;
    const punctChar = match[1]?.[0];
    if (punctChar === ".") {
      if (match[1]?.length >= 3) continue;
      if (!isRealSentenceEnd(sheltered, match.index)) continue;
    }
    const endIndex = match.index + match[0].length;
    const firstSentence = restore(sheltered.slice(0, endIndex).trim());
    const remainder = restore(sheltered.slice(endIndex).trim());
    if (firstSentence.length > 0) {
      return { complete: true, firstSentence, remainder };
    }
  }
  if (value.length >= 180) {
    const window = value.slice(0, 180);
    const splitAt = window.lastIndexOf(" ");
    if (splitAt > 100) {
      return {
        complete: true,
        firstSentence: window.slice(0, splitAt).trim(),
        remainder: value.slice(splitAt).trim(),
      };
    }
  }
  return { complete: false, firstSentence: value, remainder: "" };
}
/** Preserve every word while returning independently playable caption chunks. */
export function splitSpeechSegments(text: string): string[] {
  const segments: string[] = [];
  let remaining = collapseWhitespace(text);
  while (remaining) {
    const { firstSentence, remainder } = splitFirstSentence(remaining);
    segments.push(firstSentence);
    remaining = remainder;
  }
  return segments;
}
