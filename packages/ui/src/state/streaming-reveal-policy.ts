/**
 * Provider-agnostic presentation policy for cumulative chat text.
 *
 * Real token streams should paint as they arrive. Some structured-generation
 * providers, however, deliver the whole visible answer in one large snapshot.
 * Painting that snapshot atomically looks broken and makes Stop ineffective:
 * text the user never watched stream suddenly appears. This policy detects
 * only those large prefix-preserving jumps and reveals them incrementally.
 *
 * The authoritative text never changes. Pacing is presentation-only, and a
 * freeze revokes the unrevealed suffix so a cancelled/stale turn cannot paint
 * after a replacement turn has begun.
 */

/** A normal provider token burst below this size remains completely direct. */
export const STREAMING_REVEAL_ATOMIC_JUMP_CODEPOINTS = 160;

/** Timer cadence used only while an atomic snapshot has an unrevealed suffix. */
export const STREAMING_REVEAL_INTERVAL_MS = 50;

const INITIAL_REVEAL_CODEPOINTS = 48;
const MIN_STEP_CODEPOINTS = 4;
const MAX_STEP_CODEPOINTS = 24;
const WORD_BOUNDARY_LOOKAHEAD_CODEPOINTS = 10;

export type StreamingRevealPhase = "idle" | "direct" | "paced" | "frozen";

export interface StreamingRevealState {
  /** Latest cumulative text supplied by the authoritative stream. */
  authoritativeText: string;
  /** Prefix currently allowed to reach the rendered assistant bubble. */
  visibleText: string;
  /** Action-callback text may still be replaced by the final response. */
  provisional: boolean;
  /** Terminal means the transport settled; pacing may still be draining. */
  terminal: boolean;
  phase: StreamingRevealPhase;
}

export function createStreamingRevealState(): StreamingRevealState {
  return {
    authoritativeText: "",
    visibleText: "",
    provisional: false,
    terminal: false,
    phase: "idle",
  };
}

function codePoints(value: string): string[] {
  return Array.from(value);
}

function isNaturalBoundary(value: string): boolean {
  return /[\s\p{P}\p{S}]/u.test(value);
}

/**
 * Return a Unicode-safe prefix of `authoritativeText` that extends
 * `visibleText` by approximately `targetCodePoints`. A short look-ahead avoids
 * chopping ordinary words when a nearby whitespace/punctuation boundary is
 * available.
 */
function extendVisiblePrefix(
  visibleText: string,
  authoritativeText: string,
  targetCodePoints: number,
): string {
  if (!authoritativeText.startsWith(visibleText)) return authoritativeText;
  const remaining = codePoints(authoritativeText.slice(visibleText.length));
  if (remaining.length <= targetCodePoints) return authoritativeText;

  let take = Math.max(1, targetCodePoints);
  const lookaheadEnd = Math.min(
    remaining.length,
    take + WORD_BOUNDARY_LOOKAHEAD_CODEPOINTS,
  );
  while (take < lookaheadEnd && !isNaturalBoundary(remaining[take - 1] ?? "")) {
    take += 1;
  }
  return visibleText + remaining.slice(0, take).join("");
}

function hiddenCodePointCount(state: StreamingRevealState): number {
  if (!state.authoritativeText.startsWith(state.visibleText)) return 0;
  return codePoints(state.authoritativeText.slice(state.visibleText.length))
    .length;
}

function shouldPacePrefixExtension(
  state: StreamingRevealState,
  fullText: string,
  provisional: boolean,
): boolean {
  if (provisional) return false;
  if (!fullText.startsWith(state.visibleText)) return false;
  if (state.phase === "paced") return true;
  const hiddenGrowth = codePoints(
    fullText.slice(state.visibleText.length),
  ).length;
  return hiddenGrowth >= STREAMING_REVEAL_ATOMIC_JUMP_CODEPOINTS;
}

/**
 * Ingest one cumulative provider snapshot.
 *
 * Small/real token increments remain direct. A large prefix-preserving jump
 * exposes one useful initial prefix immediately and retains the suffix for
 * paced ticks. Provisional/action text remains direct because the terminal
 * response is allowed to replace it rather than extend it.
 */
