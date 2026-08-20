/**
 * Tracks whether a first-run completion edge belongs to onboarding that was
 * visibly mounted. The shell keeps this state above runtime-target overlay
 * remounts so a genuine onboarding transcript can still reopen at FULL.
 */

import type { StartupPhaseValue } from "./startup-coordinator";

export interface FirstRunChatReleaseState {
  observedIncomplete: boolean;
  overlayMountedWhileIncomplete: boolean;
  transcriptMountedWhileIncomplete: boolean;
  releasePending: boolean;
}

export function createFirstRunChatReleaseState(
  firstRunComplete: boolean | null,
  startupPhase: StartupPhaseValue,
): FirstRunChatReleaseState {
  return {
    observedIncomplete:
      firstRunComplete === false && startupPhase === "first-run-required",
    overlayMountedWhileIncomplete: false,
    transcriptMountedWhileIncomplete: false,
    releasePending: false,
  };
}

/** Records a committed overlay mount during an authoritative onboarding epoch. */
export function recordMountedFirstRunOverlay(
  state: FirstRunChatReleaseState,
): FirstRunChatReleaseState {
  if (!state.observedIncomplete || state.overlayMountedWhileIncomplete) {
    return state;
  }
  return { ...state, overlayMountedWhileIncomplete: true };
}

/** Records that the mounted conductor produced a real first-run transcript. */
export function recordMountedFirstRunTranscript(
  state: FirstRunChatReleaseState,
): FirstRunChatReleaseState {
  if (!state.observedIncomplete || state.transcriptMountedWhileIncomplete) {
    return state;
  }
  return { ...state, transcriptMountedWhileIncomplete: true };
}

/** Advances persisted first-run state without treating false probes as UI. */
export function observeFirstRunCompletion(
  state: FirstRunChatReleaseState,
  firstRunComplete: boolean | null,
  startupPhase: StartupPhaseValue,
): FirstRunChatReleaseState {
  if (firstRunComplete === false) {
    if (state.observedIncomplete) return state;
    if (startupPhase !== "first-run-required") {
      return state.releasePending ? { ...state, releasePending: false } : state;
    }
    // A new incomplete epoch invalidates an unconsumed release from the prior
    // epoch. Otherwise a reset that hides the overlay before it acknowledges
    // FULL can make a later probe-only false -> true transition reopen chat.
    return {
      observedIncomplete: true,
      overlayMountedWhileIncomplete: false,
      transcriptMountedWhileIncomplete: false,
      releasePending: false,
    };
  }
  if (firstRunComplete !== true || !state.observedIncomplete) return state;
  return {
    observedIncomplete: false,
    overlayMountedWhileIncomplete: false,
    transcriptMountedWhileIncomplete: false,
    releasePending:
      state.releasePending ||
      (state.overlayMountedWhileIncomplete &&
        state.transcriptMountedWhileIncomplete),
  };
}

export function acknowledgeFirstRunChatRelease(
  state: FirstRunChatReleaseState,
): FirstRunChatReleaseState {
  return state.releasePending ? { ...state, releasePending: false } : state;
}
