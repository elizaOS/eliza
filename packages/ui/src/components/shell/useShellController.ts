import type { TranscriptSegment } from "@elizaos/shared/transcripts";
import * as React from "react";
import type { ImageAttachment } from "../../api/client-types-chat";
import {
  VOICE_CONTROL_EVENT,
  type VoiceControlEventDetail,
} from "../../events";
import type { HomeModelStatus } from "../../services/local-inference/home-model-status";
import { useApp } from "../../state";
import {
  loadContinuousChatMode,
  loadVadAutoStop,
  saveContinuousChatMode,
} from "../../state/persistence";
import { deriveAgentReady } from "../../state/types";
import { TurnAggregator } from "../../voice/end-of-turn";
import { shouldRespondToVoiceTurn } from "../../voice/should-respond";
import { TranscriptSessionAccumulator } from "../../voice/transcript-session";
import {
  isTranscriptionExitPhrase,
  isTranscriptionStartPhrase,
  stripExitPhrase,
} from "../../voice/transcription-exit";
import {
  createVoiceCapture,
  type VoiceCaptureBackend,
  type VoiceCaptureHandle,
  type VoiceCaptureState,
} from "../../voice/voice-capture-factory";
import { buildVoiceTurnSignal } from "../../voice/voice-turn-signal";
import { useHomeModelStatus } from "../local-inference/useHomeModelStatus";
import type { ShellMessage, ShellPhase } from "./shell-state";
import { useShellVoiceOutput } from "./useShellVoiceOutput";

/** How a voice capture turn is consumed when it produces a final transcript.
 *  `"transcription"` records long-form: finals accumulate into ONE recording
 *  session (not per-utterance chat bubbles) and the agent stays quiet until an
 *  exit phrase, at which point the session becomes a Transcript record + a chat
 *  link-widget. */
export type CaptureIntent = "converse" | "dictate" | "transcription";

export interface ShellController {
  phase: ShellPhase;
  /** Raw "a reply is in flight" predicate — text streaming OR being spoken aloud.
   *  Unlike `phase === "responding"`, stays true after the mic opens (which flips
   *  phase to "listening"), so the composer reads one honest busy signal: send
   *  stays enabled (queue another turn) while voice input is gated. */
  responding: boolean;
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
  /** True while transcription mode is active — the mic records continuously into
   *  one recording session (the agent does not reply) until the user says an exit
   *  phrase ("exit transcription mode"), then the session becomes a Transcript. */
  transcriptionMode: boolean;
  /** Toggle transcription mode on/off. Enabling opens a long-running capture
   *  that suppresses replies; disabling stops it and resumes normal evaluation. */
  toggleTranscriptionMode: () => void;
  /** Register where push-to-talk dictation drops its final transcript (the
   *  overlay wires this to its composer draft). Pass null to clear. */
  setDictationSink: (sink: ((text: string) => void) | null) => void;
  /** Register where a completed transcription SESSION is delivered (its segments,
   *  the absolute session-start ms, and the concatenated session WAV when audio
   *  was retained). The overlay wires this to create the Transcript record (+
   *  audio) + drop a chat link-widget. Pass null to clear. */
  setTranscriptSessionSink: (
    sink:
      | ((
          segments: TranscriptSegment[],
          startedAtMs: number,
          audioWav: Uint8Array | null,
        ) => void)
      | null,
  ) => void;
  /** Tell the controller whether the composer holds a pending typed/dictated
   *  draft. While a draft exists the hands-free ("always-on") loop is paused so
   *  the mic isn't listening over the keyboard; clearing the draft (on send)
   *  resumes it — restoring the prior voice state without a re-tap. */
  setComposerHasDraft: (hasDraft: boolean) => void;
  /** DEV-only: clear the conversation and start a fresh, greeted one. */
  clearConversation: () => void;
  /** Jump to Settings (where ProviderSwitcher lives) — used by the chat's
   *  `no_provider` failure gate to let the user wire a provider in one tap. */
  openSettings: () => void;
  /** Return to the home dashboard (the /chat route). Drives the chat header's
   *  Home button, which is hidden while already on the home screen. */
  navigateHome?: () => void;
  /** The active app tab. Lets the chat header hide the Home button on the home
   *  screen ("chat") and the Settings button on the settings screen. */
  currentTab?: string;
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
  // Return to the home dashboard (the /chat route) from the chat header's Home
  // button. Stable identity.
  const navigateHome = React.useCallback(() => setTab("chat"), [setTab]);

