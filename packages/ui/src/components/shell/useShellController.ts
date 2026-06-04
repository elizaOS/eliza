import * as React from "react";

import type { ImageAttachment } from "../../api/client-types-chat";
import type { HomeModelStatus } from "../../services/local-inference/home-model-status";
import { useApp } from "../../state";
import { loadVadAutoStop } from "../../state/persistence";
import {
  createVoiceCapture,
  type VoiceCaptureHandle,
  type VoiceCaptureState,
} from "../../voice/voice-capture-factory";
import { useHomeModelStatus } from "../local-inference/useHomeModelStatus";
import type { ShellMessage, ShellPhase } from "./shell-state";
import { useShellVoiceOutput } from "./useShellVoiceOutput";

export interface ShellController {
  phase: ShellPhase;
  messages: readonly ShellMessage[];
  canSend: boolean;
  /** Local text-model readiness for the home surface. Gates send while not ready. */
  modelStatus: HomeModelStatus;
  recording: boolean;
  /** Visual mode for the waveform visualizer. */
  waveformMode: "idle" | "listening" | "responding";
  /** Live mic analyser while recording, for the voice avatar. `null` otherwise. */
  analyser: AnalyserNode | null;
  open: () => void;
  close: () => void;
  /** True while the one global chat/voice session is open. The hook other views
   *  (e.g. the homescreen apps + buttons) read to react to it. */
  isOpen: boolean;
  send: (
    text: string,
    options?: {
      channelType?: "DM" | "VOICE_DM";
      images?: ImageAttachment[];
      metadata?: Record<string, unknown>;
    },
  ) => void;
  /** Toggle continuous ("open voice") capture. Used by a quick tap on the mic. */
  toggleRecording: () => void;
  /** Begin capture unconditionally. Used by push-to-talk press. */
  startRecording: () => void;
  /** End capture unconditionally. Used by push-to-talk release. */
  stopRecording: () => void;
  /** True while the mic is muted (paused) but the voice session stays open. */
  muted: boolean;
  /** Pause/resume the mic without ending the voice session. */
  toggleMute: () => void;
  /** Live interim transcription of the current utterance ("" when none). */
  transcript: string;
  /** True while an assistant reply is being spoken aloud (voice output). */
  speaking: boolean;
  /** True while assistant voice output is muted by the user. */
  agentVoiceMuted: boolean;
  /** Mute/unmute assistant voice output. Muting stops any in-flight speech. */
  toggleAgentVoiceMute: () => void;
  /** DEV-only: clear the conversation and start a fresh, greeted one. */
  clearConversation: () => void;
}

/**
 * Bridges the shell foundation (HomePill + AssistantOverlay + ChatSurface) to
 * the real agent message flow exposed by {@link useApp}. Replaces the v1
 * mocked echo: text submitted here goes through `sendChatText`, the same path
 * the main ChatView uses, so messages actually send and stream back.
 *
 * Voice capture uses the hook-free {@link createVoiceCapture} factory (the
 * standalone-surface path). A final transcript is submitted through the same
 * `send` handler. The phase drives the pill glow and waveform mode.
 */
