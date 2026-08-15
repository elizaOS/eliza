/**
 * Pure presentation state for realtime voice replies.
 *
 * Canonical assistant text streams here independently from the safe whole-
 * answer TTS projection. The overlay therefore behaves like normal chat while
 * voice is active, but an interruption freezes the exact response immediately
 * and rejects every late delta/terminal replacement for that response.
 */

import type { ShellMessage } from "./shell-state";

const MAX_RETAINED_INTERRUPTED_TURNS = 4;
const INITIAL_REVEAL_CODE_POINTS = 48;
/**
 * Fast enough to feel live, but slow enough that a long answer remains aligned
 * with audible speech instead of becoming a near-instant transcript dump.
 */
const VISUAL_REVEAL_CODE_POINTS_PER_SECOND = 48;

type RealtimeVoiceTurnOutcome =
  | "spoken"
  | "displayed"
  | "no_response"
  | "error"
  | "stopped";

export type RealtimeVoiceDisplayPhase =
  | "streaming"
  | "revealing"
  | "pending"
  | "speaking"
  | "complete"
  | "interrupted";

export interface RealtimeVoiceDisplayTurn {
  traceId: string;
  messageId?: string;
  displayMarkdown: string;
  speechText: string | null;
  displayTruncated: boolean;
  createdAtMs: number;
  visibleText: string;
  phase: RealtimeVoiceDisplayPhase;
  lastRevealAtMs: number;
  revealCarryCodePoints: number;
  /** Browser playout ownership, independent of the server's send completion. */
  playbackActive: boolean;
  serverOutcome?: RealtimeVoiceTurnOutcome;
}

export interface RealtimeVoiceDisplayState {
  turns: readonly RealtimeVoiceDisplayTurn[];
}

export type RealtimeVoiceDisplayEvent =
  | {
      /** Cumulative canonical snapshot; replaces, rather than appends, text. */
      type: "stream";
      traceId: string;
      text: string;
      atMs: number;
    }
  | {
      type: "output";
      traceId: string;
      messageId?: string;
      displayMarkdown: string;
      speechText: string | null;
      displayTruncated: boolean;
      atMs: number;
    }
  | { type: "speaking_start"; traceId: string; atMs: number }
  | { type: "playback_active"; traceId: string; atMs: number }
  | { type: "playback_drained"; traceId: string; atMs: number }
  | { type: "user_speech"; atMs: number }
  | { type: "tick"; atMs: number }
  | { type: "interrupted"; traceId: string; atMs: number }
  | {
      type: "turn_end";
      traceId: string;
      outcome: RealtimeVoiceTurnOutcome;
      atMs: number;
    }
  | { type: "conversation_changed" };

export const EMPTY_REALTIME_VOICE_DISPLAY_STATE: RealtimeVoiceDisplayState = {
  turns: [],
};

function codePointPrefix(text: string, count: number): string {
  if (count <= 0 || !text) return "";
  return Array.from(text).slice(0, count).join("");
}

function revealTargetFromExisting(
  target: string,
  existing: RealtimeVoiceDisplayTurn | undefined,
): string {
  if (
    existing?.visibleText &&
    target.startsWith(existing.visibleText) &&
    existing.visibleText.length < target.length
  ) {
    return existing.visibleText;
  }
  return codePointPrefix(target, INITIAL_REVEAL_CODE_POINTS);
}

function revealStreamSnapshot(
  target: string,
  existing: RealtimeVoiceDisplayTurn | undefined,
): string {
  const prefix =
    existing?.visibleText && target.startsWith(existing.visibleText)
      ? existing.visibleText
      : "";
  return `${prefix}${codePointPrefix(
    target.slice(prefix.length),
    INITIAL_REVEAL_CODE_POINTS,
  )}`;
}

function advanceReveal(turn: RealtimeVoiceDisplayTurn, atMs: number) {
  const remaining = turn.displayMarkdown.slice(turn.visibleText.length);
  if (!remaining) {
    return {
      ...turn,
      visibleText: turn.displayMarkdown,
      phase: turn.playbackActive
        ? ("speaking" as const)
        : turn.serverOutcome
          ? ("complete" as const)
          : ("pending" as const),
      lastRevealAtMs: Math.max(turn.lastRevealAtMs, atMs),
      revealCarryCodePoints: 0,
    };
  }
  const elapsedMs = Math.max(0, atMs - turn.lastRevealAtMs);
  const availableCodePoints =
    turn.revealCarryCodePoints +
    (elapsedMs * VISUAL_REVEAL_CODE_POINTS_PER_SECOND) / 1_000;
  const budget = Math.floor(availableCodePoints);
  if (budget <= 0) {
    return {
      ...turn,
      lastRevealAtMs: Math.max(turn.lastRevealAtMs, atMs),
      revealCarryCodePoints: availableCodePoints,
    };
  }
  const nextText = `${turn.visibleText}${codePointPrefix(remaining, budget)}`;
  const complete = nextText.length >= turn.displayMarkdown.length;
  return {
    ...turn,
    visibleText: complete ? turn.displayMarkdown : nextText,
    phase: complete
      ? turn.playbackActive
        ? ("speaking" as const)
        : turn.serverOutcome
          ? ("complete" as const)
          : ("pending" as const)
      : ("revealing" as const),
    lastRevealAtMs: Math.max(turn.lastRevealAtMs, atMs),
    revealCarryCodePoints: complete ? 0 : availableCodePoints - budget,
  };
}