export function ingestStreamingReveal(
  state: StreamingRevealState,
  fullText: string,
  provisional = false,
): StreamingRevealState {
  if (state.phase === "frozen") return state;
  if (
    state.authoritativeText === fullText &&
    state.provisional === provisional
  ) {
    return state;
  }

  if (!shouldPacePrefixExtension(state, fullText, provisional)) {
    return {
      authoritativeText: fullText,
      visibleText: fullText,
      provisional,
      terminal: false,
      phase: fullText ? "direct" : "idle",
    };
  }

  const base: StreamingRevealState = {
    ...state,
    authoritativeText: fullText,
    provisional: false,
    terminal: false,
    phase: "paced",
  };
  if (base.visibleText) return base;
  return {
    ...base,
    visibleText: extendVisiblePrefix("", fullText, INITIAL_REVEAL_CODEPOINTS),
  };
}

/** Advance one paced reveal tick. Direct/frozen states are referential no-ops. */
export function advanceStreamingReveal(
  state: StreamingRevealState,
): StreamingRevealState {
  if (state.phase !== "paced") return state;
  const hidden = hiddenCodePointCount(state);
  if (hidden === 0) {
    return {
      ...state,
      phase: state.visibleText ? "direct" : "idle",
    };
  }

  // Aim to clear ordinary atomic replies in roughly four seconds, while
  // bounding both tiny flickering updates and huge catch-up jumps.
  const target = Math.max(
    MIN_STEP_CODEPOINTS,
    Math.min(MAX_STEP_CODEPOINTS, Math.ceil(hidden / 80)),
  );
  const visibleText = extendVisiblePrefix(
    state.visibleText,
    state.authoritativeText,
    target,
  );
  return {
    ...state,
    visibleText,
    phase:
      visibleText === state.authoritativeText
        ? state.authoritativeText
          ? "direct"
          : "idle"
        : "paced",
  };
}

/**
 * Reconcile the authoritative terminal response without forcing a final dump.
 * Prefix-compatible text keeps draining. A divergent final is applied
 * immediately because correctness outranks animation and already-visible text
 * must never be presented as belonging to a different final answer.
 */
export function settleStreamingReveal(
  state: StreamingRevealState,
  finalText: string,
  options: { pace?: boolean; provisional?: boolean } = {},
): StreamingRevealState {
  if (state.phase === "frozen") return state;

  const pace = options.pace !== false;
  const provisional = options.provisional === true;
  const compatible = finalText.startsWith(state.visibleText);
  const hidden = compatible
    ? codePoints(finalText.slice(state.visibleText.length)).length
    : 0;
  if (
    pace &&
    !provisional &&
    compatible &&
    (state.phase === "paced" ||
      hidden >= STREAMING_REVEAL_ATOMIC_JUMP_CODEPOINTS)
  ) {
    const seeded = state.visibleText
      ? state.visibleText
      : extendVisiblePrefix("", finalText, INITIAL_REVEAL_CODEPOINTS);
    return {
      authoritativeText: finalText,
      visibleText: seeded,
      provisional: false,
      terminal: true,
      phase: seeded === finalText ? (finalText ? "direct" : "idle") : "paced",
    };
  }

  return {
    authoritativeText: finalText,
    visibleText: finalText,
    provisional,
    terminal: true,
    phase: finalText ? "direct" : "idle",
  };
}

/** Freeze exactly what was visible and permanently revoke the hidden suffix. */
export function freezeStreamingReveal(
  state: StreamingRevealState,
): StreamingRevealState {
  if (state.phase === "frozen") return state;
  return {
    authoritativeText: state.visibleText,
    visibleText: state.visibleText,
    provisional: false,
    terminal: true,
    phase: "frozen",
  };
}

export function hasPendingStreamingReveal(
  state: StreamingRevealState,
): boolean {
  return (
    state.phase === "paced" && state.visibleText !== state.authoritativeText
  );
}
