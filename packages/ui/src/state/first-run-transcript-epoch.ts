/**
 * Identifies a first-run transcript committed during the current incomplete
 * epoch, excluding synthetic turns left over from an earlier mount.
 */

interface FirstRunTranscriptLike {
  id: string;
  source?: string;
}

export interface FirstRunTranscriptEpochState {
  active: boolean;
  baselineIds: ReadonlySet<string>;
  transcriptMounted: boolean;
}

function firstRunIds(
  messages: readonly FirstRunTranscriptLike[],
): ReadonlySet<string> {
  return new Set(
    messages
      .filter((message) => message.source === "first_run")
      .map((message) => message.id),
  );
}

export function createFirstRunTranscriptEpoch(
  messages: readonly FirstRunTranscriptLike[],
  incomplete: boolean,
): FirstRunTranscriptEpochState {
  return {
    active: incomplete,
    baselineIds: firstRunIds(messages),
    transcriptMounted: false,
  };
}

/** Advances committed transcript state and begins each incomplete epoch clean. */
export function observeFirstRunTranscriptEpoch(
  state: FirstRunTranscriptEpochState,
  messages: readonly FirstRunTranscriptLike[],
  incomplete: boolean,
): FirstRunTranscriptEpochState {
  if (!incomplete) {
    return state.active || state.transcriptMounted
      ? createFirstRunTranscriptEpoch(messages, false)
      : state;
  }
  if (!state.active) return createFirstRunTranscriptEpoch(messages, true);
  if (state.transcriptMounted) return state;

  const producedCurrentEpochTurn = messages.some(
    (message) =>
      message.source === "first_run" && !state.baselineIds.has(message.id),
  );
  return producedCurrentEpochTurn
    ? { ...state, transcriptMounted: true }
    : state;
}