  // DEV-only debug affordance: drop the current conversation and start a fresh,
  // greeted one (handleNewConversation resets draft state + creates a new
  // conversation with a bootstrap greeting).
  const clearConversation = React.useCallback(() => {
    // A fresh conversation's bootstrap greeting is NOT a reply to a voice turn —
    // clear the voice flag so the greeting isn't spoken aloud after a prior
    // voice session.
    setLastTurnVoice(false);
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
  const [transcript, setTranscript] = React.useState("");
  const [analyser, setAnalyser] = React.useState<AnalyserNode | null>(null);
  // True when the most recent user turn was voice-originated (VOICE_DM). Gates
  // whether the agent's reply is spoken back — typed turns stay silent.
  const [lastTurnVoice, setLastTurnVoice] = React.useState(false);
  const captureRef = React.useRef<VoiceCaptureHandle | null>(null);
  // Semantic end-of-turn aggregator for the always-on/converse path: holds a
  // turn that trails off mid-clause (a trailing conjunction/preposition) and
  // appends the speaker's continuation, so a slow speaker is not cut off and
  // sent prematurely. One per converse capture; reset on stop/barge-in.
  const turnAggregatorRef = React.useRef<TurnAggregator | null>(null);
  // True while a stop is user-initiated (toggle-off / barge-in / typing-pause)
  // vs a clean VAD auto-stop. A one-shot backend (local-inference) ends the
  // capture on end-of-turn silence; if the turn was still held (unfinished) we
  // carry it into the NEXT capture so the continuation appends — but an explicit
  // stop discards it. Without this, a held mid-clause turn is silently dropped.
  const explicitStopRef = React.useRef(false);
  const turnCarryoverRef = React.useRef("");
  // Hands-free conversation loop (tap the mic): the mic re-opens after each
  // spoken reply. A ref mirrors the state so the debounced re-listen timer reads
  // the live value at fire time.
  const [handsFree, setHandsFree] = React.useState(false);
  const handsFreeRef = React.useRef(false);
  handsFreeRef.current = handsFree;
  // Transcription mode (long-form record-only): the mic stays open and every
  // utterance is sent silently (metadata.transcriptionMode) until an exit
  // phrase. A ref mirrors the state for the re-listen timer + capture closures.
  const [transcriptionMode, setTranscriptionMode] = React.useState(false);
  const transcriptionModeRef = React.useRef(false);
  transcriptionModeRef.current = transcriptionMode;
  // Forward handle to `toggleTranscriptionMode` (defined far below) so the
  // converse capture loop can flip INTO transcription on a spoken "start
  // transcription" without a definition-order/closure problem.
  const toggleTranscriptionModeRef = React.useRef<() => void>(() => {});
  // The continuous-chat-mode persisted before hands-free engaged, restored when
  // the user taps the mic off so a deliberate ChatView "vad-gated" choice isn't
  // clobbered to "off". Defaults to "off" — tapping the mic off means voice off.
  const priorContinuousModeRef = React.useRef<"off" | "vad-gated">("off");
  // Auto-restore the persisted "always-on" loop at most once per mount (see the
  // boot effect below) so a later tap-off (which persists "off") is not
  // immediately re-engaged by the same effect re-running.
  const autoEngagedHandsFreeRef = React.useRef(false);
  // Composer-draft signal from the overlay. While the user has a pending typed
  // (or PTT-dictated) draft, the hands-free always-on loop pauses so the mic
  // doesn't transcribe the room over the keyboard; clearing it (on send) lets
  // the loop resume, returning to the prior voice state. State drives the loop
  // effect's re-arm; the ref gives its debounce timer a live re-check.
  const [composerHasDraft, setComposerHasDraftState] = React.useState(false);
  const composerHasDraftRef = React.useRef(false);
  composerHasDraftRef.current = composerHasDraft;
  const setComposerHasDraft = React.useCallback((hasDraft: boolean) => {
    setComposerHasDraftState(hasDraft);
  }, []);
  // Push-to-talk dictation routes its final transcript here (the overlay wires
  // this to its composer draft) instead of sending it.
  const onDictatedTextRef = React.useRef<((text: string) => void) | null>(null);
  const setDictationSink = React.useCallback(
    (sink: ((text: string) => void) | null) => {
      onDictatedTextRef.current = sink;
    },
    [],
  );

  // Transcription mode accumulates utterances into ONE recording session (not N
  // chat bubbles); on exit the segments become a Transcript record + a chat
  // link-widget, delivered through this sink.
  const transcriptSessionRef =
    React.useRef<TranscriptSessionAccumulator | null>(null);
  const transcriptSessionStartRef = React.useRef(0);
  const onTranscriptSessionRef = React.useRef<
    | ((
        segments: TranscriptSegment[],
        startedAtMs: number,
        audioWav: Uint8Array | null,
      ) => void)
    | null
  >(null);
  const setTranscriptSessionSink = React.useCallback(
    (
      sink:
        | ((
            segments: TranscriptSegment[],
            startedAtMs: number,
            audioWav: Uint8Array | null,
          ) => void)
        | null,
    ) => {
      onTranscriptSessionRef.current = sink;
    },
    [],
  );
  /** Begin a fresh recording session (every transcription-start path calls this). */
  const beginTranscriptSession = React.useCallback(() => {
    transcriptSessionStartRef.current = Date.now();
    transcriptSessionRef.current = new TranscriptSessionAccumulator(
      transcriptSessionStartRef.current,
    );
  }, []);
  /** Close the session and hand its segments to the sink (no-op if empty). */
  const finalizeTranscriptSession = React.useCallback(() => {
    const session = transcriptSessionRef.current;
    transcriptSessionRef.current = null;
    if (!session || session.count === 0) return;
    onTranscriptSessionRef.current?.(
      session.build(),
      transcriptSessionStartRef.current,
      session.buildAudioWav(),
    );
  }, []);

  // Identity-preserving projection: reuse the previously-mapped ShellMessage for
  // any turn whose content/failureKind/reasoning is unchanged, so the React.memo
  // on each ThreadLine short-circuits. Without this, every streamed token (which
  // hands `conversationMessages` a new array reference) re-wrapped EVERY message
  // into a fresh object, re-rendering all ~80 historical bubbles per token. The
  // reducer (useStreamingText) already preserves per-message identity one layer
  // down; this stops the projection from throwing it away. The Map is rebuilt
  // fresh each pass so dropped ids are evicted (no long-session leak), and the
  // returned array is still NEW whenever anything changes (latestAgentReply /
  // visibleMessages / scroll-follow still recompute). Cache key omits
  // role/createdAt — invariant per id.
  const shellMessageCacheRef = React.useRef<Map<string, ShellMessage>>(
    new Map(),
  );
  const messages = React.useMemo<ShellMessage[]>(() => {
    const source = Array.isArray(conversationMessages)
      ? conversationMessages
      : [];
    const prev = shellMessageCacheRef.current;
    const next = new Map<string, ShellMessage>();
    const out = source.map((message) => {
      const cached = prev.get(message.id);
      if (
        cached &&
        cached.content === message.text &&
        cached.failureKind === message.failureKind &&
        (cached.reasoning || undefined) === (message.reasoning || undefined)
      ) {
        next.set(message.id, cached);
        return cached;
      }
      const mapped: ShellMessage = {
        id: message.id,
        role: message.role,
        content: message.text,
        createdAt: message.timestamp,
        failureKind: message.failureKind,
        ...(message.reasoning ? { reasoning: message.reasoning } : {}),
        ...(message.attachments?.length
          ? { attachments: message.attachments }
          : {}),
      };
      next.set(message.id, mapped);
      return mapped;
    });
    shellMessageCacheRef.current = next;
    return out;
  }, [conversationMessages]);

  // The agent's most recent reply, for the always-on shouldRespond echo guard
  // (suppress a voice turn that's just the agent's own TTS heard back). A ref so
  // the per-capture commit closure reads the live value.
  const latestAgentReply = React.useMemo<{ text: string; at: number }>(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (m.role === "assistant" && m.content.trim()) {
        return { text: m.content, at: m.createdAt };
      }
    }
    return { text: "", at: 0 };
  }, [messages]);
  const latestAgentReplyRef = React.useRef(latestAgentReply);
  latestAgentReplyRef.current = latestAgentReply;

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
    // Mark this as a user-initiated stop so the clean-auto-stop carryover does
    // NOT fire — a toggle-off / barge-in / typing-pause must discard a
    // half-finished utterance rather than carry or commit it.
    explicitStopRef.current = true;
    turnCarryoverRef.current = "";
    turnAggregatorRef.current?.reset();
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
      // Voice capture is independent of agent-respond readiness. A converse
      // transcript goes through the same warm-tolerant send() (the server holds
      // the turn until first-turn capability is online), and dictation only
      // fills the composer draft. Gating on `ready` here wrongly disabled voice
      // whenever the agent could not respond yet (e.g. no model loaded) even
      // though typing-and-sending worked. Only guard against a capture already
      // in flight.
      if (captureRef.current) return;
      // Converse (always-on) routes finals through the semantic end-of-turn
      // aggregator so a slow speaker who pauses mid-clause isn't cut off; a turn
      // only sends once it reads as complete. Dictation (push-to-talk) bypasses
      // it — the press-release is the turn boundary.
      let lastBackend: VoiceCaptureBackend = "talkmode";
      // Transcription mode wants a VERBATIM long-form transcript, so (like
      // dictation) it bypasses the echo/disfluency end-of-turn aggregator —
      // every final is sent as-is (after exit-phrase detection).
      const aggregator =
        intent === "dictate" || intent === "transcription"
          ? null
          : new TurnAggregator({
              onCommit: (turn) => {
                // Always-on shouldRespond: don't reply to the agent's own TTS
                // echoed back through the mic, or to pure thinking-noise.
                const reply = latestAgentReplyRef.current;
                const replyAgeMs = reply.at
                  ? Math.max(0, Date.now() - reply.at)
                  : Number.POSITIVE_INFINITY;
                const respondContext = {
                  recentAgentReply: reply.text,
                  replyAgeMs,
                  agentSpeaking: speakingRef.current,
                };
                // Cheap client pre-filter: drop an obvious echo/disfluency turn
                // before it costs a server round-trip.
                if (!shouldRespondToVoiceTurn(turn, respondContext)) {
                  return;
                }
                // Attach the ambient signal so the server gate
                // (`core.voice_turn_signal`) is the single authority on whether
                // to reply, and so diarization/wake-word enrichment composes in
                // on platforms that have them. The transcript-only shell path
                // contributes semantic end-of-turn + the echo/disfluency gate.
                const voiceTurnSignal = buildVoiceTurnSignal(
                  turn,
                  respondContext,
                );
                send(turn, {
                  channelType: "VOICE_DM",
                  metadata: { voiceSource: lastBackend, voiceTurnSignal },
                });
              },
            });
      turnAggregatorRef.current?.dispose();
      turnAggregatorRef.current = aggregator;
      // Carry a held (unfinished) turn from the previous one-shot capture into
      // this one so the speaker's continuation appends instead of dropping.
      if (aggregator && turnCarryoverRef.current) {
        aggregator.seed(turnCarryoverRef.current);
      }
      turnCarryoverRef.current = "";
      // Read the user's VAD thresholds synchronously (local mirror of the
      // `messages.voice` setting) so end-of-turn silence detection honors the
      // configured sensitivity. Only consumed by the local-inference backend.
      const handle = createVoiceCapture({
        localAsrAutoStop: loadVadAutoStop(),
        // Push-to-talk dictation ends on release, so the native recognizer must
        // commit its running interim as the final turn even if its silence
        // window hasn't fired. Converse stops only on toggle-off, where a
        // partial must NOT be submitted.
        finalizeOnStop: intent === "dictate",
        onTranscript: (segment) => {
          const text = segment.text.trim();
          if (!segment.final) {
            // Surface the interim best-guess as live transcription, prefixed by
            // any turn still held for continuation so the user sees the full
            // utterance build up.
            const held = aggregator?.pending;
            setTranscript(held ? `${held} ${text}` : text);
            return;
          }
          if (!text) {
            setTranscript("");
            return;
          }
          if (intent === "transcription") {
            // Long-form record-only. Run exit detection on every final.
            if (isTranscriptionExitPhrase(text)) {
              // Fold any preceding non-exit content into the session, then close
              // it (→ Transcript record + chat link-widget) and leave the mode so
              // the NEXT turn is evaluated normally.
              const preceding = stripExitPhrase(text);
              if (preceding) {
                transcriptSessionRef.current?.addFinal(preceding, Date.now());
              }
              setTranscript("");
              setTranscriptionMode(false);
              transcriptionModeRef.current = false;
              finalizeTranscriptSession();
              stopCapture();
              return;
            }
            // Accumulate this utterance into the recording session — it does NOT
            // post as its own chat bubble; the whole session becomes one record.
            // Carry the utterance WAV + per-word timings (fused ASR v12) so the
            // transcript retains audio + word-synced highlight.
            setTranscript("");
            transcriptSessionRef.current?.addFinal(text, Date.now(), {
              audioWav: segment.audioWav,
              words: segment.words,
            });
          } else if (intent === "dictate") {
            // Push-to-talk dictation: hand the text to the composer draft —
            // don't send, and leave lastTurnVoice false so no reply is spoken.
            setTranscript("");
            onDictatedTextRef.current?.(text);
          } else if (aggregator) {
            // A spoken "start transcription" flips INTO long-form record-only
            // mode instead of being sent as a normal turn. (Exit is handled
            // above once already in transcription mode.)
            if (
              !transcriptionModeRef.current &&
              isTranscriptionStartPhrase(text)
            ) {
              setTranscript("");
              toggleTranscriptionModeRef.current();
              return;
            }
            lastBackend = segment.backend;
            const committed = aggregator.addFinal(text);
            // Keep the held turn visible while we wait for the speaker to
            // continue; clear once it commits (and sends).
            setTranscript(committed ? "" : aggregator.pending);
          }
        },
        onStateChange: (state: VoiceCaptureState) => {
          if (state === "error" || state === "stopped" || state === "idle") {
            // Capture ended (clean stop, dispose, or error). Drop the handle and
            // analyser so the shell phase returns to idle/summoned and a later
            // startCapture is not blocked by a stale ref.
            if (captureRef.current === handle) captureRef.current = null;
            // A CLEAN end-of-turn auto-stop (one-shot backend like
            // local-inference) on a still-held turn: carry it to the next
            // capture so the continuation appends. An explicit stop (toggle-off /
            // barge-in / error) discards it.
            if (
              state === "stopped" &&
              !explicitStopRef.current &&
              aggregator?.pending
            ) {
              turnCarryoverRef.current = aggregator.pending;
            }
            explicitStopRef.current = false;
            aggregator?.reset();
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
    [send, stopCapture, finalizeTranscriptSession],
  );

  const toggleRecording = React.useCallback(() => {
    if (recording) stopCapture();
    else startCapture();
  }, [recording, startCapture, stopCapture]);

  React.useEffect(() => stopCapture, [stopCapture]);

  // Restore a persisted "always-on" continuous-chat mode on boot: engage the
  // hands-free re-listen LOOP (not a one-shot capture) so always-on survives a
  // reload as a real setting — the same state a mic tap produces. Audio output
  // stays locked until the first user gesture (no unlockAudio here), but the mic
  // (capture) opens from the already-granted permission. Guarded to auto-engage
  // at most once per mount so a later tap-off (which persists "off") isn't
  // re-engaged by this effect re-running.
  React.useEffect(() => {
    if (autoEngagedHandsFreeRef.current) return;
    // Defer while a reply is mid-flight (voice is gated while responding); the
    // ref stays unset so this retries the instant `chatSending` clears.
    if (!ready || recording || captureRef.current || handsFree || chatSending)
      return;
    if (loadContinuousChatMode() !== "always-on") return;
    autoEngagedHandsFreeRef.current = true;
    priorContinuousModeRef.current = "off";
    setHandsFree(true);
    setIsOpen(true);
    startCapture("converse");
  }, [ready, recording, handsFree, chatSending, startCapture]);

  const open = React.useCallback(() => {
    setIsOpen(true);
  }, []);
  const close = React.useCallback(() => {
    setIsOpen(false);
    setHandsFree(false);
    if (captureRef.current) stopCapture();
  }, [stopCapture]);

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

  // `recording` (push-to-talk press or continuous capture) wins over an
  // in-flight response so the pill shows the red "listening" pulse the instant
  // the mic opens, even while the previous turn is still streaming (barge-in).
  // "responding" covers BOTH the text streaming in (chatSending) AND the reply
  // being spoken aloud (voiceOutput.speaking), so the UI reads as busy for the
  // whole turn — not just the text phase, leaving a dead gap while TTS plays.
  // Stop/error clears `recording` (see startCapture/stopCapture), dropping the
  // phase back to responding → summoned → idle.
  // The RAW in-flight predicate — text streaming (chatSending) OR the reply being
  // spoken (speaking). Unlike `phase === "responding"`, this stays true even
  // after the mic opens (which flips phase to "listening"), so the composer-send
  // and voice-gating logic both read one honest "a reply is in flight" signal.
  const responding = chatSending || voiceOutput.speaking;
  const phase: ShellPhase = !ready
    ? "booting"
    : recording
      ? "listening"
      : responding
        ? "responding"
        : !isOpen
          ? "idle"
          : "summoned";

  // Live mirror of whether the agent is speaking, for the converse commit
  // closure's echo guard (it reads at send time, after this render).
  const speakingRef = React.useRef(false);
  speakingRef.current = voiceOutput.speaking;

  // The composer's stop control halts the turn — the spoken reply always, and
  // text generation ONLY while it's actually streaming. During pure TTS playback
  // `handleChatStop` must not fire: it's the broad chat-stop that also tears down
  // unrelated coding-agent PTY sessions; here we just want to stop the speech.
  const stopTurn = React.useCallback(() => {
    if (chatSending) handleChatStop();
    voiceOutput.stopSpeaking();
  }, [chatSending, handleChatStop, voiceOutput.stopSpeaking]);

  // Tap-to-talk: toggle a hands-free conversation. Enabling unlocks audio (the
  // tap is the gesture) and opens the mic in "converse" mode; disabling stops
  // both the mic and any in-flight reply.
  const toggleHandsFree = React.useCallback(() => {
    if (handsFreeRef.current) {
      // Tap off → persist the prior non-always-on mode (so a deliberate
      // "vad-gated" choice survives) and stop the mic + any in-flight reply.
      saveContinuousChatMode(priorContinuousModeRef.current);
      setHandsFree(false);
      if (captureRef.current) stopCapture();
      voiceOutput.stopSpeaking();
    } else {
      // Tap on → persist "always-on" so the loop is restored across reloads,
      // remembering what to fall back to when it is turned off.
      const prior = loadContinuousChatMode();
      if (prior !== "always-on") priorContinuousModeRef.current = prior;
      saveContinuousChatMode("always-on");
      setHandsFree(true);
      setIsOpen(true);
      voiceOutput.unlockAudio();
      // Voice is gated while a reply is in flight: open the mic now only if
      // nothing is responding; otherwise the hands-free loop opens it the
      // instant the reply finishes.
      if (!responding) startCapture("converse");
    }
  }, [responding, startCapture, stopCapture, voiceOutput]);

  // Toggle transcription mode (long-form, record-only — the agent never replies
  // to a transcribed turn). It is an ADDITIVE voice layer: the mic stays on and
  // the composer keeps working; enabling it just pauses the hands-free REPLY
  // loop and opens a long-running capture that accumulates every utterance
  // silently. Turning it off (this toggle, the mic button, or a spoken exit
  // phrase) finalizes the session, which drops the transcript into the composer
  // as an attachment the user sends with their next message.
  const toggleTranscriptionMode = React.useCallback(() => {
    if (transcriptionModeRef.current) {
      setTranscriptionMode(false);
      transcriptionModeRef.current = false;
      if (captureRef.current) stopCapture();
      // Close the recording session → Transcript record + chat link-widget.
      finalizeTranscriptSession();
    } else {
      if (handsFreeRef.current) {
        setHandsFree(false);
        handsFreeRef.current = false;
      }
      setTranscriptionMode(true);
      transcriptionModeRef.current = true;
      setIsOpen(true);
      voiceOutput.unlockAudio();
      beginTranscriptSession();
      if (captureRef.current) stopCapture();
      startCapture("transcription");
    }
  }, [
    startCapture,
    stopCapture,
    voiceOutput,
    beginTranscriptSession,
    finalizeTranscriptSession,
  ]);
  // Keep the forward ref current so the converse capture loop (defined above)
  // can flip into transcription on a spoken start phrase.
  toggleTranscriptionModeRef.current = toggleTranscriptionMode;

  // A server-side agent action (START/STOP_TRANSCRIPTION) reaches the shell as a
  // window `voice-control` event (the agent-event bus → client bridge); flip
  // transcription to match. Idempotent — "start" while already transcribing (or
  // "stop" while idle) is a no-op.
  React.useEffect(() => {
    const onVoiceControl = (e: Event) => {
      const detail = (e as CustomEvent<VoiceControlEventDetail>).detail;
      if (!detail) return;
      if (detail.command === "start" && !transcriptionModeRef.current) {
        toggleTranscriptionModeRef.current();
      } else if (detail.command === "stop" && transcriptionModeRef.current) {
        toggleTranscriptionModeRef.current();
      }
    };
    window.addEventListener(VOICE_CONTROL_EVENT, onVoiceControl);
    return () =>
      window.removeEventListener(VOICE_CONTROL_EVENT, onVoiceControl);
  }, []);

  // Transcription re-listen loop: a one-shot capture backend (local-inference
  // auto-stop on silence) ends after each utterance — re-open it so long-form
  // recording continues. Mirrors the hands-free loop but re-opens in
  // "transcription" intent and needs no spoken-reply gate (mode never replies).
  React.useEffect(() => {
    if (!transcriptionMode || !ready) return;
    if (recording || captureRef.current) return;
    if (chatSending || voiceOutput.speaking) return;
    if (composerHasDraft) return;
    const timer = window.setTimeout(() => {
      if (
        transcriptionModeRef.current &&
        !captureRef.current &&
        !chatSending &&
        !voiceOutput.speaking &&
        !composerHasDraftRef.current
      ) {
        startCapture("transcription");
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [
    transcriptionMode,
    ready,
    recording,
    chatSending,
    voiceOutput.speaking,
    composerHasDraft,
    startCapture,
  ]);

  // Typing pauses always-on: when a draft appears while the hands-free mic is
  // live, stop the capture so it doesn't transcribe the room over the keyboard.
  // handsFree stays true, so the re-listen loop resumes once the draft clears.
  React.useEffect(() => {
    if (composerHasDraft && handsFree && captureRef.current) {
      stopCapture();
    }
  }, [composerHasDraft, handsFree, stopCapture]);

  // Hands-free loop: once a spoken reply finishes (and nothing is recording or
  // mid-send), re-open the mic so the conversation continues without a tap. The
  // 250ms debounce + live re-check via handsFreeRef guard against double-start.
  // Paused while the composer holds a draft (typing → always-on off), so a send
  // that clears the draft re-arms it and returns to the prior voice state.
  React.useEffect(() => {
    if (!handsFree || !ready) return;
    if (recording || captureRef.current) return;
    if (chatSending || voiceOutput.speaking) return;
    if (composerHasDraft) return;
    const timer = window.setTimeout(() => {
      if (
        handsFreeRef.current &&
        !captureRef.current &&
        !chatSending &&
        !voiceOutput.speaking &&
        !composerHasDraftRef.current
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
    composerHasDraft,
    startCapture,
  ]);

  const waveformMode =
    phase === "listening"
      ? "listening"
      : phase === "responding"
        ? "responding"
        : "idle";

  // Accept input while the agent is still booting; pre-ready sends queue (see
  // `send`) and flush on ready. Send stays enabled mid-response: typing + sending
  // again queues another message into the room (Option A — serialized turns), so
  // a stopped agent is the only thing that disables it. Voice, by contrast, IS
  // gated while responding (the mic/PTT below read `responding`). This mirrors the
  // canonical ChatView composer, which does NOT gate on local text-model
  // readiness: the overlay is the single chat input on the /chat tab, so a
  // missing/loading local model must still submit the send. The server returns a
  // failureKind gate ("Connect a provider") that the transcript renders.
  const canSend = agentStatus?.state !== "stopped";

  return {
    phase,
    responding,
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
    transcriptionMode,
    toggleTranscriptionMode,
    setDictationSink,
    setTranscriptSessionSink,
    setComposerHasDraft,
    transcript,
    speaking: voiceOutput.speaking,
    agentVoiceMuted: voiceOutput.agentVoiceMuted,
    toggleAgentVoiceMute: voiceOutput.toggleAgentVoiceMute,
    needsAudioUnlock: voiceOutput.needsAudioUnlock,
    unlockAudio: voiceOutput.unlockAudio,
    clearConversation,
    openSettings,
    navigateHome,
    currentTab: app.tab,
    stop: stopTurn,
  };
}
