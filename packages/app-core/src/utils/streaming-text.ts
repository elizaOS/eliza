/**
 * Merge streaming text updates that may arrive as pure deltas, cumulative
 * snapshots, or overlapping suffix/prefix fragments.
 */
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

  if (incomingNorm === existingNorm) return incoming;

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

    return `${existing.slice(0, existing.length - (existingNorm.length - existingTrimmedLength))}${incoming.slice(overlap)}`;
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
  kind: "append" | "replace" | "noop";
  nextText: string;
  emittedText: string;
};

export function resolveStreamingUpdate(
  existing: string,
  incoming: string,
): StreamingUpdateResult {
  const merged = mergeStreamingText(existing, incoming);

  if (merged === existing) {
    return { kind: "noop", nextText: existing, emittedText: "" };
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