function mapTrace(
  state: RealtimeVoiceDisplayState,
  traceId: string,
  update: (turn: RealtimeVoiceDisplayTurn) => RealtimeVoiceDisplayTurn | null,
): RealtimeVoiceDisplayState {
  let changed = false;
  const turns = state.turns.flatMap((turn) => {
    if (turn.traceId !== traceId) return [turn];
    const next = update(turn);
    if (next !== turn) changed = true;
    return next ? [next] : [];
  });
  return changed ? { turns } : state;
}

function retainedInterruptedTurns(
  state: RealtimeVoiceDisplayState,
  currentTraceId: string,
): RealtimeVoiceDisplayTurn[] {
  return state.turns
    .filter(
      (turn) => turn.traceId !== currentTraceId && turn.phase === "interrupted",
    )
    .slice(-MAX_RETAINED_INTERRUPTED_TURNS + 1);
}

export function reduceRealtimeVoiceDisplay(
  state: RealtimeVoiceDisplayState,
  event: RealtimeVoiceDisplayEvent,
): RealtimeVoiceDisplayState {
  switch (event.type) {
    case "conversation_changed":
      return EMPTY_REALTIME_VOICE_DISPLAY_STATE;
    case "stream": {
      const existing = state.turns.find(
        (turn) => turn.traceId === event.traceId,
      );
      if (existing?.phase === "interrupted") return state;
      const visibleText = revealStreamSnapshot(event.text, existing);
      const needsReveal = visibleText.length < event.text.length;
      const turn: RealtimeVoiceDisplayTurn = existing
        ? {
            ...existing,
            displayMarkdown: event.text,
            visibleText,
            phase: needsReveal
              ? "revealing"
              : existing.phase === "speaking"
                ? "speaking"
                : "streaming",
            lastRevealAtMs: event.atMs,
            revealCarryCodePoints: 0,
          }
        : {
            traceId: event.traceId,
            displayMarkdown: event.text,
            speechText: null,
            displayTruncated: false,
            createdAtMs: event.atMs,
            visibleText,
            phase: needsReveal ? "revealing" : "streaming",
            lastRevealAtMs: event.atMs,
            revealCarryCodePoints: 0,
            playbackActive: false,
          };
      return {
        turns: [...retainedInterruptedTurns(state, event.traceId), turn],
      };
    }
    case "output": {
      const existing = state.turns.find(
        (turn) => turn.traceId === event.traceId,
      );
      if (existing?.phase === "interrupted") {
        return mapTrace(state, event.traceId, (turn) => ({
          ...turn,
          ...(event.messageId ? { messageId: event.messageId } : {}),
          displayMarkdown: event.displayMarkdown,
          speechText: event.speechText,
          displayTruncated: event.displayTruncated,
        }));
      }
      const visibleText = revealTargetFromExisting(
        event.displayMarkdown,
        existing,
      );
      const needsReveal = visibleText.length < event.displayMarkdown.length;
      const turn: RealtimeVoiceDisplayTurn = existing
        ? {
            ...existing,
            ...(event.messageId ? { messageId: event.messageId } : {}),
            displayMarkdown: event.displayMarkdown,
            speechText: event.speechText,
            displayTruncated: event.displayTruncated,
            visibleText,
            phase: needsReveal
              ? "revealing"
              : existing.phase === "speaking"
                ? "speaking"
                : "pending",
            lastRevealAtMs: event.atMs,
            revealCarryCodePoints: 0,
          }
        : {
            traceId: event.traceId,
            ...(event.messageId ? { messageId: event.messageId } : {}),
            displayMarkdown: event.displayMarkdown,
            speechText: event.speechText,
            displayTruncated: event.displayTruncated,
            createdAtMs: event.atMs,
            visibleText,
            phase: needsReveal ? "revealing" : "pending",
            lastRevealAtMs: event.atMs,
            revealCarryCodePoints: 0,
            playbackActive: false,
          };
      return {
        turns: [...retainedInterruptedTurns(state, event.traceId), turn],
      };
    }
    case "tick": {
      let changed = false;
      const turns = state.turns.map((turn) => {
        if (turn.phase !== "revealing") return turn;
        changed = true;
        return advanceReveal(turn, event.atMs);
      });
      return changed ? { turns } : state;
    }
    case "speaking_start":
      return mapTrace(state, event.traceId, (turn) =>
        turn.phase === "interrupted"
          ? turn
          : {
              ...turn,
              playbackActive: true,
              phase: turn.phase === "revealing" ? "revealing" : "speaking",
            },
      );
    case "playback_active":
      return mapTrace(state, event.traceId, (turn) =>
        turn.phase === "interrupted"
          ? turn
          : {
              ...turn,
              playbackActive: true,
              phase: turn.phase === "revealing" ? "revealing" : "speaking",
            },
      );
    case "playback_drained":
      return mapTrace(state, event.traceId, (turn) => {
        if (turn.phase === "interrupted") {
          return turn.playbackActive
            ? { ...turn, playbackActive: false }
            : turn;
        }
        if (turn.serverOutcome === "spoken") {
          return {
            ...turn,
            playbackActive: false,
            visibleText: turn.displayMarkdown,
            phase: "complete",
            lastRevealAtMs: Math.max(turn.lastRevealAtMs, event.atMs),
            revealCarryCodePoints: 0,
          };
        }
        return {
          ...turn,
          playbackActive: false,
          phase: turn.phase === "speaking" ? "pending" : turn.phase,
        };
      });
    case "user_speech": {
      for (let index = state.turns.length - 1; index >= 0; index -= 1) {
        const turn = state.turns[index];
        if (
          turn.phase === "complete" ||
          turn.phase === "interrupted" ||
          turn.serverOutcome === "displayed" ||
          turn.serverOutcome === "no_response" ||
          turn.serverOutcome === "error" ||
          turn.serverOutcome === "stopped"
        ) {
          continue;
        }
        const turns = [...state.turns];
        turns[index] = {
          ...turn,
          playbackActive: false,
          phase: "interrupted",
          lastRevealAtMs: Math.max(turn.lastRevealAtMs, event.atMs),
          revealCarryCodePoints: 0,
        };
        return { turns };
      }
      return state;
    }
    case "interrupted":
      return mapTrace(state, event.traceId, (turn) =>
        turn.phase === "interrupted"
          ? turn
          : {
              ...turn,
              playbackActive: false,
              phase: "interrupted",
              lastRevealAtMs: Math.max(turn.lastRevealAtMs, event.atMs),
              revealCarryCodePoints: 0,
            },
      );
    case "turn_end":
      return mapTrace(state, event.traceId, (turn) => {
        if (turn.phase === "interrupted") return turn;
        if (event.outcome === "spoken" && turn.playbackActive) {
          return {
            ...turn,
            serverOutcome: event.outcome,
            phase: turn.phase === "revealing" ? "revealing" : "speaking",
          };
        }
        return {
          ...turn,
          serverOutcome: event.outcome,
          playbackActive: false,
          visibleText: turn.displayMarkdown,
          phase: "complete",
          lastRevealAtMs: Math.max(turn.lastRevealAtMs, event.atMs),
        };
      });
  }
}

