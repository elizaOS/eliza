import * as React from "react";

import type { ImageAttachment } from "../../api/client-types-chat";
import type { HomeModelStatus } from "../../services/local-inference/home-model-status";
import { useApp } from "../../state";
import { loadVadAutoStop } from "../../state/persistence";
import { deriveAgentReady } from "../../state/types";
import {
  createVoiceCapture,
  type VoiceCaptureHandle,
  type VoiceCaptureState,
} from "../../voice/voice-capture-factory";
import { useHomeModelStatus } from "../local-inference/useHomeModelStatus";
import type { ShellMessage, ShellPhase } from "./shell-state";
import { useShellVoiceOutput } from "./useShellVoiceOutput";

/** How a voice capture turn is consumed when it produces a final transcript. */
export type CaptureIntent = "converse" | "dictate";

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
  /** Begin capture unconditionally. Used by push-to-talk press. `"dictate"`
   *  routes the final transcript to the dictation sink (composer draft) and does
   *  not send; `"converse"` (default) sends a VOICE_DM so the reply is spoken. */
  startRecording: (intent?: CaptureIntent) => void;
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
  /** True when autoplay policy blocked playback and a tap is needed to hear it. */
  needsAudioUnlock: boolean;
  /** Resume audio output in response to a user gesture (enable sound). */
  unlockAudio: () => void;
  /** True while the hands-free voice conversation loop is active — the mic
   *  re-opens automatically after each spoken reply. Toggled by a tap on the mic. */
  handsFree: boolean;
  /** Toggle the hands-free conversation loop (mic ↔ spoken reply ↔ mic). */
  toggleHandsFree: () => void;
  /** Register where push-to-talk dictation drops its final transcript (the
   *  overlay wires this to its composer draft). Pass null to clear. */
  setDictationSink: (sink: ((text: string) => void) | null) => void;
  /** DEV-only: clear the conversation and start a fresh, greeted one. */
  clearConversation: () => void;
  /** Jump to Settings (where ProviderSwitcher lives) — used by the chat's
   *  `no_provider` failure gate to let the user wire a provider in one tap. */
  openSettings: () => void;
  /** Stop an in-flight reply stream (the composer's stop control). */
  stop: () => void;
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
    conversationMessages,
    chatSending,
    sendChatText,
    agentStatus,
    uiLanguage,
    elizaCloudVoiceProxyAvailable,
    handleNewConversation,
    setTab,
    handleChatStop,
  } = app;

  // Jump to Settings from the chat's no_provider gate. Stable identity.
  const openSettings = React.useCallback(() => setTab("settings"), [setTab]);

  // DEV-only debug affordance: drop the current conversation and start a fresh,
  // greeted one (handleNewConversation resets draft state + creates a new
  // conversation with a bootstrap greeting).
  const clearConversation = React.useCallback(() => {
    void handleNewConversation();
  }, [handleNewConversation]);

  // "Ready" here means the agent's FIRST-TURN CAPABILITY is online (it can
  // answer) — NOT that the startup coordinator finished hydrating. The shell now
  // mounts early (isShellPaintable) while the agent warms up; the composer stays
  // interactive but queues sends until this flips, then flushes — so first-turn
  // capability fades in behind a live UI. Server-authoritative via
  // agentStatus.canRespond (falls back to running+model on older agents).
  const ready = deriveAgentReady(agentStatus);
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
  // Hands-free conversation loop (tap the mic): the mic re-opens after each
  // spoken reply. A ref mirrors the state so the debounced re-listen timer reads
  // the live value at fire time.
  const [handsFree, setHandsFree] = React.useState(false);
  const handsFreeRef = React.useRef(false);
  handsFreeRef.current = handsFree;
  // Push-to-talk dictation routes its final transcript here (the overlay wires
  // this to its composer draft) instead of sending it.
  const onDictatedTextRef = React.useRef<((text: string) => void) | null>(null);
  const setDictationSink = React.useCallback(
    (sink: ((text: string) => void) | null) => {
      onDictatedTextRef.current = sink;
    },
    [],
  );

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
      // Send immediately even while the agent is still warming up: sendChatText
      // renders the optimistic user bubble + typing indicator right away, and the
      // server HOLDS the turn through the warming window (runtime-ready gate),
      // streaming the reply the instant first-turn capability comes online —
      // rather than queueing the message invisibly.
      if (options) {
        void sendChatText(trimmed, options);
        return;
      }
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
    setAnalyser(null);
    setRecording(false);
    setTranscript("");
  }, []);

  const startCapture = React.useCallback(
    (intent?: CaptureIntent) => {
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
            if (intent === "dictate") {
              // Push-to-talk dictation: hand the text to the composer draft —
              // don't send, and leave lastTurnVoice false so no reply is spoken.
              onDictatedTextRef.current?.(text);
            } else {
              send(text, {
                channelType: "VOICE_DM",
                metadata: {
                  voiceSource: segment.backend,
                },
              });
            }
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
    },
    [ready, send],
  );

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
    setHandsFree(false);
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

  // Tap-to-talk: toggle a hands-free conversation. Enabling unlocks audio (the
  // tap is the gesture) and opens the mic in "converse" mode; disabling stops
  // both the mic and any in-flight reply.
  const toggleHandsFree = React.useCallback(() => {
    setHandsFree((on) => {
      const next = !on;
      if (next) {
        setIsOpen(true);
        voiceOutput.unlockAudio();
        startCapture("converse");
      } else {
        if (captureRef.current) stopCapture();
        voiceOutput.stopSpeaking();
      }
      return next;
    });
  }, [startCapture, stopCapture, voiceOutput]);

  // Hands-free loop: once a spoken reply finishes (and nothing is recording or
  // mid-send), re-open the mic so the conversation continues without a tap. The
  // 250ms debounce + live re-check via handsFreeRef guard against double-start.
  React.useEffect(() => {
    if (!handsFree || !ready) return;
    if (recording || captureRef.current) return;
    if (chatSending || voiceOutput.speaking) return;
    const timer = window.setTimeout(() => {
      if (
        handsFreeRef.current &&
        !captureRef.current &&
        !chatSending &&
        !voiceOutput.speaking
      ) {
        startCapture("converse");
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [
    handsFree,
    ready,
    recording,
    chatSending,
    voiceOutput.speaking,
    startCapture,
  ]);

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
  // /chat tab, so a missing/loading local model must still submit the send.
  // The server returns a failureKind gate ("Connect a provider") that
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
    handsFree,
    toggleHandsFree,
    setDictationSink,
    muted,
    toggleMute,
    transcript,
    speaking: voiceOutput.speaking,
    agentVoiceMuted: voiceOutput.agentVoiceMuted,
    toggleAgentVoiceMute: voiceOutput.toggleAgentVoiceMute,
    needsAudioUnlock: voiceOutput.needsAudioUnlock,
    unlockAudio: voiceOutput.unlockAudio,
    clearConversation,
    openSettings,
    stop: handleChatStop,
  };
}
