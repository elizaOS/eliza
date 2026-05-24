import * as React from "react";

import { useApp } from "../../state";
import {
  createVoiceCapture,
  type VoiceCaptureHandle,
  type VoiceCaptureState,
} from "../../voice/voice-capture-factory";
import type { ShellMessage, ShellPhase } from "./shell-state";

export interface ShellController {
  phase: ShellPhase;
  messages: readonly ShellMessage[];
  canSend: boolean;
  recording: boolean;
  /** Visual mode for the waveform visualizer. */
  waveformMode: "idle" | "listening" | "responding";
  open: () => void;
  close: () => void;
  send: (text: string) => void;
  toggleRecording: () => void;
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
  const [isOpen, setIsOpen] = React.useState(false);
  const [recording, setRecording] = React.useState(false);
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
    }));
  }, [conversationMessages]);

  const send = React.useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      void sendChatText(trimmed);
    },
    [sendChatText],
  );

  const stopCapture = React.useCallback(() => {
    const handle = captureRef.current;
    captureRef.current = null;
    if (handle) {
      void handle.stop().catch(() => {});
      handle.dispose();
    }
    setRecording(false);
  }, []);

  const startCapture = React.useCallback(() => {
    if (captureRef.current) return;
    const handle = createVoiceCapture({
      onTranscript: (segment) => {
        if (!segment.final) return;
        const text = segment.text.trim();
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
    void handle.start().catch(() => {
      captureRef.current = null;
      setRecording(false);
    });
  }, [send]);

  const toggleRecording = React.useCallback(() => {
    if (recording) stopCapture();
    else startCapture();
  }, [recording, startCapture, stopCapture]);

  React.useEffect(() => stopCapture, [stopCapture]);

  const open = React.useCallback(() => {
    if (ready) setIsOpen(true);
  }, [ready]);
  const close = React.useCallback(() => {
    setIsOpen(false);
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

  // Allow text/voice submission whenever the agent is reachable and not
  // mid-response. Mirrors the ChatView composer gate.
  const canSend = ready && !chatSending && agentStatus?.state !== "stopped";

  return {
    phase,
    messages,
    canSend,
    recording,
    waveformMode,
    open,
    close,
    send,
    toggleRecording,
  };
}
