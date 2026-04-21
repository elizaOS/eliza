export type StreamingUpdateKind = "noop" | "append" | "replace";

export interface StreamingUpdate {
  kind: StreamingUpdateKind;
  nextText: string;
  emittedText: string;
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

  return (
    sharedPrefixLength >= 8 ||
    sharedLength >= Math.max(4, Math.ceil(minLength * 0.7))
  );
}

export function mergeStreamingText(existing: string, incoming: string): string {
  if (!incoming) return existing;
  if (!existing) return incoming;
  if (incoming === existing) return existing;

  if (incoming.startsWith(existing)) {
    return incoming;
  }

  if (incoming.includes(existing)) {
    return incoming;
  }

  if (existing.startsWith(incoming)) {
    return existing;
  }

  const maxOverlap = Math.min(existing.length, incoming.length);
  const existingLength = existing.length;
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    const existingStart = existingLength - overlap;
    let match = true;
    for (let index = 0; index < overlap; index += 1) {
      if (
        existing.charCodeAt(existingStart + index) !==
        incoming.charCodeAt(index)
      ) {
        match = false;
        break;
      }
    }
    if (!match) continue;

    if (overlap === incoming.length) {
      return incoming.length === 1 ? `${existing}${incoming}` : existing;
    }

    return `${existing}${incoming.slice(overlap)}`;
  }

  if (isLikelySnapshotReplacement(existing, incoming)) {
    return incoming;
  }

  return `${existing}${incoming}`;
}

export function resolveStreamingUpdate(
  existing: string,
  incoming: string,
): StreamingUpdate {
  const nextText = mergeStreamingText(existing, incoming);
  if (nextText === existing) {
    return { kind: "noop", nextText: existing, emittedText: "" };
  }

  if (nextText.startsWith(existing)) {
    return {
      kind: "append",
      nextText,
      emittedText: nextText.slice(existing.length),
    };
  }

  return {
    kind: "replace",
    nextText,
    emittedText: nextText,
  };
}
