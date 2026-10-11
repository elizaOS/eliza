/** Validates caller-supplied UTF-16 message chunk limits before splitting. */

export function assertValidMessageChunkLength(maxLength: number): void {
  if (!Number.isFinite(maxLength) || !Number.isInteger(maxLength) || maxLength < 2) {
    throw new RangeError("maxLength must be a finite integer of at least 2 UTF-16 code units");
  }
}

// The pinned runtimes provide Intl.Segmenter, while this package's
// declaration library does not expose its type.
const GraphemeSegmenter = (
  Intl as unknown as {
    Segmenter: new (
      locale: string,
      options: { granularity: "grapheme" },
    ) => { segment(text: string): Iterable<{ segment: string }> };
  }
).Segmenter;

const graphemeSegmenter = new GraphemeSegmenter("en", {
  granularity: "grapheme",
});

/**
 * Split UTF-16 text into bounded chunks whose concatenation is byte-for-byte
 * exact. A chunk never ends inside a grapheme cluster (a ZWJ emoji sequence,
 * a regional-indicator flag, a combining mark, or a skin-tone modifier), so a
 * cluster is never split across two message parts. When a single cluster
 * alone exceeds the limit, the cut falls back to the surrogate-safe boundary;
 * it is the only case with no clean boundary.
 */
export function splitMessageLosslessly(text: string, maxLength: number): string[] {
  assertValidMessageChunkLength(maxLength);
  if (!text) return [];

  const chunks: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    let end = Math.min(offset + maxLength, text.length);
    if (end < text.length) {
      let boundary = offset;
      for (const { segment } of graphemeSegmenter.segment(text.slice(offset))) {
        if (boundary + segment.length > end) break;
        boundary += segment.length;
      }
      if (boundary > offset) {
        end = boundary;
      } else if (text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) {
        end -= 1;
      }
    }
    chunks.push(text.slice(offset, end));
    offset = end;
  }
  return chunks;
}
