import * as React from "react";

import type { HomeModelStatus } from "../../services/local-inference/home-model-status";
import { useApp } from "../../state";
import {
  createVoiceCapture,
  type VoiceCaptureHandle,
  type VoiceCaptureState,
} from "../../voice/voice-capture-factory";
import { useHomeModelStatus } from "../local-inference/useHomeModelStatus";
import type { ShellMessage, ShellPhase } from "./shell-state";

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
  send: (text: string) => void;
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
  } = app;

  const ready = startupCoordinator.phase === "ready";
  const modelStatus = useHomeModelStatus();
  const [isOpen, setIsOpen] = React.useState(false);
  const [recording, setRecording] = React.useState(false);
  const [muted, setMuted] = React.useState(false);
  const [transcript, setTranscript] = React.useState("");
  const [analyser, setAnalyser] = React.useState<AnalyserNode | null>(null);
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

  const pendingSendsRef = React.useRef<string[]>([]);

  const send = React.useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      if (!ready) {
        // Agent still booting — queue and flush on ready instead of dropping.
        pendingSendsRef.current.push(trimmed);
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
    for (const text of queued) {
      void sendChatText(text);
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
    const handle = createVoiceCapture({
      onTranscript: (segment) => {
        const text = segment.text.trim();
        if (!segment.final) {
          // Surface the interim best-guess as live transcription.
          setTranscript(text);
          return;
        }
        setTranscript("");
        if (text) send(text);
      },
      onStateChange: (state: VoiceCaptureState) => {
        if (state === "error" || state === "stopped" || state === "idle") {
          setRecording(false);
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

  const open = React.useCallback(() => {
    setIsOpen(true);
  }, []);
  const close = React.useCallback(() => {
    setIsOpen(false);
    setMuted(false);
    if (captureRef.current) stopCapture();
  }, [stopCapture]);

  const phase: ShellPhase = !ready
    ? "booting"
    : recording
      ? "listening"
      : chatSending
        ? "responding"
        : !isOpen
          ? "idle"
          : "summoned";

  const waveformMode =
    phase === "listening"
      ? "listening"
      : phase === "responding"
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
  };
}
