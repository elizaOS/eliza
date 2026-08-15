/**
 * Merge streaming text updates that may arrive as pure deltas, cumulative
 * snapshots, or overlapping suffix/prefix fragments.
 */

/**
 * Wire protocol a chat client advertises in the stream POST body to opt into
 * delta framing (deltas + geometric snapshots instead of a full-text snapshot
 * per token). The server only switches framing when this exact literal is
 * present, so old servers ignore the unknown field and old clients keep the
 * legacy per-token `fullText`. Single source of truth for both the agent SSE
 * writer (`@elizaos/agent` chat-routes) and the UI stream client.
 */
export const DELTA_STREAM_PROTOCOL = "delta-v2" as const;

export type DeltaStreamProtocol = typeof DELTA_STREAM_PROTOCOL;

/**
 * Remove an NFC-space overlap while preserving raw input beyond the sequence
 * that contains the cut. Canonical ordering can make an exact raw boundary
 * impossible, so only that ambiguous prefix is normalized.
 */
function sliceAfterNormalizedOverlap(
  incoming: string,
  incomingNorm: string,
  overlap: number,
): string {
  if (overlap <= 0) return incoming;
  const targetPrefix = incomingNorm.slice(0, overlap);
  const codePointBoundaries: number[] = [];
  let offset = 0;
  for (const codePoint of incoming) {
    offset += codePoint.length;
    codePointBoundaries.push(offset);
  }

  for (const offset of codePointBoundaries) {
    if (incoming.slice(0, offset).normalize("NFC") === targetPrefix) {
      return incoming.slice(offset);
    }
  }

  for (const offset of codePointBoundaries) {
    const normalizedPrefix = incoming.slice(0, offset).normalize("NFC");
    if (normalizedPrefix.startsWith(targetPrefix)) {
      return `${normalizedPrefix.slice(overlap)}${incoming.slice(offset)}`;
    }
  }

  return incomingNorm.slice(overlap);
}

function commonPrefixLength(left: string, right: string): number {
  const maxLength = Math.min(left.length, right.length);
  let index = 0;
  while (
    index < maxLength &&
    left.charCodeAt(index) === right.charCodeAt(index)
  ) {
    index += 1;
  }
  return index;
}

function commonSuffixLength(
  left: string,
  right: string,
  sharedPrefixLength: number,
): number {
  const maxLength = Math.min(
    left.length - sharedPrefixLength,
    right.length - sharedPrefixLength,
  );
  let length = 0;
  while (
    length < maxLength &&
    left.charCodeAt(left.length - 1 - length) ===
      right.charCodeAt(right.length - 1 - length)
  ) {
    length += 1;
  }
  return length;
}

function isLikelySnapshotReplacement(
  existing: string,
  incoming: string,
): boolean {
  const sharedPrefixLength = commonPrefixLength(existing, incoming);
  const sharedSuffixLength = commonSuffixLength(
    existing,
    incoming,
    sharedPrefixLength,
  );
  const sharedLength = sharedPrefixLength + sharedSuffixLength;
  const minLength = Math.min(existing.length, incoming.length);

  // For short strings, a modest shared prefix is strong evidence of a
  // snapshot replacement (e.g. case correction, punctuation addition).
  if (minLength < 30 && sharedPrefixLength >= 2) {
    return true;
  }

  return (
    sharedPrefixLength >= 8 ||
    sharedLength >= Math.max(4, Math.ceil(minLength * 0.7))
  );
}

export function mergeStreamingText(existing: string, incoming: string): string {
  if (!incoming) return existing;
  if (!existing) return incoming;

  // Normalize unicode for comparison, but return original incoming when selected.
  const existingNorm = existing.normalize("NFC");
  const incomingNorm = incoming.normalize("NFC");

  if (incomingNorm === existingNorm) {
    return incoming.length === 1 && /\S/u.test(incoming)
      ? `${existing}${incoming}`
      : incoming;
  }

  // Common case: the stream sends the full text-so-far.
  if (incomingNorm.startsWith(existingNorm)) {
    return incoming;
  }

  // Some providers resend the full text with a revised prefix or wrapper.
  if (incomingNorm.includes(existingNorm)) {
    return incoming;
  }

  // Ignore clearly regressive snapshots.
  if (existingNorm.startsWith(incomingNorm)) {
    return existing;
  }

  // Use trimmed existing for overlap detection so trailing whitespace
  // does not prevent finding a valid overlap.
  const existingTrimmed = existingNorm.trimEnd();

  const maxOverlap = Math.min(existingTrimmed.length, incomingNorm.length);
  const existingTrimmedLength = existingTrimmed.length;
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    const existingStart = existingTrimmedLength - overlap;
    let match = true;
    for (let index = 0; index < overlap; index += 1) {
      if (
        existingTrimmed.charCodeAt(existingStart + index) !==
        incomingNorm.charCodeAt(index)
      ) {
        match = false;
        break;
      }
    }
    if (!match) continue;

    if (overlap === incomingNorm.length) {
      // Preserve repeated single-character deltas like "l" + "l", but avoid
      // replaying larger suffix fragments already present in the buffer.
      return incoming.length === 1 ? `${existing}${incoming}` : existing;
    }

    const suffix = sliceAfterNormalizedOverlap(incoming, incomingNorm, overlap);
    return `${existing.slice(0, existing.length - (existingNorm.length - existingTrimmedLength))}${suffix}`;
  }

  // Some providers revise earlier words in-place while still sending the full
  // text-so-far. Treat those as snapshot replacements instead of appends.
  if (isLikelySnapshotReplacement(existingNorm, incomingNorm)) {
    return incoming;
  }

  return `${existing}${incoming}`;
}

export function computeStreamingDelta(
  existing: string,
  incoming: string,
): string {
  const merged = mergeStreamingText(existing, incoming);
  if (merged === existing) return "";
  if (merged.startsWith(existing)) {
    return merged.slice(existing.length);
  }
  return incoming;
}

export type StreamingUpdateResult = {
  kind: "append" | "replace" | "unchanged";
  nextText: string;
  emittedText: string;
};

export function resolveStreamingUpdate(
  existing: string,
  incoming: string,
): StreamingUpdateResult {
  const merged = mergeStreamingText(existing, incoming);

  if (merged === existing) {
    return { kind: "unchanged", nextText: existing, emittedText: "" };
  }

  if (merged.startsWith(existing)) {
    return {
      kind: "append",
      nextText: merged,
      emittedText: merged.slice(existing.length),
    };
  }

  return { kind: "replace", nextText: merged, emittedText: merged };
}
