/** Defines when the chat composer mic owns realtime turn interruption. */

export interface RealtimeMicTapState {
  realtimeActive: boolean;
  agentSpeaking: boolean;
  status: string;
}

/** A live realtime turn can be interrupted before or after audio begins. */
export function shouldBargeInFromMicTap(state: RealtimeMicTapState): boolean {
  return (
    state.realtimeActive && (state.agentSpeaking || state.status === "thinking")
  );
}