export function useShellController(): ShellController {
  const app = useApp();
  const {
    startupCoordinator,
    conversationMessages,
    chatSending,
    sendChatText,
    agentStatus,
    uiLanguage,
    elizaCloudVoiceProxyAvailable,
    handleNewConversation,
  } = app;

  // DEV-only debug affordance: drop the current conversation and start a fresh,
  // greeted one (handleNewConversation resets draft state + creates a new
  // conversation with a bootstrap greeting).
  const clearConversation = React.useCallback(() => {
    void handleNewConversation();
  }, [handleNewConversation]);

  const ready = startupCoordinator.phase === "ready";
  const modelStatus = useHomeModelStatus();
  const [isOpen, setIsOpen] = React.useState(false);
  const [recording, setRecording] = React.useState(false);
  const [muted, setMuted] = React.useState(false);
  const [transcript, setTranscript] = React.useState("");
  const [analyser, setAnalyser] = React.useState<AnalyserNode | null>(null);
  // True when the most recent user turn was voice-originated (VOICE_DM). Gates
  // whether the agent's reply is spoken back — typed turns stay silent.
  const [lastTurnVoice, setLastTurnVoice] = React.useState(false);
  const captureRef = React.useRef<VoiceCaptureHandle | null>(null);

  const messages = React.useMemo<ShellMessage[]>(() => {
    const source = Array.isArray(conversationMessages)
      ? conversationMessages
      : [];
    return source.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.text,
      createdAt: message.timestamp,
      failureKind: message.failureKind,
    }));
  }, [conversationMessages]);

  const pendingSendsRef = React.useRef<
    Array<{
      text: string;
      options?: {
        channelType?: "DM" | "VOICE_DM";
        images?: ImageAttachment[];
        metadata?: Record<string, unknown>;
      };
    }>
  >([]);

  const send = React.useCallback(
    (
      text: string,
      options?: {
        channelType?: "DM" | "VOICE_DM";
        images?: ImageAttachment[];
        metadata?: Record<string, unknown>;
      },
    ) => {
      const trimmed = text.trim();
      // An image-only turn is valid: only bail when there's neither text nor an
      // attachment to send.
      if (!trimmed && !options?.images?.length) return;
      // Record voice-ness of this turn so the reply is (or is not) spoken back.
      setLastTurnVoice(options?.channelType === "VOICE_DM");
      if (!ready) {
        // Agent still booting — queue and flush on ready instead of dropping.
        pendingSendsRef.current.push({ text: trimmed, options });
        return;
      }
      if (options) {
        void sendChatText(trimmed, options);
        return;
      }
      void sendChatText(trimmed);
    },
    [ready, sendChatText],
  );

  // Flush messages the user submitted while the agent was still booting.
  React.useEffect(() => {
    if (!ready) return;
    const queued = pendingSendsRef.current;
    if (queued.length === 0) return;
    pendingSendsRef.current = [];
    for (const { text, options } of queued) {
      if (options) {
        void sendChatText(text, options);
      } else {
        void sendChatText(text);
      }
    }
  }, [ready, sendChatText]);

  const stopCapture = React.useCallback(() => {
    const handle = captureRef.current;
    captureRef.current = null;
    if (handle) {
      void handle.stop().catch(() => {});
      handle.dispose();
    }
    setAnalyser(null);
    setRecording(false);
    setTranscript("");
  }, []);

  const startCapture = React.useCallback(() => {
    if (!ready) return;
    if (captureRef.current) return;
    // Read the user's VAD thresholds synchronously (local mirror of the
    // `messages.voice` setting) so end-of-turn silence detection honors the
    // configured sensitivity. Only consumed by the local-inference backend.
    const handle = createVoiceCapture({
      localAsrAutoStop: loadVadAutoStop(),
      onTranscript: (segment) => {
        const text = segment.text.trim();
        if (!segment.final) {
          // Surface the interim best-guess as live transcription.
          setTranscript(text);
          return;
        }
        setTranscript("");
        if (text) {
          send(text, {
            channelType: "VOICE_DM",
            metadata: {
              voiceSource: segment.backend,
            },
          });
        }
      },
      onStateChange: (state: VoiceCaptureState) => {
        if (state === "error" || state === "stopped" || state === "idle") {
          // Capture ended (clean stop, dispose, or error). Drop the handle and
          // analyser so the shell phase returns to idle/summoned and a later
          // startCapture is not blocked by a stale ref.
          if (captureRef.current === handle) captureRef.current = null;
          setAnalyser(null);
          setRecording(false);
          setTranscript("");
        }
      },
    });
    captureRef.current = handle;
    setRecording(true);
    handle
      .start()
      .then(() => {
        if (captureRef.current === handle) setAnalyser(handle.getAnalyser());
      })
      .catch(() => {
        captureRef.current = null;
        setAnalyser(null);
        setRecording(false);
      });
  }, [ready, send]);

  const toggleRecording = React.useCallback(() => {
    if (recording) stopCapture();
    else startCapture();
  }, [recording, startCapture, stopCapture]);

  // Mute = pause the mic but keep the voice session (overlay) open; unmute
  // resumes capture. Modeled as a stop/restart of the capture handle.
  const toggleMute = React.useCallback(() => {
    if (muted) {
      setMuted(false);
      startCapture();
    } else {
      setMuted(true);
      if (captureRef.current) stopCapture();
    }
  }, [muted, startCapture, stopCapture]);

  React.useEffect(() => stopCapture, [stopCapture]);

  React.useEffect(() => {
    if (!ready || recording || captureRef.current) return;
    let mode: string | null = null;
    try {
      mode = window.localStorage.getItem("eliza:voice:continuous-chat-mode");
    } catch {
      mode = null;
    }
    if (mode !== "always-on") return;
    setIsOpen(true);
    startCapture();
  }, [ready, recording, startCapture]);

  const open = React.useCallback(() => {
    setIsOpen(true);
  }, []);
  const close = React.useCallback(() => {
    setIsOpen(false);
    setMuted(false);
    if (captureRef.current) stopCapture();
  }, [stopCapture]);

  // `recording` (push-to-talk press or continuous capture) wins over an
  // in-flight response so the pill shows the red "listening" pulse the instant
  // the mic opens, even while the previous turn is still streaming (barge-in).
  // Stop/error clears `recording` (see startCapture/stopCapture), dropping the
  // phase back to responding → summoned → idle.
  const phase: ShellPhase = !ready
    ? "booting"
    : recording
      ? "listening"
      : chatSending
        ? "responding"
        : !isOpen
          ? "idle"
          : "summoned";

  const voiceOutput = useShellVoiceOutput({
    conversationMessages: Array.isArray(conversationMessages)
      ? conversationMessages
      : [],
    chatSending,
    recording,
    lastTurnVoice,
    uiLanguage,
    cloudConnected: elizaCloudVoiceProxyAvailable,
  });

  const waveformMode =
    phase === "listening"
      ? "listening"
      : phase === "responding" || voiceOutput.speaking
        ? "responding"
        : "idle";

  // Accept input while the agent is still booting; pre-ready sends queue (see
  // `send`) and flush on ready. Still block mid-response or when the agent is
  // stopped. This mirrors the canonical ChatView composer, which does NOT gate
  // on local text-model readiness: the overlay is the single chat input on the
  // /chat tab, so a missing/loading local model must not silently no-op the
  // send — the server returns a failureKind gate ("Connect a provider") that
  // the transcript renders, exactly as the in-view composer relied on.
  const canSend = !chatSending && agentStatus?.state !== "stopped";

  return {
    phase,
    messages,
    canSend,
    modelStatus,
    recording,
    waveformMode,
    analyser,
    open,
    close,
    isOpen,
    send,
    toggleRecording,
    startRecording: startCapture,
    stopRecording: stopCapture,
    muted,
    toggleMute,
    transcript,
    speaking: voiceOutput.speaking,
    agentVoiceMuted: voiceOutput.agentVoiceMuted,
    toggleAgentVoiceMute: voiceOutput.toggleAgentVoiceMute,
    clearConversation,
  };
}
