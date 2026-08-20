/**
 * Tracks whether a first-run completion edge belongs to a chat that actually
 * mounted. The shell keeps this state above runtime-target overlay remounts so
 * a genuine onboarding transcript can still reopen at the full detent.
 */

export interface FirstRunChatReleaseState {
  observedIncomplete: boolean;
  mountedWhileIncomplete: boolean;
  releasePending: boolean;
}

export function createFirstRunChatReleaseState(
  firstRunComplete: boolean | null,
): FirstRunChatReleaseState {
  return {
    observedIncomplete: firstRunComplete === false,
    mountedWhileIncomplete: false,
    releasePending: false,
  };
}

/** Records the only event allowed to authorize a retained full-detent release. */
export function recordMountedFirstRunChat(
  state: FirstRunChatReleaseState,
): FirstRunChatReleaseState {
  if (!state.observedIncomplete || state.mountedWhileIncomplete) return state;
  return { ...state, mountedWhileIncomplete: true };
}

/** Advances persisted first-run state without treating startup probes as UI. */
export function observeFirstRunCompletion(
  state: FirstRunChatReleaseState,
  firstRunComplete: boolean | null,
): FirstRunChatReleaseState {
  if (firstRunComplete === false) {
    if (state.observedIncomplete) return state;
    return { ...state, observedIncomplete: true };
  }
  if (firstRunComplete !== true || !state.observedIncomplete) return state;
  return {
    observedIncomplete: false,
    mountedWhileIncomplete: false,
    releasePending: state.releasePending || state.mountedWhileIncomplete,
  };
}

export function acknowledgeFirstRunChatRelease(
  state: FirstRunChatReleaseState,
): FirstRunChatReleaseState {
  return state.releasePending ? { ...state, releasePending: false } : state;
}