export function realtimeVoiceDisplayIsAnimating(
  state: RealtimeVoiceDisplayState,
): boolean {
  return state.turns.some((turn) => turn.phase === "revealing");
}

/** Replace exact canonical rows while a voice caption is active or interrupted. */
export function projectRealtimeVoiceDisplayMessages(
  messages: readonly ShellMessage[],
  state: RealtimeVoiceDisplayState,
): ShellMessage[] {
  if (state.turns.length === 0) return [...messages];
  const unmatched = new Map(state.turns.map((turn) => [turn.traceId, turn]));
  const fallbackIndexByTrace = new Map<string, number>();
  const claimedFallbackIndexes = new Set<number>();
  for (const turn of state.turns) {
    if (turn.messageId) continue;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      const inFlightPrefix =
        turn.phase === "streaming" ||
        turn.phase === "revealing" ||
        turn.phase === "pending" ||
        turn.phase === "speaking" ||
        turn.phase === "interrupted";
      const matches = inFlightPrefix
        ? Boolean(turn.visibleText) &&
          message?.content.startsWith(turn.visibleText)
        : turn.displayTruncated
          ? message?.content.startsWith(turn.displayMarkdown)
          : message?.content === turn.displayMarkdown;
      if (
        claimedFallbackIndexes.has(index) ||
        message?.role !== "assistant" ||
        !matches
      ) {
        continue;
      }
      fallbackIndexByTrace.set(turn.traceId, index);
      claimedFallbackIndexes.add(index);
      break;
    }
  }
  const projected = messages.map((message, messageIndex) => {
    if (message.role !== "assistant") return message;
    const turn = [...unmatched.values()].find(
      (candidate) =>
        candidate.messageId === message.id ||
        (!candidate.messageId &&
          fallbackIndexByTrace.get(candidate.traceId) === messageIndex),
    );
    if (!turn) return message;
    unmatched.delete(turn.traceId);
    return {
      ...message,
      content: turn.visibleText,
      interrupted: turn.phase === "interrupted",
    };
  });
  for (const turn of unmatched.values()) {
    projected.push({
      id: `voice-display:${turn.traceId}`,
      role: "assistant",
      content: turn.visibleText,
      createdAt: turn.createdAtMs,
      source: "realtime-voice",
      interrupted: turn.phase === "interrupted",
    });
  }
  return projected;
}
