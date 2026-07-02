import type { TranscriptSegment } from "@elizaos/shared/transcripts";
import * as React from "react";
import type {
  ChatTurnStatus,
  ImageAttachment,
} from "../../api/client-types-chat";
import {
  VOICE_CONTROL_EVENT,
  type VoiceControlEventDetail,
} from "../../events";
import type { HomeModelStatus } from "../../services/local-inference/home-model-status";
import {
  useChatComposer,
  useChatTurnStatus,
  useConversationMessages,
} from "../../state";
import { useAppSelectorShallow } from "../../state/app-store";
import type { AppContextValue } from "../../state/internal";
import {
  loadContinuousChatMode,
  loadVadAutoStop,
  loadWakeWordEnabled,
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
import { useWakeListenWindow } from "../../voice/useWakeListenWindow";
import {
  createVoiceCapture,
  type VoiceCaptureBackend,
  type VoiceCaptureHandle,
  type VoiceCaptureState,
} from "../../voice/voice-capture-factory";
import { buildVoiceTurnSignal } from "../../voice/voice-turn-signal";
import { matchWakeName } from "../../voice/wake-name-match";
import { useHomeModelStatus } from "../local-inference/useHomeModelStatus";
import {
  buildConversationNav,
  type ConversationNav,
  type ConversationNavDirection,
  resolveAdjacentConversationId,
} from "./conversation-nav";
import { dispatchHomeLauncherNavigation } from "./home-launcher-events";
import type { ShellMessage, ShellPhase } from "./shell-state";
import { useShellVoiceOutput } from "./useShellVoiceOutput";

export type {
  ConversationNav,
  ConversationNavDirection,
} from "./conversation-nav";
export {
  buildConversationNav,
  resolveAdjacentConversationId,
} from "./conversation-nav";

/** Upper bound (ms) the conversation-switch / clear loading spinner may show
 *  before it is force-cleared — see `runWithConversationLoading`. */
const CONVERSATION_LOADING_MAX_MS = 12_000;

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
  /** The rich, phase-aware status of the in-flight turn (#8813) — what the agent
   *  is *doing* right now (thinking / streaming / running an action / waking /
   *  speaking), or null when idle. Prefers the live server-reported phase, then
   *  falls back to client-derived signals. Use this for the status indicator;
   *  `responding` remains the coarse busy boolean for gating. */
  turnStatus: ChatTurnStatus | null;
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
  /** Show the agent the screen: sends a vision-intent turn so the agent runs its
   *  plugin-vision screen-capture action. Backs the bottom-bar VISION button. */
  captureVision: () => void;
  /** True from a VISION tap until the resulting turn is in flight (pulses the
   *  VISION button). */
  visionCapturing: boolean;
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
  /** Speak a specific message aloud on demand — backs the per-message
   *  "Play audio" action row control (#10713). */
  speak: (text: string) => void;
  /** Stop any in-flight assistant speech — backs the Play control's toggle. */
  stopSpeaking: () => void;
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
   *  that suppresses replies; disabling stops it and RESUMES the hands-free mic
   *  loop it paused (transcript off leaves the mic on — they are linked). */
  toggleTranscriptionMode: () => void | Promise<void>;
  /** End transcription AND turn the mic fully off (the mic button's action while
   *  transcribing — turning off the mic turns off transcript). */
  stopTranscriptionAndMic: () => void | Promise<void>;
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
  /** Clear the conversation and start a fresh, greeted one. */
  clearConversation: () => void;
  /** Jump to Settings (where ProviderSwitcher lives) — used by the chat's
   *  `no_provider` failure gate to let the user wire a provider in one tap. */
  openSettings: () => void;
  /** Return to the combined Home/Launcher surface and select Home. */
  navigateHome?: () => void;
  /** Open the combined Home/Launcher surface and select Launcher. */
  navigateToViews?: () => void;
  /** The active app tab. */
  currentTab?: string;
  /** Stop an in-flight reply stream (the composer's stop control). */
  stop: () => void;
  /** Horizontal-swipe navigation between conversations (sheet-open only). */
  conversationNav: ConversationNav;
  /** True while a conversation switch or clear is fetching messages. The overlay
   *  only renders the spinner when the visible thread is empty. */
  conversationLoading?: boolean;
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
/**
 * Turn a mic-capture start failure into a clear, actionable notice. Reads the
 * DOMException `name` (getUserMedia rejects with `NotAllowedError` on a denied
 * permission, `NotFoundError` when no device exists) and its message so we
 * distinguish "denied" vs "no device" vs a generic failure, instead of
 * swallowing the rejection and leaving a mic tap silent.
 */
function describeCaptureFailure(err: unknown): string {
  const name =
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    typeof (err as { name: unknown }).name === "string"
      ? (err as { name: string }).name
      : "";
  const message = err instanceof Error ? err.message : String(err ?? "");
  const haystack = `${name} ${message}`.toLowerCase();
  if (
    haystack.includes("notallowed") ||
    haystack.includes("permissiondenied") ||
    haystack.includes("permission denied") ||
    haystack.includes("not-allowed")
  ) {
    return "Microphone access was denied. Enable microphone permission in your browser or system settings to use voice.";
  }
  if (
    haystack.includes("notfound") ||
    haystack.includes("devices not found") ||
    haystack.includes("no device") ||
    haystack.includes("no microphone")
  ) {
    return "No microphone was found. Connect a microphone to use voice.";
  }
  return "Could not start the microphone. Check your microphone permissions and try again.";
}

/** Shallow equality for two optional string lists (topic-change detection). */
function sameStringList(a?: string[], b?: string[]): boolean {
  if (a === b) return true;
  if (!a || !b) return (a?.length ?? 0) === (b?.length ?? 0);
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// Granular shallow selection instead of useApp() so the shell controller only
// re-renders when one of the exact fields it reads changes — not on every one of
// the ~300 AppContext fields. typecheck enforces completeness: any `s.x` used
// below but not selected here is a compile error, so this stays value-equivalent.
const selectShellController = (s: AppContextValue) => ({
  tab: s.tab,
  chatFirstTokenReceived: s.chatFirstTokenReceived,
  sendChatText: s.sendChatText,
  agentStatus: s.agentStatus,
  characterData: s.characterData,
  uiLanguage: s.uiLanguage,
  elizaCloudVoiceProxyAvailable: s.elizaCloudVoiceProxyAvailable,
  handleNewConversation: s.handleNewConversation,
  handleSelectConversation: s.handleSelectConversation,
  activeConversationId: s.activeConversationId,
  conversations: s.conversations,
  setTab: s.setTab,
  handleChatStop: s.handleChatStop,
  setActionNotice: s.setActionNotice,
});

export function useShellController(): ShellController {
  const {
    tab,
    chatFirstTokenReceived,
    sendChatText,
    agentStatus,
    characterData,
    uiLanguage,
    elizaCloudVoiceProxyAvailable,
    handleNewConversation,
    handleSelectConversation,
    activeConversationId,
    conversations,
    setTab,
    handleChatStop,
    setActionNotice,
  } = useAppSelectorShallow(selectShellController);
  // The wake phrase for transcript-mode inline replies follows the character
  // name (issue #9880); falls back to the running agent name, then "eliza".
  const wakeCharacterName =
    characterData?.name?.trim() || agentStatus?.agentName?.trim() || "eliza";
  const wakeCharacterNameRef = React.useRef(wakeCharacterName);
  wakeCharacterNameRef.current = wakeCharacterName;
  // Read per-token streaming messages from the isolated context so token updates
  // don't depend on the giant AppContext value identity.
  const { conversationMessages } = useConversationMessages();
  // chatSending lives in ChatComposerContext; the AppContext copy is intentionally
  // stale so send/typing churn does not fan out through the whole app.
  const { chatSending } = useChatComposer();
  // Live server-reported phase of the in-flight turn (from the chat-send SSE),
  // read from its dedicated context so status events re-render only chat surfaces.
  const { serverTurnStatus } = useChatTurnStatus();
  const conversationsRef = React.useRef(conversations);
  const activeConversationIdRef = React.useRef(activeConversationId);
  conversationsRef.current = conversations;
  activeConversationIdRef.current = activeConversationId;

  // Jump to Settings from the chat's no_provider gate. Stable identity.
  const openSettings = React.useCallback(() => setTab("settings"), [setTab]);
  // Return to the combined Home/Launcher route and reset its internal page.
  // If the route is not mounted yet, the next mount starts on Home; if it is
  // already mounted on Launcher, this event flips it without a remount.
  const navigateHome = React.useCallback(() => {
    setTab("chat");
    dispatchHomeLauncherNavigation("home");
  }, [setTab]);
  const navigateToViews = React.useCallback(() => {
    setTab("chat");
    dispatchHomeLauncherNavigation("launcher");
  }, [setTab]);

  // True while a clear or conversation switch is fetching the next thread, so
  // the overlay can show an in-thread spinner instead of an empty sheet. Cache
  // hits paint synchronously inside handleSelectConversation; the overlay only
  // renders the spinner when the visible thread is still empty.
  const [conversationLoading, setConversationLoading] = React.useState(false);
  const conversationLoadingSeqRef = React.useRef(0);
  const conversationTransitionBusyRef = React.useRef(false);

  // Stop any in-flight assistant speech across a conversation change. `voiceOutput`
  // is defined far below (after the conversation-switch handlers), so mirror its
  // `stopSpeaking` into a ref the clear/switch handlers can call at gesture time
  // without a definition-order/closure problem. Defaults to a no-op until wired.
  const stopSpeakingRef = React.useRef<() => void>(() => {});
  // Guards the capture-failure notice so the hands-free re-listen loop's retries
  // (which re-call startCapture every ~250ms) don't spam the toast; cleared on
  // the next successful start so a later failure re-notifies.
  const captureFailureNoticedRef = React.useRef(false);

  const runWithConversationLoading = React.useCallback(
    (task: () => Promise<unknown>) => {
      const seq = conversationLoadingSeqRef.current + 1;
      conversationLoadingSeqRef.current = seq;
      conversationTransitionBusyRef.current = true;
      setConversationLoading(true);
      const clearLoadingForSeq = () => {
        if (conversationLoadingSeqRef.current === seq) {
          conversationTransitionBusyRef.current = false;
          setConversationLoading(false);
        }
      };
      // Watchdog: never let the empty-thread spinner outlive a stuck switch or
      // create. A cache-hit switch resolves in the same tick and a network load
      // in a few seconds, but the on-device agent can be model-bound (a warming
      // or loading 1.4 GB model, an in-flight generation), and a spinner that
      // hangs there reads as a permanently frozen new chat. Force-clear after a
      // bound so the (already-activated) conversation is usable while a slow
      // greeting backfills. Seq-guarded so a newer switch owns the flag.
      const watchdog = setTimeout(
        clearLoadingForSeq,
        CONVERSATION_LOADING_MAX_MS,
      );
      void Promise.resolve()
        .then(task)
        .finally(() => {
          clearTimeout(watchdog);
          clearLoadingForSeq();
        });
    },
    [],
  );

  // Clear the chat: drop the current conversation and start a fresh, greeted one
  // (handleNewConversation resets draft state + creates a new conversation with a
  // bootstrap greeting; an empty draft we just left is pruned, a non-empty
  // conversation is kept and remains swipe-reachable).
  const clearConversation = React.useCallback(() => {
    // A fresh conversation's bootstrap greeting is NOT a reply to a voice turn —
    // stop any reply still being spoken from the prior session and clear the
    // voice flag so the greeting isn't spoken aloud after it.
    stopSpeakingRef.current();
    setLastTurnVoice(false);
    runWithConversationLoading(handleNewConversation);
  }, [handleNewConversation, runWithConversationLoading]);

  // Switch conversations behind a loading flag so an uncached swipe shows the
  // spinner; a cached one resolves within the same tick (thread already painted).
  // A switch must not leave the previous thread's spoken reply playing into the
  // new one, nor inherit its "speak the next turn" latch: stop in-flight TTS and
  // reset lastTurnVoice so the target conversation starts silent.
  const selectConversation = React.useCallback(
    (id: string) => {
      stopSpeakingRef.current();
      setLastTurnVoice(false);
      runWithConversationLoading(() => handleSelectConversation(id));
    },
    [handleSelectConversation, runWithConversationLoading],
  );

  const selectAdjacentConversation = React.useCallback(
    (direction: ConversationNavDirection) => {
      if (conversationTransitionBusyRef.current) {
        return;
      }
      const targetId = resolveAdjacentConversationId(
        conversationsRef.current,
        activeConversationIdRef.current,
        direction,
      );
      if (targetId) {
        selectConversation(targetId);
      }
    },
    [selectConversation],
  );

  // Horizontal-swipe navigation between conversations (#8929). Computed by the
  // pure `buildConversationNav` helper (unit-tested) so the index-walk and
  // boundary logic stay verifiable independent of this AppContext-bound hook.
  // The callbacks re-resolve through refs at gesture time so a stale overlay
  // closure cannot navigate against an old active index after the list rerenders.
  const conversationNav = React.useMemo<ConversationNav>(() => {
    const nav = buildConversationNav(
      conversations,
      activeConversationId,
      selectConversation,
    );
    return {
      ...nav,
      goPrev: () => selectAdjacentConversation("prev"),
      goNext: () => selectAdjacentConversation("next"),
    };
  }, [
    conversations,
    activeConversationId,
    selectConversation,
    selectAdjacentConversation,
  ]);

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
  // Whether the hands-free mic loop was running when transcription was entered.
  // The mic and transcript are LINKED but not identical: the transcript button
  // (and a spoken/server "stop") pauses the hands-free reply loop on enter and
  // RESUMES it on exit, so turning transcript off leaves the mic on. Only the
  // mic button turns the mic (and thus transcript) fully off.
  const resumeHandsFreeAfterTranscriptRef = React.useRef(false);
  // Set when a wake-triggered inline reply is sent during transcription, so the
  // assistant's answer is folded into the transcript once it arrives (#9880).
  const recordReplyIntoTranscriptRef = React.useRef(false);
  // Forward handle to `toggleTranscriptionMode` (defined far below) so the
  // converse capture loop can flip INTO transcription on a spoken "start
  // transcription" without a definition-order/closure problem.
  const toggleTranscriptionModeRef = React.useRef<() => void | Promise<void>>(
    () => {},
  );
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
        (cached.reasoning || undefined) === (message.reasoning || undefined) &&
        cached.secretRequest === message.secretRequest &&
        sameStringList(cached.topics, message.topics)
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
        ...(message.secretRequest
          ? { secretRequest: message.secretRequest }
          : {}),
        ...(message.topics?.length ? { topics: message.topics } : {}),
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

  // When a wake-triggered inline reply was sent during transcription, fold the
  // agent's answer into the transcript record (speaker-labeled) so the parallel
  // chat is captured, then clear the one-shot flag (#9880).
  React.useEffect(() => {
    if (!recordReplyIntoTranscriptRef.current) return;
    if (!transcriptionModeRef.current) return;
    if (chatSending) return; // wait for the reply to finish streaming
    const reply = latestAgentReply.text.trim();
    if (!reply) return;
    recordReplyIntoTranscriptRef.current = false;
    transcriptSessionRef.current?.addFinal(reply, Date.now(), {
      speakerLabel: wakeCharacterNameRef.current,
    });
  }, [latestAgentReply, chatSending]);

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

  const stopCaptureAndDrain = React.useCallback(async () => {
    const handle = captureRef.current;
    captureRef.current = null;
    // Mark this as a user-initiated stop so the clean-auto-stop carryover does
    // NOT fire — a toggle-off / barge-in / typing-pause must discard a
    // half-finished utterance rather than carry or commit it.
    explicitStopRef.current = true;
    turnCarryoverRef.current = "";
    turnAggregatorRef.current?.reset();
    if (handle) {
      try {
        await handle.stop();
      } catch {
        /* stop is best-effort from UI controls */
      } finally {
        handle.dispose();
      }
    }
    setAnalyser(null);
    setRecording(false);
    setTranscript("");
  }, []);

  const stopCapture = React.useCallback(() => {
    void stopCaptureAndDrain();
  }, [stopCaptureAndDrain]);

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
              // A spoken "stop transcription" turns transcript OFF but leaves
              // the mic ON — resume the hands-free loop it paused on enter.
              if (resumeHandsFreeAfterTranscriptRef.current) {
                resumeHandsFreeAfterTranscriptRef.current = false;
                setHandsFree(true);
                handsFreeRef.current = true;
              }
              return;
            }
            // Wake word DURING transcription → one inline reply, parallel-chat
            // style: the agent answers (and speaks) while recording keeps
            // running (issue #9880). The user's wake utterance is still folded
            // into the transcript so the exchange is captured; the turn is sent
            // WITHOUT the transcriptionMode metadata so the server reply gate
            // does not suppress it, and we do NOT leave transcription mode.
            const wake = matchWakeName(text, wakeCharacterNameRef.current);
            if (wake.matched) {
              setTranscript("");
              transcriptSessionRef.current?.addFinal(text, Date.now(), {
                audioWav: segment.audioWav,
                words: segment.words,
              });
              const command = wake.command.trim() || text;
              const respondContext = {
                recentAgentReply: latestAgentReplyRef.current.text,
                replyAgeMs: latestAgentReplyRef.current.at
                  ? Math.max(0, Date.now() - latestAgentReplyRef.current.at)
                  : Number.POSITIVE_INFINITY,
                agentSpeaking: speakingRef.current,
              };
              // Capture the assistant's spoken reply into the transcript too, so
              // the parallel chat is part of the record.
              recordReplyIntoTranscriptRef.current = true;
              send(command, {
                channelType: "VOICE_DM",
                metadata: {
                  voiceSource: lastBackend,
                  voiceTurnSignal: buildVoiceTurnSignal(
                    command,
                    respondContext,
                  ),
                },
              });
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
          // A clean start clears the failure latch so a later denial re-notifies.
          captureFailureNoticedRef.current = false;
          if (captureRef.current === handle) setAnalyser(handle.getAnalyser());
        })
        .catch((err: unknown) => {
          captureRef.current = null;
          setAnalyser(null);
          setRecording(false);
          // Mic permission denial / capture failure was previously swallowed —
          // the user tapped the mic and nothing happened with no feedback.
          // Surface a clear, actionable notice through the shell's toast channel
          // (denied vs no-device distinguished where possible). Guarded so the
          // hands-free re-listen loop's retries don't spam it.
          if (!captureFailureNoticedRef.current) {
            captureFailureNoticedRef.current = true;
            setActionNotice(describeCaptureFailure(err), "error", 6000);
          }
        });
    },
    [send, stopCapture, finalizeTranscriptSession, setActionNotice],
  );

  const toggleRecording = React.useCallback(() => {
    if (recording) stopCapture();
    else startCapture();
  }, [recording, startCapture, stopCapture]);

  React.useEffect(() => () => stopCapture(), [stopCapture]);

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
  // Wire the forward ref so the conversation-switch / clear handlers (defined
  // above `voiceOutput`) can stop in-flight assistant speech at gesture time.
  stopSpeakingRef.current = voiceOutput.stopSpeaking;

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

  // The rich status (#8813): what the agent is *doing*, distinct from the coarse
  // `responding` boolean. Voice playback wins (the server can't see local TTS).
  // Otherwise prefer the live server phase while a text turn is in flight; if no
  // server status has arrived yet, fall back to thinking (sent, no first token)
  // → streaming (first token seen). The server's `waking` status (cloud 202) is
  // surfaced even before chatSending settles, so it shows while the agent boots.
  const turnStatus = React.useMemo<ChatTurnStatus | null>(() => {
    if (voiceOutput.speaking) return { kind: "speaking" };
    if (
      serverTurnStatus &&
      (chatSending || serverTurnStatus.kind === "waking")
    ) {
      return serverTurnStatus;
    }
    if (chatSending) {
      return { kind: chatFirstTokenReceived ? "streaming" : "thinking" };
    }
    return null;
  }, [
    voiceOutput.speaking,
    serverTurnStatus,
    chatSending,
    chatFirstTokenReceived,
  ]);

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

  // "Hey eliza" wake word: a native detection arms a bounded listening window
  // that opens the mic and closes once the agent has responded (or after an idle
  // timeout if nothing is said). Implemented as a temporary hands-free engage —
  // it never persists "always-on", and it stays inert when the user already
  // chose always-on (wake is only an entry ramp, never an exit). See
  // ../../voice/VOICE_UX.md.
  const wakeAlreadyAlwaysOn =
    handsFree && loadContinuousChatMode() === "always-on";
  // The Settings → Voice "Wake word" toggle gates this listening loop. Read the
  // persisted pref synchronously each render (same direct-read pattern as
  // loadContinuousChatMode above); it defaults ON so wake stays available unless
  // the user turns it off. A disabled pref makes useWakeListenWindow inert (no
  // native subscription, no mic effect).
  const wakeWordEnabled = loadWakeWordEnabled();
  useWakeListenWindow({
    enabled: wakeWordEnabled,
    alwaysOn: wakeAlreadyAlwaysOn,
    agentBusy: responding,
    characterName: wakeCharacterName,
    onOpen: React.useCallback(() => {
      setIsOpen(true);
      setHandsFree(true);
      handsFreeRef.current = true;
      voiceOutput.unlockAudio();
      if (!responding && !captureRef.current) startCapture("converse");
    }, [responding, startCapture, voiceOutput]),
    onClose: React.useCallback(() => {
      // Close the temporary window without disturbing a persisted mode.
      setHandsFree(false);
      handsFreeRef.current = false;
      if (captureRef.current) stopCapture();
    }, [stopCapture]),
  });

  // Toggle transcription mode (long-form, record-only — the agent never replies
  // to a transcribed turn). It is an ADDITIVE voice layer: the mic stays on and
  // the composer keeps working; enabling it just pauses the hands-free REPLY
  // loop and opens a long-running capture that accumulates every utterance
  // silently. Turning it off (this toggle, the mic button, or a spoken exit
  // phrase) finalizes the session, which drops the transcript into the composer
  // as an attachment the user sends with their next message.
  const toggleTranscriptionMode = React.useCallback(async () => {
    if (transcriptionModeRef.current) {
      setTranscriptionMode(false);
      transcriptionModeRef.current = false;
      if (captureRef.current) await stopCaptureAndDrain();
      // Close the recording session → Transcript record + chat link-widget.
      finalizeTranscriptSession();
      // Turning transcript OFF must leave the mic ON: resume the hands-free
      // listen loop the transcription layer paused on enter. (Only the mic
      // button — handleMicClick → stopTranscriptionAndMic — turns the mic off.)
      if (resumeHandsFreeAfterTranscriptRef.current) {
        resumeHandsFreeAfterTranscriptRef.current = false;
        setHandsFree(true);
        handsFreeRef.current = true;
      }
    } else {
      // Remember the mic state so we can restore it on exit, then pause the
      // hands-free REPLY loop while transcription records silently. The mic
      // itself stays on (transcription capture) — pressing transcript never
      // disables the mic.
      resumeHandsFreeAfterTranscriptRef.current = handsFreeRef.current;
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
    stopCaptureAndDrain,
    voiceOutput,
    beginTranscriptSession,
    finalizeTranscriptSession,
  ]);

  // The mic button while transcribing: turn the mic (and thus transcript) fully
  // OFF. Distinct from `toggleTranscriptionMode`'s off-path, which leaves the
  // mic listening — "turning off the mic turns off transcript" (mic = parent).
  const stopTranscriptionAndMic = React.useCallback(async () => {
    setTranscriptionMode(false);
    transcriptionModeRef.current = false;
    if (captureRef.current) await stopCaptureAndDrain();
    finalizeTranscriptSession();
    resumeHandsFreeAfterTranscriptRef.current = false;
    // Turn the mic fully off like a hands-free tap-off: persist the prior
    // non-always-on mode so the auto-engage loop does NOT re-open the mic.
    saveContinuousChatMode(priorContinuousModeRef.current);
    setHandsFree(false);
    handsFreeRef.current = false;
  }, [stopCaptureAndDrain, finalizeTranscriptSession]);
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
  // Unlike hands-free, a composer draft does NOT pause it: transcription is an
  // additive layer — the composer keeps working and the mic stays on the whole
  // time. Gating on the draft silently dropped meeting audio while the badge
  // still said "Transcribing".
  React.useEffect(() => {
    if (!transcriptionMode || !ready) return;
    if (recording || captureRef.current) return;
    if (chatSending || voiceOutput.speaking) return;
    const timer = window.setTimeout(() => {
      if (
        transcriptionModeRef.current &&
        !captureRef.current &&
        !chatSending &&
        !voiceOutput.speaking
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

  // VISION button: a tap sends a screen-vision turn so the agent runs its
  // plugin-vision screen-capture action (server-side capture + analysis). The
  // transient `visionCapturing` flag pulses the button until the turn is in
  // flight (responding rises), then clears.
  const [visionCapturing, setVisionCapturing] = React.useState(false);
  const captureVision = React.useCallback(() => {
    if (!canSend) return;
    setVisionCapturing(true);
    send("Take a look at my screen and tell me what you see.", {
      metadata: { vision: { surface: "screen" } },
    });
  }, [canSend, send]);
  React.useEffect(() => {
    if (visionCapturing && responding) setVisionCapturing(false);
  }, [visionCapturing, responding]);

  return {
    phase,
    responding,
    turnStatus,
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
    captureVision,
    visionCapturing,
    toggleRecording,
    startRecording: startCapture,
    stopRecording: stopCapture,
    handsFree,
    toggleHandsFree,
    transcriptionMode,
    toggleTranscriptionMode,
    stopTranscriptionAndMic,
    setDictationSink,
    setTranscriptSessionSink,
    setComposerHasDraft,
    transcript,
    speaking: voiceOutput.speaking,
    speak: voiceOutput.speak,
    stopSpeaking: voiceOutput.stopSpeaking,
    agentVoiceMuted: voiceOutput.agentVoiceMuted,
    toggleAgentVoiceMute: voiceOutput.toggleAgentVoiceMute,
    needsAudioUnlock: voiceOutput.needsAudioUnlock,
    unlockAudio: voiceOutput.unlockAudio,
    clearConversation,
    openSettings,
    navigateHome,
    navigateToViews,
    currentTab: tab,
    stop: stopTurn,
    conversationNav,
    // Revealability is driven by the EXPLICIT, sequence-guarded loading flag
    // (set by runWithConversationLoading on clear/select/new and cleared in its
    // finally) — never by `messages.length === 0`. A bare message-count heuristic
    // is a STEADY-STATE condition, not a transient one: it latches true forever
    // for a genuinely-empty active conversation (greeting generation failed
    // silently, or an existing zero-message conversation was selected), which
    // pinned a perpetual loading spinner and let the grabber/pill open the sheet
    // into a never-resolving loader.
    conversationLoading,
  };
}
