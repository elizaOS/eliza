/**
 * Tracks whether a first-run completion edge belongs to onboarding that was
 * visibly mounted. The shell keeps this state above runtime-target overlay
 * remounts so a genuine onboarding transcript can still reopen at FULL.
 */

import type { StartupPhaseValue } from "./startup-coordinator";

export interface FirstRunChatReleaseState {
  incompleteActive: boolean;
  incompleteEpoch: number;
  authoritativeEpoch: number | null;
  overlayMountedEpoch: number | null;
  transcriptMountedEpoch: number | null;
  releasePending: boolean;
}

export function createFirstRunChatReleaseState(
  firstRunComplete: boolean | null,
  startupPhase: StartupPhaseValue,
): FirstRunChatReleaseState {
  const incompleteActive = firstRunComplete === false;
  const incompleteEpoch = incompleteActive ? 1 : 0;
  const authoritativeEpoch =
    incompleteActive && startupPhase === "first-run-required"
      ? incompleteEpoch
      : null;
  return {
    incompleteActive,
    incompleteEpoch,
    authoritativeEpoch,
    overlayMountedEpoch: null,
    transcriptMountedEpoch: null,
    releasePending: false,
  };
}

/** Records a committed overlay mount during the current incomplete epoch. */
export function recordMountedFirstRunOverlay(
  state: FirstRunChatReleaseState,
  epoch: number,
): FirstRunChatReleaseState {
  if (
    !state.incompleteActive ||
    epoch !== state.incompleteEpoch ||
    state.overlayMountedEpoch === epoch
  ) {
    return state;
  }
  return { ...state, overlayMountedEpoch: epoch };
}

/** Records that the mounted conductor produced a real first-run transcript. */
export function recordMountedFirstRunTranscript(
  state: FirstRunChatReleaseState,
  epoch: number,
): FirstRunChatReleaseState {
  if (
    !state.incompleteActive ||
    epoch !== state.incompleteEpoch ||
    state.transcriptMountedEpoch === epoch
  ) {
    return state;
  }
  return { ...state, transcriptMountedEpoch: epoch };
}

/** Advances persisted first-run state without treating false probes as UI. */
export function observeFirstRunCompletion(
  state: FirstRunChatReleaseState,
  firstRunComplete: boolean | null,
  startupPhase: StartupPhaseValue,
): FirstRunChatReleaseState {
  if (firstRunComplete === false) {
    if (!state.incompleteActive) {
      const incompleteEpoch = state.incompleteEpoch + 1;
      const authoritativeEpoch =
        startupPhase === "first-run-required" ? incompleteEpoch : null;
      return {
        incompleteActive: true,
        incompleteEpoch,
        authoritativeEpoch,
        overlayMountedEpoch: null,
        transcriptMountedEpoch: null,
        releasePending: false,
      };
    }
    if (
      startupPhase === "first-run-required" &&
      state.authoritativeEpoch !== state.incompleteEpoch
    ) {
      return {
        ...state,
        authoritativeEpoch: state.incompleteEpoch,
      };
    }
    return state.releasePending ? { ...state, releasePending: false } : state;
  }
  if (firstRunComplete !== true || !state.incompleteActive) return state;
  const releaseAuthorized =
    state.authoritativeEpoch === state.incompleteEpoch &&
    state.overlayMountedEpoch === state.incompleteEpoch &&
    state.transcriptMountedEpoch === state.incompleteEpoch;
  return {
    incompleteActive: false,
    incompleteEpoch: state.incompleteEpoch,
    authoritativeEpoch: null,
    overlayMountedEpoch: null,
    transcriptMountedEpoch: null,
    releasePending: state.releasePending || releaseAuthorized,
  };
}

export function acknowledgeFirstRunChatRelease(
  state: FirstRunChatReleaseState,
): FirstRunChatReleaseState {
  return state.releasePending ? { ...state, releasePending: false } : state;
}
