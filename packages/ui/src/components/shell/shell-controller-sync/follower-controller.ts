/**
 * Builds a `ShellController` for a follower window out of the owner's snapshot
 * plus a command dispatcher (#16442). This is what lets a detached window render
 * the shared chat/voice surface with the EXISTING overlay components, unchanged,
 * while never instantiating a second engine: reads come from the snapshot, and
 * every imperative method forwards a typed command to the owner.
 *
 * Follower-local invariants encoded here:
 *  - `analyser` is null — a follower owns no mic, so it shows no live waveform.
 *  - `setDictationSink` / `setTranscriptSessionSink` are no-ops — dictation and
 *    transcript capture land in the OWNER window, which runs the recorder.
 *  - `recheckMicPermission` forwards the recheck and resolves with the currently
 *    known permission; the refreshed value arrives in the next snapshot.
 * A dispatch that fails (owner gone / timed out / version-mismatch) is routed to
 * `onCommandError` — a visible failure, never a silent no-op.
 */
import type { MicrophonePermissionState } from "../../../voice/local-asr-capture";
import type { ConversationNav } from "../conversation-nav";
import type { ShellController } from "../useShellController";
import type { ShellControllerCommand } from "./protocol";
import type { ShellControllerSnapshot } from "./snapshot";

export interface FollowerControllerDeps {
  snapshot: ShellControllerSnapshot;
  dispatch: (command: ShellControllerCommand) => Promise<void>;
  onCommandError: (command: ShellControllerCommand, error: unknown) => void;
}

export function buildFollowerController(
  deps: FollowerControllerDeps,
): ShellController {
  const { snapshot, dispatch, onCommandError } = deps;
  const fire = (command: ShellControllerCommand): void => {
    void dispatch(command).catch((error: unknown) =>
      onCommandError(command, error),
    );
  };

  const conversationNav: ConversationNav = {
    hasPrev: snapshot.conversationNav.hasPrev,
    hasNext: snapshot.conversationNav.hasNext,
    activeId: snapshot.conversationNav.activeId,
    index: snapshot.conversationNav.index,
    goPrev: () => fire({ kind: "navConversation", direction: "prev" }),
    goNext: () => fire({ kind: "navConversation", direction: "next" }),
  };

  return {
    phase: snapshot.phase,
    bootProgressSignal: snapshot.bootProgressSignal,
    responding: snapshot.responding,
    turnStatus: snapshot.turnStatus,
    messages: snapshot.messages,
    canSend: snapshot.canSend,
    modelStatus: snapshot.modelStatus,
    recording: snapshot.recording,
    waveformMode: snapshot.waveformMode,
    analyser: null,
    open: () => fire({ kind: "open" }),
    close: () => fire({ kind: "close" }),
    isOpen: snapshot.isOpen,
    send: (text, options) =>
      fire({
        kind: "send",
        text,
        ...(options?.channelType ? { channelType: options.channelType } : {}),
        ...(options?.images ? { images: options.images } : {}),
        ...(options?.metadata ? { metadata: options.metadata } : {}),
      }),
    captureVision: () => fire({ kind: "captureVision" }),
    visionCapturing: snapshot.visionCapturing,
    toggleRecording: () => fire({ kind: "toggleRecording" }),
    startRecording: (intent) => fire({ kind: "startRecording", ...(intent ? { intent } : {}) }),
    stopRecording: () => fire({ kind: "stopRecording" }),
    handsFree: snapshot.handsFree,
    toggleHandsFree: () => fire({ kind: "toggleHandsFree" }),
    micPermission: snapshot.micPermission,
    recheckMicPermission: (): Promise<MicrophonePermissionState> => {
      fire({ kind: "recheckMicPermission" });
      return Promise.resolve(snapshot.micPermission);
    },
    transcriptionMode: snapshot.transcriptionMode,
    toggleTranscriptionMode: () => fire({ kind: "toggleTranscriptionMode" }),
    stopTranscriptionAndMic: () => fire({ kind: "stopTranscriptionAndMic" }),
    setDictationSink: () => {},
    setTranscriptSessionSink: () => {},
    setComposerHasDraft: (hasDraft) =>
      fire({ kind: "setComposerHasDraft", hasDraft }),
    transcript: snapshot.transcript,
    speaking: snapshot.speaking,
    speak: (text) => fire({ kind: "speak", text }),
    stopSpeaking: () => fire({ kind: "stopSpeaking" }),
    agentVoiceMuted: snapshot.agentVoiceMuted,
    toggleAgentVoiceMute: () => fire({ kind: "toggleAgentVoiceMute" }),
    needsAudioUnlock: snapshot.needsAudioUnlock,
    unlockAudio: () => fire({ kind: "unlockAudio" }),
    clearConversation: () => fire({ kind: "clearConversation" }),
    openSettings: () => fire({ kind: "openSettings" }),
    navigateHome: () => fire({ kind: "navigateHome" }),
    currentTab: snapshot.currentTab,
    stop: () => fire({ kind: "stop" }),
    conversationNav,
    conversationLoading: snapshot.conversationLoading,
    noProviderConfigured: snapshot.noProviderConfigured,
  };
}
