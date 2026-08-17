/**
 * Voice-session orchestrator — the keystone of the realtime voice loop.
 *
 * One instance == one live WS session. It owns the turn state machine and wires
 * the three legs together using the ALREADY-MERGED adapters as the provider
 * layer (never a reimplementation):
 *   - STT: Cartesia Ink 2. Uplink PCM is re-framed into 100 ms chunks and Ink's
 *     native turn events drive interruption, partials, and finalization without
 *     a second VAD or endpointing layer.
 *   - LLM: `streamElizaConversation` (existing SSE / Cerebras pass-through). No
 *     new LLM client.
 *   - TTS: Fish Audio when `ELIZA_TTS_FISH_ENABLED` is true; otherwise
 *     `CartesiaSonicTtsAdapter` (#15949). The canonical route may explicitly
 *     commit safe, irrevocable sentence prefixes for early synthesis; every
 *     remaining terminal suffix is projected through the same shared safety
 *     policy before it can cross the provider boundary.
 *
 * Interruption (contract §7.5): telephony trusts Ink semantic turn-start;
 * browser/local sessions wait for confirmed caller words while local playback
 * pauses provisionally. Once authoritative, one `voiceTurnId` cancels TTS and
 * the Eliza SSE fetch, flushes pending speech, and emits `interrupted`.
 *
 * Metering (SEC-15): server-derived uplink duration only; the client is NEVER
 * trusted for cost. Every audio frame accrues real-time seconds against the
 * injected usage store; over-cap severs with `quota_exhausted`.
 *
 * SEC-6: the session registers a `sever()` with the live-session registry so a
 * revoke — same-worker or cross-device — stops uplink to Cartesia in <=500ms.
 */

import {
  type ChatTurnStatus,
  createVoiceProgressState,
  isVoiceProgressSpeechAuthorized,
  projectVoiceOutput,
  reduceVoiceProgress,
  type VoiceOutputPolicy,
  type VoiceProgressState,
} from "@elizaos/shared";
import {
  COMMITTED_SPEECH_PROTOCOL,
  type CommittedSpeechSegment,
} from "@elizaos/shared/voice/incremental-speech-segments";
import { scoreEndOfTurnHeuristic } from "@elizaos/shared/voice-eot";
import {
  CartesiaSonicTtsAdapter,
  type CartesiaSonicWordTimestamp,
  type CartesiaWebSocketFactory,
  VOICE_TTS_MAX_BUFFER_DELAY_MS,
} from "@/lib/services/cartesia-sonic-tts";
import {
  type FishAudioModel,
  FishAudioTtsAdapter,
  type FishAudioWebSocketFactory,
} from "@/lib/services/fish-audio-tts";
import type {
  VoiceUsageIdentity,
  VoiceUsageLimits,
  VoiceUsageStore,
} from "@/lib/services/voice-usage-meter";
import { logger } from "@/lib/utils/logger";
import {
  ElizaSseBridgeError,
  streamElizaConversation,
} from "@/lib/voice-session/eliza-sse-bridge";
import type {
  ServerControlFrame,
  VoiceTurnEndOutcome,
} from "@/lib/voice-session/protocol";
import {
  getVoiceSessionRegistry,
  type LiveVoiceSession,
  type VoiceSessionRegistry,
  type VoiceSessionSeverReason,
} from "@/lib/voice-session/session-registry";
import type {
  VoiceSessionDownlink,
  VoiceSessionLike,
} from "@/lib/voice-session/ws-handler";
import {
  type CartesiaInkRealtimeEvent,
  type CartesiaInkRealtimeSession,
  type CartesiaInkWebSocketFactory,
  createCartesiaInkRealtimeSession,
} from "../../stt/providers/cartesia-ink";
import {
  type VoiceResponseLease,
  VoiceSessionTurnAuthority,
} from "./turn-authority";
import { UplinkReframer } from "./uplink-reframer";

const PCM16_BYTES_PER_SECOND = 16_000 * 2; // 16kHz mono linear16.
/** Accrue metered minutes in whole seconds to keep the store's math simple. */
const METER_FLUSH_SECONDS = 5;
/** Nominal minutes charged on admission before ANY audio is forwarded (SEC-15). */
const ADMISSION_MINUTES = METER_FLUSH_SECONDS / 60;
/** Cap pre-admission buffered frames so an in-flight check can't be flooded. */
const MAX_PREADMISSION_FRAMES = 64; // ~5s of 80ms frames.
/** Cover provider WebSocket setup without dropping the user's first words. */
const MAX_PROVIDER_PENDING_FRAMES = 128; // ~12.8s of 100ms Ink frames.
/** How often a live session polls the durable revocation store (SEC-6). */
const REVOCATION_POLL_MS = 400;
/**
 * Max un-verified metered windows we forward ahead of confirmed quota. Each
 * window is ~5s; a couple of windows tolerates normal Redis latency, but a
 * store that can't keep up (or a faster-than-realtime flood) trips the guard
 * and severs fail-closed instead of streaming unbounded paid audio.
 */
const MAX_OUTSTANDING_METER_WINDOWS = 2;
/** Whole-answer speech is bounded before it crosses the provider boundary. */
const VOICE_TTS_MAX_SPEECH_CHARS = 600;
/**
 * The shared projector intentionally clamps smaller limits up to 40 chars so
 * ordinary standalone replies remain useful. A turn with less room left must
 * skip its terminal suffix instead of accidentally expanding that allowance.
 */
const VOICE_TTS_MIN_PROJECTABLE_SPEECH_CHARS = 40;
/** Human-readable interim captions do not benefit from provider-rate redraws. */
const STT_PARTIAL_EMIT_INTERVAL_MS = 40;
/**
 * Cold shared-runtime turns can cross several independent cache boundaries.
 * Retry the same trace/idempotency key long enough for their waitUntil fills to
 * land, while keeping the total first-turn penalty bounded below eight seconds.
 */
const CACHE_WARMING_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000] as const;
/** Replace a failed realtime recognizer without dropping the live phone call. */
const STT_RECONNECT_DELAYS_MS = [0, 250, 1_000, 2_000, 5_000] as const;
/** Consecutive revoke-store failures tolerated before the session fails closed. */
const MAX_REVOCATION_POLL_FAILURES = 3;
/**
 * Bound each outbound Ink upgrade so a dead socket advances to the next retry.
 * After the initial schedule, retries continue at the capped delay until the
 * call ends or Ink recovers.
 */
const STT_CONNECT_TIMEOUT_MS = 2_500;
/** Keep an unfinished provider final tentative long enough for resumed speech. */
const SEMANTIC_EOT_MERGE_WINDOW_MS = 900;
/** A provider turn that resumed but never finalized cannot hold memory forever. */
const SEMANTIC_EOT_MAX_HOLD_MS = 5_000;
const SEMANTIC_EOT_ACTIVE_RECHECK_MS = 100;
/**
 * Do not leave a conversational turn acoustically dead while the two-stage
 * Eliza response path is still working. The acknowledgement must precede the
 * user's practical barge-in window, while still giving a prewarmed Cerebras
 * turn time to complete directly. An arbitrary display delta is not speakable
 * output and therefore cannot satisfy or cancel this deadline.
 */
const VOICE_PROGRESS_SPOKEN_THRESHOLD_MS = 900;
const VOICE_PROGRESS_MAX_SPOKEN_UPDATES = 1;
/** Do not repeat the same generic acknowledgement across rapid voice turns. */
const VOICE_GENERIC_PROGRESS_COOLDOWN_MS = 20_000;
/** Retry one terminal phrase when a provider closes successfully with no PCM. */
const VOICE_TTS_ZERO_AUDIO_RETRY_LIMIT = 1;
/** Bound incremental display traffic while keeping the normal chat visibly live. */
const VOICE_DISPLAY_MAX_CHARS = 32_768;
const VOICE_DISPLAY_MIN_UPDATE_CHARS = 24;
const VOICE_DISPLAY_MAX_UPDATE_CHARS = 48;
const CACHE_WARMING_CODES = new Set([
  "agent_cache_warming",
  "shared_runtime_cache_warming",
  "conversation_cache_warming",
]);
const SPOKEN_TRANSCRIPT_RE = /[\p{L}\p{N}]/u;
const SPOKEN_STOP_COMMAND_RE =
  /^(?:(?:ok(?:ay)?|please),?\s+)?(?:stop(?:\s+(?:(?:talking|speaking)(?:\s+now)?|now))?|be\s+quiet|cancel|never\s*mind|that(?:['’]s| is)\s+enough)$/u;
const BARE_INTERROGATIVE_RE =
  /^(?:what|who|whom|whose|where|when|why|how|which)$/iu;
const VOICE_BACKCHANNELS = new Set([
  "ah",
  "aha",
  "alright",
  "got it",
  "ha",
  "haha",
  "mhm",
  "mm",
  "mm hm",
  "mm hmm",
  "okay",
  "ok",
  "right",
  "sure",
  "uh huh",
  "yeah",
  "yep",
  "yes",
]);

// Cartesia's server buffers streamed transcript for up to 3000ms by default
// before starting synthesis, which measured ~2.7s of the speaking_start gap on
// staging even after phrases were sent early (#16607). The cap now lives with
// the adapter (VOICE_TTS_MAX_BUFFER_DELAY_MS) so the evidence-harness
// reference server provably opens Cartesia with the same value (#16667).

export type { VoiceSessionDownlink } from "@/lib/voice-session/ws-handler";

export type AcousticInterruptPolicy = "semantic_start" | "confirmed_speech";

/**
 * Recognize only self-contained spoken cancellation commands. Longer requests
 * such as "stop the timer and start another" stay ordinary agent turns.
 */
export function isSpokenStopCommand(transcript: string): boolean {
  const normalized = transcript
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[.!?,;:\u2026]+$/gu, "")
    .replace(/\s+/gu, " ");
  return SPOKEN_STOP_COMMAND_RE.test(normalized);
}

/** Short listener acknowledgements should not seize an active voice turn. */
export function isVoiceBackchannel(transcript: string): boolean {
  const normalized = transcript
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
  return VOICE_BACKCHANNELS.has(normalized);
}

function shouldHoldSemanticFinal(transcript: string): boolean {
  const normalized = transcript.trim();
  if (!SPOKEN_TRANSCRIPT_RE.test(normalized)) return false;
  if (isSpokenStopCommand(normalized)) return false;
  return (
    BARE_INTERROGATIVE_RE.test(normalized) ||
    scoreEndOfTurnHeuristic(normalized) < 0.5
  );
}

/** Join provider-final fragments without repeating overlap from revised text. */
function mergeTranscriptFragments(
  prefix: string,
  continuation: string,
): string {
  const left = prefix.trim();
  const right = continuation.trim();
  if (!left) return right;
  if (!right) return left;
  const leftLower = left.toLocaleLowerCase("en-US");
  const rightLower = right.toLocaleLowerCase("en-US");
  if (rightLower === leftLower || rightLower.startsWith(`${leftLower} `)) {
    return right;
  }
  if (leftLower.endsWith(` ${rightLower}`)) return left;
  const leftWords = left.split(/\s+/u);
  const rightWords = right.split(/\s+/u);
  const maxOverlap = Math.min(leftWords.length, rightWords.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    const leftSuffix = leftWords.slice(-overlap).join(" ").toLocaleLowerCase();
    const rightPrefix = rightWords
      .slice(0, overlap)
      .join(" ")
      .toLocaleLowerCase();
    if (leftSuffix === rightPrefix) {
      return [...leftWords, ...rightWords.slice(overlap)].join(" ");
    }
  }
  return `${left} ${right}`;
}

function boundedProgressName(value: string | undefined): string | null {
  if (!value) return null;
  const normalized = value
    .replace(/[_-]+/gu, " ")
    .replace(/[^\p{L}\p{N}. ]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 64);
  return normalized || null;
}

/**
 * Cartesia concatenates inputs on one context byte-for-byte. The committed
 * speech projector intentionally normalizes leading whitespace, while source
 * ranges retain it; restore exactly one safe separator for every continuation
 * whose authoritative source begins with whitespace. Without this, sentence
 * phrases become `first.Second` at the provider boundary and can produce
 * garbled or misleading audio despite correct captions.
 */
function withAuthoritativeTtsSeparator(
  sourceText: string,
  speechText: string,
  hasPriorSpeech: boolean,
): string {
  if (!hasPriorSpeech || !/^\s/u.test(sourceText) || /^\s/u.test(speechText)) {
    return speechText;
  }
  return ` ${speechText}`;
}

function progressForStatus(status: ChatTurnStatus): {
  phase: string;
  displayMarkdown: string;
  spokenCandidate: string;
} | null {
  switch (status.kind) {
    case "thinking": {
      const text = "Yeah, one sec.";
      return {
        phase: status.kind,
        displayMarkdown: text,
        spokenCandidate: text,
      };
    }
    case "waking": {
      const text = "Just a sec, I'm getting ready.";
      return {
        phase: status.kind,
        displayMarkdown: text,
        spokenCandidate: text,
      };
    }
    case "evaluating": {
      const text = "Let me think for a second.";
      return {
        phase: status.kind,
        displayMarkdown: text,
        spokenCandidate: text,
      };
    }
    case "streaming":
      return null;
    case "running_action": {
      const name = boundedProgressName(status.actionName);
      if (!name) return null;
      const text = `I’m working on ${name.toLocaleLowerCase("en-US")}.`;
      return {
        phase: status.kind,
        displayMarkdown: text,
        spokenCandidate: text,
      };
    }
    case "running_tool": {
      const name = boundedProgressName(status.toolName);
      if (!name) return null;
      const text = `I’m checking ${name.toLocaleLowerCase("en-US")}.`;
      return {
        phase: status.kind,
        displayMarkdown: text,
        spokenCandidate: text,
      };
    }
    case "speaking":
      return null;
    default:
      return null;
  }
}

export interface VoiceSessionConfig {
  sessionId: string;
  jti: string;
  organizationId: string;
  userId: string;
  agentId: string;
  conversationId: string;
  /** Unix-seconds expiry of the bootstrap token; the session self-severs at exp. */
  tokenExpSeconds: number;
  /** Browser/local audio waits for real words; telephony clears on turn-start. */
  acousticInterruptPolicy: AcousticInterruptPolicy;

  // Provider wiring (injectable for tests: fake transports, real adapter code).
  cartesiaApiKey: string;
  cartesiaInkWebSocketFactory: CartesiaInkWebSocketFactory;
  cartesiaVoiceId: string;
  cartesiaWebSocketFactory: CartesiaWebSocketFactory;
  fishAudioEnabled?: boolean;
  fishAudioApiKey?: string;
  fishAudioReferenceId?: string;
  fishAudioModel?: FishAudioModel;
  fishAudioSampleRate?: number;
  fishAudioFirstAudioTimeoutMs?: number;
  fishAudioWebSocketFactory?: FishAudioWebSocketFactory;

  // LLM leg.
  elizaEndpoint: string;
  elizaAuthorization: string;
  elizaModel: string;
  fetchImpl?: typeof fetch;
  /** Session-start DB/tenancy warmup, injected only by the live Worker route. */
  prewarmElizaContext?: () => Promise<void>;
  /** Optional provider-synthesized opener that runs while agent context warms. */
  openingGreeting?: string;
  /** Optional canonical agent turn that generates and persists the opener. */
  openingPrompt?: string;
  openingClientMessageId?: string;
  /** Deterministic test override; production uses bounded exponential backoff. */
  cacheWarmingRetryDelaysMs?: readonly number[];
  /** Deterministic test override for the bounded Ink reconnect schedule. */
  sttReconnectDelaysMs?: readonly number[];
  /** Deterministic test override for the Ink connection-establishment bound. */
  sttConnectTimeoutMs?: number;
  /** Deterministic test override; production holds unfinished finals for 900ms. */
  semanticEotMergeWindowMs?: number;
  /** Deterministic test override for a resumed provider turn that never ends. */
  semanticEotMaxHoldMs?: number;
  /** Deterministic test override; production waits 900ms before one preamble. */
  voiceProgressSpokenThresholdMs?: number;
  /** Deterministic test override for the bounded pending-audio queue. */
  sttPendingFrameLimit?: number;

  // Metering (SEC-15). Server-derived only.
  usageStore: VoiceUsageStore;
  usageLimits: VoiceUsageLimits;

  downlink: VoiceSessionDownlink;
  registry?: VoiceSessionRegistry;
  now?: () => number;
  /**
   * Durable revocation check (SEC-6 cross-worker). When provided, the live
   * session polls it and self-severs if its own jti was revoked on another
   * worker. Omit in unit tests that don't exercise cross-worker revoke.
   */
  isRevoked?: (jti: string) => Promise<boolean>;
  /**
   * Revoke the bootstrap token's jti when the session ends. Called on ANY
   * teardown (bye/close/error/revoke) so a leaked/replayed token cannot open a
   * second paid session within the token's remaining TTL. Best-effort.
   */
  onTeardownRevoke?: (jti: string, expSeconds: number) => Promise<void>;
  /** Persist transport lifecycle after the synchronous session is safely closed. */
  onTeardown?: (reason: VoiceSessionSeverReason) => Promise<void>;
}

type SessionState =
  | "ready"
  | "listening"
  | "transcribing"
  | "thinking"
  | "speaking"
  | "interrupted"
  | "closed";

interface VoiceInterruptionContext {
  readonly traceId: string;
  readonly playedAudioMs: number;
  readonly heardText?: string;
}

interface VoiceSessionInterruptionAbortReason extends VoiceInterruptionContext {
  readonly code: "VOICE_SESSION_INTERRUPTION";
  readonly kind: "acoustic" | "explicit";
}

export class VoiceSession implements LiveVoiceSession, VoiceSessionLike {
  readonly sessionId: string;
  readonly jti: string;
  readonly organizationId: string;
  readonly userId: string;

  private readonly config: VoiceSessionConfig;
  private readonly registry: VoiceSessionRegistry;
  private readonly now: () => number;
  private readonly turnAuthority: VoiceSessionTurnAuthority;
  private readonly reframer = new UplinkReframer();
  private readonly usageIdentity: VoiceUsageIdentity;

  private stt: CartesiaInkRealtimeSession | null = null;
  private sttReady = false;
  private sttGeneration = 0;
  private sttReconnectAttempts = 0;
  private sttReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private sttConnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly providerPendingFrames: ArrayBuffer[] = [];
  private sttBufferOverflowReported = false;
  private readonly cartesiaAdapter: CartesiaSonicTtsAdapter;
  private readonly fishAudioAdapter: FishAudioTtsAdapter | null = null;
  private ttsStream: RealtimeTtsStream | null = null;
  private currentTtsWordTimings: CartesiaSonicWordTimestamp[] = [];
  private currentPlayoutCheckpoint: VoiceInterruptionContext | null = null;

  private state: SessionState = "ready";
  private started = false;
  private closed = false;
  private startedAtMs: number | null = null;

  /** Monotonic turn counter; the current turn's trace id derives from it. */
  private turnCounter = 0;
  private currentTraceId: string | null = null;
  private activeSttTurn = false;
  /** Active response protected from a browser/local false acoustic start. */
  private protectedResponseTraceId: string | null = null;
  private protectedProvisionalUplinkBytes = 0;
  private backchannelNotified = false;
  private pendingSttPartial: { text: string; traceId: string } | null = null;
  private lastSttPartialText = "";
  private lastSttPartialSentAtMs = Number.NEGATIVE_INFINITY;
  private sttPartialTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingSemanticEot: {
    prefix: string;
    continuation: string;
    startedAtMs: number;
  } | null = null;
  private semanticEotTimer: ReturnType<typeof setTimeout> | null = null;
  private llmAbort: AbortController | null = null;
  private turnSttMs = 0;
  /** Per-turn telemetry remainder; quota accounting has a separate accumulator. */
  private turnUnmeteredUplinkBytes = 0;
  private turnTtsChars = 0;
  private firstLlmTextEmitted = false;
  private lastGenericProgressSpeechAtMs = Number.NEGATIVE_INFINITY;

  // Metering accrual (server-derived): count uplink bytes, convert to seconds.
  private unmeteredUplinkBytes = 0;
  private meteredExhausted = false;
  private meteringAdmitted = false;
  private admissionInFlight = false;
  private meterWindowsInFlight = 0;
  private readonly preAdmissionFrames: ArrayBuffer[] = [];
  private revocationPoll: ReturnType<typeof setInterval> | null = null;
  private revocationPollFailures = 0;
  private revocationPollInFlight = false;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private isRevoked: ((jti: string) => Promise<boolean>) | null = null;

  constructor(config: VoiceSessionConfig) {
    this.config = config;
    this.sessionId = config.sessionId;
    this.jti = config.jti;
    this.organizationId = config.organizationId;
    this.userId = config.userId;
    this.registry = config.registry ?? getVoiceSessionRegistry();
    this.isRevoked = config.isRevoked ?? null;
    this.now = config.now ?? Date.now;
    this.turnAuthority = new VoiceSessionTurnAuthority({
      sessionId: config.sessionId,
      now: this.now,
      // Ink semantic-EOT repair is complete before this adapter commits the
      // response, so do not stack the coordinator's generic merge hold on top.
      sealCommittedTurns: true,
    });
    this.usageIdentity = {
      organizationId: config.organizationId,
      userId: config.userId,
    };
    this.cartesiaAdapter = new CartesiaSonicTtsAdapter({
      apiKey: config.cartesiaApiKey,
      voiceId: config.cartesiaVoiceId,
      websocketFactory: config.cartesiaWebSocketFactory,
    });
    if (
      config.fishAudioEnabled &&
      config.fishAudioApiKey &&
      config.fishAudioReferenceId &&
      config.fishAudioWebSocketFactory
    ) {
      this.fishAudioAdapter = new FishAudioTtsAdapter({
        apiKey: config.fishAudioApiKey,
        referenceId: config.fishAudioReferenceId,
        model: config.fishAudioModel,
        sampleRate: config.fishAudioSampleRate,
        firstAudioTimeoutMs: config.fishAudioFirstAudioTimeoutMs,
        websocketFactory: config.fishAudioWebSocketFactory,
      });
    }
  }

  /**
   * Open the Ink STT socket and register for revoke-to-silence. Emits `ready`.
   * Idempotent — a second `start()` is a no-op.
   */
  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    this.startedAtMs = this.now();

    this.openSttSession();

    this.registry.register(this);

    // Cross-worker revoke poll (SEC-6): if this session's jti is revoked on a
    // DIFFERENT worker (the same-worker path severs synchronously via the
    // registry), the poll observes it and self-severs within the poll window.
    if (this.isRevoked) {
      this.revocationPoll = setInterval(() => {
        void (async () => {
          if (this.closed || !this.isRevoked || this.revocationPollInFlight) {
            return;
          }
          this.revocationPollInFlight = true;
          try {
            if (await this.isRevoked(this.jti)) {
              this.teardown("revoked");
              return;
            }
            this.revocationPollFailures = 0;
          } catch (error) {
            this.revocationPollFailures += 1;
            logger.warn("[voice-session] revocation poll failed", {
              sessionId: this.sessionId,
              consecutiveFailures: this.revocationPollFailures,
              error: error instanceof Error ? error.message : String(error),
            });
            // error-policy:J4 fail-closed degrade — tolerate a brief store
            // blip, but sustained inability to verify revocation severs the
            // session within a bounded number of poll windows (SEC-6).
            if (this.revocationPollFailures >= MAX_REVOCATION_POLL_FAILURES) {
              this.teardown("revoked");
            }
          } finally {
            this.revocationPollInFlight = false;
          }
        })();
      }, REVOCATION_POLL_MS);
    }

    // Enforce the bootstrap token's expiry as a hard session ceiling: once the
    // 120s token (and its sessionId->jti directory entry) would expire, a
    // revoke could no longer resolve/observe the jti, so the socket must not
    // outlive it. Self-sever at exp.
    const nowSeconds = Math.floor(this.now() / 1000);
    const msUntilExp = Math.max(
      0,
      (this.config.tokenExpSeconds - nowSeconds) * 1000,
    );
    this.expiryTimer = setTimeout(() => {
      if (!this.closed) this.teardown("expired");
    }, msUntilExp);

    this.state = "listening";
    // Read immutable tenancy from cache while the user is beginning to speak.
    // A miss schedules authoritative hydration under the Worker lifetime. This
    // is a latency hint only: the response path has its own typed cache-warming
    // retries and must never wait indefinitely for optional background fills.
    if (this.config.prewarmElizaContext) {
      void this.config.prewarmElizaContext().catch((error) => {
        // error-policy:J7 prewarm is latency-only; the response path retains
        // its typed cache-warming retry fallback and reports the failed hint.
        logger.warn("[voice-session] Eliza context prewarm failed", {
          sessionId: this.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    // The session-level trace span id is stable until the first turn mints its own.
    const sessionTrace = this.mintTraceId("session");
    this.currentTraceId = sessionTrace;
    this.send({ t: "ready", sessionId: this.sessionId, traceId: sessionTrace });
    if (this.config.openingPrompt?.trim()) {
      const traceId = this.mintTraceId("turn");
      this.currentTraceId = traceId;
      const lease = this.turnAuthority.commitResponse(traceId);
      this.state = "thinking";
      void this.runResponseTurn(this.config.openingPrompt.trim(), lease, {
        messageRole: "system",
        clientMessageId: this.config.openingClientMessageId,
      });
    } else if (this.config.openingGreeting?.trim()) {
      this.speakOpeningGreeting(this.config.openingGreeting.trim());
    }
  }

  /**
   * Push a client uplink audio chunk (PCM16). Re-frames to Ink chunk size and
   * meters server-derived seconds. Silently drops if the session is torn down.
   */
  pushUplinkAudio(bytes: Uint8Array): void {
    if (this.closed || this.meteredExhausted) return;

    // Fail-closed admission (SEC-15): NO audio is forwarded to the paid provider
    // until an initial quota check has PASSED. Frames that arrive before the
    // first admission resolves are re-framed and buffered (bounded); if
    // admission is denied or the metering store errors, the session severs and
    // those buffered frames are never sent. A client that streams faster than
    // real time cannot outrun the gate because forwarding is blocked on it.
    const frames = this.reframer.push(bytes);
    this.accrueUplink(bytes.byteLength);
    if (this.meteredExhausted) return;

    if (!this.meteringAdmitted) {
      for (const f of frames) this.preAdmissionFrames.push(f);
      this.ensureAdmission();
      // Bound the pre-admission buffer so a flood cannot pin memory while the
      // check is in flight; over the bound, sever fail-closed.
      if (this.preAdmissionFrames.length > MAX_PREADMISSION_FRAMES) {
        this.meteredExhausted = true;
        this.send({
          t: "error",
          code: "metering_unavailable",
          retryable: false,
        });
        this.teardown("error");
      }
      return;
    }

    // Ongoing metering back-pressure (SEC-15): if the metering store is slower
    // than realtime, un-verified metered windows pile up. Bound how far ahead
    // of confirmed quota we forward; over the bound, fail closed rather than
    // stream unbounded paid audio while checks lag.
    if (this.meterWindowsInFlight > MAX_OUTSTANDING_METER_WINDOWS) {
      this.meteredExhausted = true;
      this.send({
        t: "error",
        code: "metering_backpressure",
        retryable: false,
      });
      this.teardown("error");
      return;
    }

    for (const frame of frames) if (!this.forwardSttFrame(frame)) return;
  }

  /** Queue audio until Ink is ready, then preserve its original frame order. */
  private forwardSttFrame(frame: ArrayBuffer): boolean {
    if (this.closed) return false;
    if (!this.stt || !this.sttReady) {
      this.providerPendingFrames.push(frame);
      const pendingLimit =
        this.config.sttPendingFrameLimit ?? MAX_PROVIDER_PENDING_FRAMES;
      if (this.providerPendingFrames.length <= pendingLimit) {
        return true;
      }
      // Retain a bounded rolling window of the newest caller audio while Ink
      // reconnects. Metering and byte-rate checks still run before this queue,
      // so provider downtime cannot create unbounded memory or paid usage.
      this.providerPendingFrames.shift();
      if (!this.sttBufferOverflowReported) {
        this.sttBufferOverflowReported = true;
        logger.warn("[voice-session] Ink pending-audio buffer rolled over", {
          sessionId: this.sessionId,
          pendingFrameLimit: pendingLimit,
        });
        this.send({
          t: "error",
          code: "provider_unavailable",
          retryable: true,
        });
      }
      return true;
    }
    try {
      this.stt.sendAudioChunk(frame);
      return true;
    } catch {
      // error-policy:J6 best-effort teardown race — a closed/closing Ink
      // socket after a concurrent sever; stop forwarding.
      return false;
    }
  }

  /**
   * Run the one-time admission quota check, then release buffered frames. This
   * is what makes forwarding fail-closed: nothing reaches Cartesia until
   * `checkAndRecord` returns allowed.
   */
  private ensureAdmission(): void {
    if (
      this.admissionInFlight ||
      this.meteringAdmitted ||
      this.meteredExhausted
    )
      return;
    this.admissionInFlight = true;
    void (async () => {
      try {
        const decision = await this.config.usageStore.checkAndRecord(
          this.usageIdentity,
          ADMISSION_MINUTES,
          this.config.usageLimits,
        );
        if (this.closed) return;
        if (!decision.allowed) {
          this.meteredExhausted = true;
          this.send({ t: "error", code: "quota_exhausted", retryable: false });
          this.teardown("quota_exhausted");
          return;
        }
        this.meteringAdmitted = true;
        this.turnSttMs += Math.round(ADMISSION_MINUTES * 60_000);
        // Release the buffered frames now that we are admitted.
        const buffered = this.preAdmissionFrames.splice(0);
        for (const frame of buffered) if (!this.forwardSttFrame(frame)) break;
      } catch {
        // error-policy:J4 fail-closed degrade — a metering-store failure must
        // not admit unpaid audio: surface metering_unavailable and sever.
        if (this.closed) return;
        this.meteredExhausted = true;
        this.send({
          t: "error",
          code: "metering_unavailable",
          retryable: false,
        });
        this.teardown("error");
      } finally {
        this.admissionInFlight = false;
      }
    })();
  }

  /** Explicit UI barge-in (contract §7.2). */
  bargeIn(context?: { traceId: string; playedAudioMs: number }): void {
    this.clearPendingSemanticEot();
    this.interrupt("explicit", context);
  }

  /** Cache the browser's paused-at-onset playout clock for Ink-confirmed speech. */
  playoutCheckpoint(context: { traceId: string; playedAudioMs: number }): void {
    const lease = this.turnAuthority.currentLease;
    if (!lease || lease.traceId !== context.traceId) return;
    this.currentPlayoutCheckpoint = context;
  }

  /** Client `bye`: complete the session cleanly. */
  bye(): void {
    this.teardown("completed");
  }

  // --- LiveVoiceSession (SEC-6) --------------------------------------------

  sever(reason: VoiceSessionSeverReason): void {
    this.teardown(reason);
  }

  // --- STT event handling ---------------------------------------------------

  private openSttSession(): void {
    const generation = ++this.sttGeneration;
    this.sttReady = false;
    this.stt = createCartesiaInkRealtimeSession({
      cartesiaApiKey: this.config.cartesiaApiKey,
      webSocketFactory: this.config.cartesiaInkWebSocketFactory,
      onEvent: (event) => this.onSttEvent(event, generation),
    });
    const timeoutMs = this.config.sttConnectTimeoutMs ?? STT_CONNECT_TIMEOUT_MS;
    const timer = setTimeout(() => {
      if (this.sttConnectTimer !== timer) return;
      this.sttConnectTimer = null;
      if (this.closed || generation !== this.sttGeneration || this.sttReady) {
        return;
      }
      logger.warn("[voice-session] Ink connection timed out", {
        sessionId: this.sessionId,
        attempt: this.sttReconnectAttempts,
        timeoutMs,
      });
      this.send({ t: "error", code: "stt_reconnecting", retryable: true });
      this.recoverSttTransport("connect_timeout", generation);
    }, timeoutMs);
    this.sttConnectTimer = timer;
  }

  private onSttEvent(
    event: CartesiaInkRealtimeEvent,
    generation: number,
  ): void {
    if (this.closed || generation !== this.sttGeneration) return;
    switch (event.type) {
      case "connected": {
        // Provider readiness is transport metadata; the client-facing session
        // has already emitted its own authenticated `ready` frame.
        this.sttReconnectAttempts = 0;
        this.sttReady = true;
        this.sttBufferOverflowReported = false;
        this.clearSttConnectTimeout();
        const buffered = this.providerPendingFrames.splice(0);
        for (const frame of buffered) if (!this.forwardSttFrame(frame)) break;
        break;
      }
      case "start-of-turn": {
        this.resetSttPartialDelivery();
        this.activeSttTurn = true;
        this.backchannelNotified = false;
        this.clearProtectedResponseAccounting();
        if (this.config.acousticInterruptPolicy === "semantic_start") {
          // Telephony has no local provisional playback gate, so Ink's semantic
          // start remains the earliest signal that can clear buffered audio.
          const responseActive = Boolean(this.turnAuthority.currentLease);
          this.interrupt("acoustic");
          if (!responseActive) this.config.downlink.clearAudio?.();
          this.state = "transcribing";
        } else {
          // Browser/local playback is paused provisionally on-device. Retain
          // the authoritative response until Ink confirms actual caller words,
          // allowing noise-only starts to resume without losing callbacks.
          const protectedLease = this.turnAuthority.currentLease;
          this.protectedResponseTraceId = protectedLease?.traceId ?? null;
          if (protectedLease) this.turnAuthority.provisionalSpeechStarted();
          if (!this.protectedResponseTraceId) {
            this.state = "transcribing";
          }
        }
        break;
      }
      case "transcript-update": {
        if (
          this.activeSttTurn &&
          event.transcript &&
          SPOKEN_TRANSCRIPT_RE.test(event.transcript)
        ) {
          if (
            this.protectedResponseTraceId &&
            isVoiceBackchannel(event.transcript)
          ) {
            if (!this.backchannelNotified) {
              this.send({
                t: "backchannel",
                traceId: this.protectedResponseTraceId,
              });
              this.backchannelNotified = true;
            }
            break;
          }
          this.backchannelNotified = false;
          this.interruptForConfirmedSpeech(event.transcript);
          this.updatePendingSemanticContinuation(event.transcript);
          this.queueSttPartial(this.semanticTranscript(event.transcript));
        }
        break;
      }
      case "eager-end-of-turn": {
        if (
          this.protectedResponseTraceId &&
          isVoiceBackchannel(event.transcript)
        ) {
          if (!this.backchannelNotified) {
            this.send({
              t: "backchannel",
              traceId: this.protectedResponseTraceId,
            });
            this.backchannelNotified = true;
          }
          break;
        }
        if (
          this.protectedResponseTraceId &&
          !SPOKEN_TRANSCRIPT_RE.test(event.transcript)
        ) {
          break;
        }
        this.interruptForConfirmedSpeech(event.transcript);
        this.updatePendingSemanticContinuation(event.transcript);
        this.flushSttPartial();
        this.send({
          t: "stt_eager_eot",
          traceId: this.currentTraceId ?? this.mintTraceId("turn"),
        });
        break;
      }
      case "end-of-turn": {
        if (!this.activeSttTurn) return;
        const providerTranscript = event.transcript ?? "";
        this.activeSttTurn = false;
        this.resetSttPartialDelivery();
        if (
          this.protectedResponseTraceId &&
          isVoiceBackchannel(providerTranscript)
        ) {
          const responseTraceId = this.protectedResponseTraceId;
          this.discardProtectedFalseStartAccounting();
          if (!this.backchannelNotified) {
            this.send({ t: "backchannel", traceId: responseTraceId });
          }
          this.backchannelNotified = false;
          break;
        }
        if (
          this.pendingSemanticEot &&
          !SPOKEN_TRANSCRIPT_RE.test(providerTranscript)
        ) {
          // A noise-only continuation cannot revoke the already-finalized
          // prefix. Keep the tentative turn alive until its original bound.
          this.armSemanticEotTimer();
          break;
        }
        if (
          this.protectedResponseTraceId &&
          !SPOKEN_TRANSCRIPT_RE.test(providerTranscript)
        ) {
          // A false browser/local acoustic start never owns the response turn.
          // Discard it without minting a trace, invalidating old callbacks, or
          // carrying its metered/partial audio into a later semantic turn.
          this.discardProtectedFalseStartAccounting();
          break;
        }
        const pendingStartedAtMs = this.pendingSemanticEot?.startedAtMs;
        const transcript = this.semanticTranscript(providerTranscript);
        if (isSpokenStopCommand(transcript)) {
          this.clearPendingSemanticEot();
          const confirmedUplinkBytes = this.detachProtectedSpeechAccounting();
          this.interrupt("explicit");
          this.accrueTurnTelemetry(confirmedUplinkBytes);
        } else {
          this.interruptForConfirmedSpeech(transcript);
        }
        if (shouldHoldSemanticFinal(transcript)) {
          this.holdSemanticEot(transcript, pendingStartedAtMs);
          break;
        }
        this.clearPendingSemanticEot();
        this.commitTurn(transcript);
        break;
      }
      case "turn-resumed": {
        // The user kept talking; the eager EOT was speculative. Stay listening.
        break;
      }
      case "error": {
        // Provider/protocol failures are explicit and terminate the current
        // turn; malformed input must not be reinterpreted as speech.
        this.activeSttTurn = false;
        this.resetSttPartialDelivery();
        if (event.code === "transport_error") {
          this.send({ t: "error", code: event.code, retryable: true });
          this.recoverSttTransport("transport_error", generation);
          break;
        }
        this.send({ t: "error", code: event.code, retryable: false });
        break;
      }
      case "close": {
        this.send({ t: "error", code: "stt_reconnecting", retryable: true });
        this.recoverSttTransport(`close:${event.code}`, generation);
        break;
      }
    }
  }

  /**
   * Replace a failed Ink socket while preserving the authenticated call.
   *
   * The generation fence makes the old socket's recursive close callback a
   * no-op. Any incomplete transcript is discarded because a new recognizer
   * cannot safely resume provider turn state; newly metered audio remains in
   * the bounded provider queue until the replacement emits `connected`.
   */
  private recoverSttTransport(reason: string, generation: number): void {
    if (this.closed || generation !== this.sttGeneration) return;
    this.clearSttConnectTimeout();
    const failed = this.stt;
    this.stt = null;
    this.sttReady = false;
    this.activeSttTurn = false;
    this.turnAuthority.rejectProvisionalSpeech();
    this.clearPendingSemanticEot();
    this.resetSttPartialDelivery();
    this.sttGeneration += 1;
    if (failed) {
      try {
        failed.cancel(`recover:${reason}`);
      } catch {
        // error-policy:J6 best-effort teardown of the failed recognizer; the
        // generation fence already prevents it from reaching session state.
      }
    }
    this.scheduleSttReconnect(reason);
  }

  private clearSttConnectTimeout(): void {
    if (this.sttConnectTimer === null) return;
    clearTimeout(this.sttConnectTimer);
    this.sttConnectTimer = null;
  }

  private scheduleSttReconnect(reason: string): void {
    if (this.closed || this.sttReconnectTimer !== null) return;
    const delays = this.config.sttReconnectDelaysMs ?? STT_RECONNECT_DELAYS_MS;
    const scheduledDelay = delays[this.sttReconnectAttempts];
    const delay = scheduledDelay ?? Math.max(delays.at(-1) ?? 5_000, 1_000);
    const retryingAtCap = scheduledDelay === undefined;
    this.sttReconnectAttempts += 1;
    if (retryingAtCap) {
      logger.warn(
        "[voice-session] Ink reconnect continuing at capped backoff",
        {
          sessionId: this.sessionId,
          reason,
          attempts: this.sttReconnectAttempts,
          delayMs: delay,
        },
      );
    }
    this.sttReconnectTimer = setTimeout(() => {
      this.sttReconnectTimer = null;
      if (this.closed) return;
      try {
        this.openSttSession();
      } catch (error) {
        // error-policy:J4 a replacement transport that cannot be constructed
        // stays visibly retrying, then fails the call closed at the bound.
        logger.warn("[voice-session] Ink reconnect failed", {
          sessionId: this.sessionId,
          reason,
          attempt: this.sttReconnectAttempts,
          error: error instanceof Error ? error.message : String(error),
        });
        this.scheduleSttReconnect(reason);
      }
    }, delay);
  }

  /** Cancel an active response only after Ink has produced caller words. */
  private interruptForConfirmedSpeech(transcript: string): void {
    if (
      this.config.acousticInterruptPolicy !== "confirmed_speech" ||
      !SPOKEN_TRANSCRIPT_RE.test(transcript)
    ) {
      return;
    }
    const confirmedUplinkBytes = this.detachProtectedSpeechAccounting();
    this.interrupt("acoustic");
    this.accrueTurnTelemetry(confirmedUplinkBytes);
    this.state = "transcribing";
  }

  private discardProtectedFalseStartAccounting(): void {
    // Provisional bytes never entered per-turn telemetry, so discarding a
    // noise-only start cannot mutate either the live response's accounting or
    // a response that completed while Ink was still evaluating the start.
    this.turnAuthority.rejectProvisionalSpeech();
    this.clearProtectedResponseAccounting();
  }

  /**
   * Remove provisional caller audio from the old response and return it for
   * attribution to the now-confirmed replacement turn. Billing remains
   * untouched and monotonic.
   */
  private detachProtectedSpeechAccounting(): number {
    if (!this.protectedResponseTraceId) return 0;
    const confirmedUplinkBytes = this.protectedProvisionalUplinkBytes;
    this.clearProtectedResponseAccounting();
    return confirmedUplinkBytes;
  }

  private clearProtectedResponseAccounting(): void {
    this.protectedResponseTraceId = null;
    this.protectedProvisionalUplinkBytes = 0;
  }

  /**
   * Ink can revise an interim transcript faster than a display can paint. Keep
   * the first revision immediate, retain only the newest pending revision, and
   * flush at a stable caption cadence. The final frame remains authoritative
   * and bypasses this path entirely.
   */
  private queueSttPartial(text: string): void {
    if (
      text === this.pendingSttPartial?.text ||
      (this.pendingSttPartial === null && text === this.lastSttPartialText)
    ) {
      return;
    }

    this.pendingSttPartial = {
      text,
      traceId: this.currentTraceId ?? this.mintTraceId("turn"),
    };
    const elapsedMs = this.now() - this.lastSttPartialSentAtMs;
    if (elapsedMs >= STT_PARTIAL_EMIT_INTERVAL_MS) {
      this.flushSttPartial();
      return;
    }

    if (this.sttPartialTimer !== null) return;
    this.sttPartialTimer = setTimeout(() => {
      this.sttPartialTimer = null;
      this.flushSttPartial();
    }, STT_PARTIAL_EMIT_INTERVAL_MS - elapsedMs);
  }

  private flushSttPartial(): void {
    if (this.sttPartialTimer !== null) {
      clearTimeout(this.sttPartialTimer);
      this.sttPartialTimer = null;
    }
    const partial = this.pendingSttPartial;
    this.pendingSttPartial = null;
    if (!partial || this.closed || partial.text === this.lastSttPartialText) {
      return;
    }
    this.lastSttPartialText = partial.text;
    this.lastSttPartialSentAtMs = this.now();
    this.send({ t: "stt_partial", ...partial });
  }

  private resetSttPartialDelivery(): void {
    if (this.sttPartialTimer !== null) {
      clearTimeout(this.sttPartialTimer);
      this.sttPartialTimer = null;
    }
    this.pendingSttPartial = null;
    this.lastSttPartialText = "";
    this.lastSttPartialSentAtMs = Number.NEGATIVE_INFINITY;
  }

  private semanticTranscript(providerTranscript: string): string {
    const pending = this.pendingSemanticEot;
    return pending
      ? mergeTranscriptFragments(pending.prefix, providerTranscript)
      : providerTranscript;
  }

  private updatePendingSemanticContinuation(transcript: string): void {
    if (!this.pendingSemanticEot || !SPOKEN_TRANSCRIPT_RE.test(transcript)) {
      return;
    }
    this.pendingSemanticEot.continuation = transcript.trim();
    this.armSemanticEotTimer();
  }

  private holdSemanticEot(
    transcript: string,
    originalStartedAtMs?: number,
  ): void {
    const existing = this.pendingSemanticEot;
    this.pendingSemanticEot = {
      prefix: transcript.trim(),
      continuation: "",
      startedAtMs: originalStartedAtMs ?? existing?.startedAtMs ?? this.now(),
    };
    this.state = "transcribing";
    const maxHoldMs = Math.max(
      1,
      this.config.semanticEotMaxHoldMs ?? SEMANTIC_EOT_MAX_HOLD_MS,
    );
    if (
      !this.activeSttTurn &&
      this.now() - this.pendingSemanticEot.startedAtMs >= maxHoldMs
    ) {
      const pending = this.pendingSemanticEot;
      this.clearPendingSemanticEot();
      this.commitTurn(
        mergeTranscriptFragments(pending.prefix, pending.continuation),
      );
      return;
    }
    this.armSemanticEotTimer();
  }

  private armSemanticEotTimer(): void {
    if (!this.pendingSemanticEot || this.closed) return;
    if (this.semanticEotTimer !== null) clearTimeout(this.semanticEotTimer);
    const mergeWindowMs = Math.max(
      1,
      this.config.semanticEotMergeWindowMs ?? SEMANTIC_EOT_MERGE_WINDOW_MS,
    );
    this.semanticEotTimer = setTimeout(() => {
      this.semanticEotTimer = null;
      this.onSemanticEotTimer();
    }, mergeWindowMs);
  }

  private onSemanticEotTimer(): void {
    const pending = this.pendingSemanticEot;
    if (!pending || this.closed) return;
    if (this.activeSttTurn) {
      // Never force-commit while Ink is still transcribing: doing so would
      // create one turn from the partial and a second when the provider later
      // emits its authoritative final. The provider's own silence/transport
      // bounds settle or reconnect this active turn.
      this.semanticEotTimer = setTimeout(() => {
        this.semanticEotTimer = null;
        this.onSemanticEotTimer();
      }, SEMANTIC_EOT_ACTIVE_RECHECK_MS);
      return;
    }
    const transcript = mergeTranscriptFragments(
      pending.prefix,
      pending.continuation,
    );
    this.clearPendingSemanticEot();
    this.commitTurn(transcript);
  }

  private clearPendingSemanticEot(): void {
    if (this.semanticEotTimer !== null) {
      clearTimeout(this.semanticEotTimer);
      this.semanticEotTimer = null;
    }
    this.pendingSemanticEot = null;
  }

  /** Authoritative user turn: mint the turn trace, run the LLM+TTS legs. */
  private commitTurn(transcript: string): void {
    const traceId = this.mintTraceId("turn");
    this.currentTraceId = traceId;
    // turnSttMs already holds the STT duration metered while this utterance's
    // audio was flowing (admission + ongoing windows); do NOT reset it or the
    // usage frame would under-report the duration the quota store was charged.
    this.turnTtsChars = 0;
    this.firstLlmTextEmitted = false;

    this.send({ t: "stt_final", text: transcript, traceId });
    this.send({ t: "trace_mark", name: "turn_committed", traceId });

    if (isSpokenStopCommand(transcript)) {
      // Spoken stop is a control command, not a semantic chat turn. It never
      // enters the conversation bridge or opens a synthesis context.
      this.turnAuthority.commitWithoutResponse(traceId, "control_stop");
      this.finishTurnWithoutResponse(traceId, "stopped");
      return;
    }

    if (!SPOKEN_TRANSCRIPT_RE.test(transcript)) {
      // Silence/noise/punctuation has no response leg. Report settlement and a
      // terminal outcome so clients cannot remain parked in Thinking.
      this.turnAuthority.commitWithoutResponse(traceId, "no_response");
      this.finishTurnWithoutResponse(traceId, "no_response");
      return;
    }

    const lease = this.turnAuthority.commitResponse(traceId);
    this.state = "thinking";
    void this.runResponseTurn(transcript, lease);
  }

  /** Speak a fixed live opener while the first agent context is warming. */
  private speakOpeningGreeting(text: string): void {
    if (this.closed || this.turnAuthority.currentLease) return;
    const traceId = this.mintTraceId("turn");
    this.currentTraceId = traceId;
    const lease = this.turnAuthority.commitResponse(traceId);
    this.turnTtsChars = text.length;
    this.firstLlmTextEmitted = false;

    const stream = this.createTtsStream(traceId, {
      onFirstAudio: () => {
        if (!this.turnAuthority.markSpeakingStarted(lease)) return;
        this.send({ t: "trace_mark", name: "tts_first_byte", traceId });
        this.state = "speaking";
        this.send({ t: "speaking_start", traceId });
      },
      onAudioFrame: (frame) => {
        if (!this.turnAuthority.isCurrent(lease)) return;
        this.turnAuthority.markAudioEnqueued(lease);
        this.config.downlink.sendAudio(frame.bytes);
      },
      onComplete: () => {
        if (!this.turnAuthority.isCurrent(lease)) return;
        this.send({ t: "speaking_end", traceId });
        this.finishTurn(lease, "spoken");
      },
      onProviderError: (error) => {
        if (!this.turnAuthority.isCurrent(lease)) return;
        this.send({
          t: "error",
          code: error.code ?? "tts_error",
          retryable: true,
        });
        this.finishTurn(lease, "error");
      },
    });
    this.ttsStream = stream;
    void stream.opened.catch(() => undefined);
    stream.sendPhrase({ text, continueContext: false });
  }

  private createTtsStream(
    traceId: string,
    callbacks: RealtimeTtsStreamCallbacks,
  ): RealtimeTtsStream {
    this.currentTtsWordTimings = [];
    this.currentPlayoutCheckpoint = null;
    const timedCallbacks: RealtimeTtsStreamCallbacks = {
      ...callbacks,
      onWordTimestamps: (event) => {
        this.recordTtsWordTimestamps(traceId, event.words);
        callbacks.onWordTimestamps?.(event);
      },
    };
    const createCartesia = () =>
      this.cartesiaAdapter.createStream(
        { traceId, maxBufferDelayMs: VOICE_TTS_MAX_BUFFER_DELAY_MS },
        timedCallbacks,
      );
    if (!this.fishAudioAdapter) return createCartesia();
    return new FishPrimaryRealtimeTtsStream({
      traceId,
      fishAudioAdapter: this.fishAudioAdapter,
      createCartesia,
      callbacks: timedCallbacks,
    });
  }

  private recordTtsWordTimestamps(
    traceId: string,
    incoming: readonly CartesiaSonicWordTimestamp[],
  ): void {
    if (traceId !== this.currentTraceId || incoming.length === 0) return;
    const current = this.currentTtsWordTimings;
    const first = incoming[0];
    if (!first) return;
    // Cartesia may publish either cumulative context timestamps or phrase-local
    // timestamps. Replace on a cumulative replay; otherwise offset a local
    // phrase behind the already-known context without duplicating words.
    if (
      current.length > 0 &&
      first.startMs === current[0]?.startMs &&
      first.word === current[0]?.word
    ) {
      this.currentTtsWordTimings = incoming.slice(0, 10_000);
      return;
    }
    const currentEnd = current.at(-1)?.endMs ?? 0;
    const offset = first.startMs < currentEnd ? currentEnd : 0;
    const appended = incoming.map((word) => ({
      ...word,
      startMs: word.startMs + offset,
      endMs: word.endMs + offset,
    }));
    this.currentTtsWordTimings = [...current, ...appended].slice(0, 10_000);
  }

  private heardTextAt(playedAudioMs: number): string | undefined {
    const heardWords = this.currentTtsWordTimings
      .filter((word) => word.endMs <= playedAudioMs + 15)
      .map((word) => word.word);
    if (heardWords.length === 0) return undefined;
    return heardWords
      .join(" ")
      .replace(/\s+([,.;:!?])/gu, "$1")
      .slice(0, 2_000);
  }

  private async runResponseTurn(
    transcript: string,
    lease: VoiceResponseLease,
    options: {
      messageRole?: "system";
      clientMessageId?: string;
    } = {},
  ): Promise<void> {
    const { traceId } = lease;
    const responseStartedAt = this.now();
    let firstModelTextAt: number | null = null;
    const abort = new AbortController();
    this.llmAbort = abort;
    this.turnAuthority.markModelStarted(lease);

    let tts: RealtimeTtsStream | null = null;
    let ttsGeneration = 0;
    let terminalTtsGeneration: number | null = null;
    let terminalTtsFrameFloor = 0;
    let terminalTtsText = "";
    let terminalTtsZeroAudioRetries = 0;
    const ttsFrameCounts = new Map<number, number>();
    let canonicalDisplayText = "";
    let lastDisplaySnapshot = "";
    let committedSpeechSourceEnd = 0;
    let committedSpeechChars = 0;
    let retainedCommittedTtsText = "";
    const sendDisplaySnapshot = (force = false): void => {
      if (!this.turnAuthority.isCurrent(lease) || abort.signal.aborted) return;
      const boundedCanonicalText = canonicalDisplayText.slice(
        0,
        VOICE_DISPLAY_MAX_CHARS,
      );
      const maxEnd = Math.min(
        boundedCanonicalText.length,
        lastDisplaySnapshot.length + VOICE_DISPLAY_MAX_UPDATE_CHARS,
      );
      let end = maxEnd;
      if (maxEnd < boundedCanonicalText.length) {
        // `lastIndexOf` includes its fromIndex. Searching at `maxEnd` and then
        // adding one for the space could therefore exceed the advertised
        // per-frame cap by one character.
        const wordBoundary = boundedCanonicalText.lastIndexOf(" ", maxEnd - 1);
        if (
          wordBoundary >
          lastDisplaySnapshot.length + VOICE_DISPLAY_MIN_UPDATE_CHARS
        ) {
          end = wordBoundary + 1;
        }
      }
      const text = boundedCanonicalText.slice(0, end);
      if (!text || text === lastDisplaySnapshot) return;
      const addedChars = text.length - lastDisplaySnapshot.length;
      const naturalBoundary = /(?:[.!?…:]|\n)\s*$/u.test(text);
      if (
        !force &&
        lastDisplaySnapshot &&
        addedChars < VOICE_DISPLAY_MIN_UPDATE_CHARS &&
        !naturalBoundary
      ) {
        return;
      }
      lastDisplaySnapshot = text;
      this.send({ t: "assistant_display", text, traceId });
    };
    const ensureTts = (): RealtimeTtsStream => {
      if (tts) return tts;
      const generation = ++ttsGeneration;
      ttsFrameCounts.set(generation, 0);
      let callbackStream: RealtimeTtsStream | null = null;
      const releaseNonterminalStream = (): void => {
        if (tts === callbackStream) tts = null;
        if (this.ttsStream === callbackStream) this.ttsStream = null;
      };
      const callbacks: RealtimeTtsStreamCallbacks = {
        onFirstAudio: () => {
          if (!this.turnAuthority.markSpeakingStarted(lease)) return;
          this.send({ t: "trace_mark", name: "tts_first_byte", traceId });
          const firstAudioAt = this.now();
          logger.info("[voice-session] first-turn latency", {
            traceId,
            transcriptChars: transcript.length,
            firstModelTextMs:
              firstModelTextAt === null
                ? null
                : firstModelTextAt - responseStartedAt,
            firstAudioMs: firstAudioAt - responseStartedAt,
            ttsAfterFirstTextMs:
              firstModelTextAt === null
                ? null
                : firstAudioAt - firstModelTextAt,
          });
          this.state = "speaking";
          this.send({ t: "speaking_start", traceId });
        },
        onAudioFrame: (frame) => {
          // Guard: no post-cancel / stale-turn frames ever reach the client.
          if (!this.turnAuthority.isCurrent(lease)) return;
          if (frame.bytes.byteLength > 0) {
            ttsFrameCounts.set(
              generation,
              (ttsFrameCounts.get(generation) ?? 0) + 1,
            );
          }
          this.turnAuthority.markAudioEnqueued(lease);
          this.config.downlink.sendAudio(frame.bytes);
        },
        onComplete: (event) => {
          if (!this.turnAuthority.isCurrent(lease)) return;
          if (terminalTtsGeneration !== generation) {
            // A truthful progress preamble intentionally leaves its Cartesia
            // context open for the eventual answer. The live provider can
            // close that idle context before a long model/tool turn finishes;
            // this is a phrase-context completion, not response settlement.
            // Release only that stream so the final answer can open a fresh
            // cancellable context under the same response lease.
            releaseNonterminalStream();
            return;
          }
          const terminalFrameCount = Math.max(
            event.frameCount,
            ttsFrameCounts.get(generation) ?? 0,
          );
          if (terminalFrameCount <= terminalTtsFrameFloor) {
            releaseNonterminalStream();
            if (
              terminalTtsText &&
              terminalTtsZeroAudioRetries < VOICE_TTS_ZERO_AUDIO_RETRY_LIMIT
            ) {
              terminalTtsZeroAudioRetries += 1;
              terminalTtsGeneration = null;
              logger.warn(
                "[voice-session] terminal TTS completed without audio; retrying once",
                {
                  traceId,
                  generation,
                  retry: terminalTtsZeroAudioRetries,
                },
              );
              queueMicrotask(() => {
                if (
                  !this.turnAuthority.isCurrent(lease) ||
                  abort.signal.aborted
                ) {
                  return;
                }
                sendTerminalTtsPhrase(terminalTtsText);
              });
              return;
            }
            this.send({ t: "error", code: "tts_no_audio", retryable: true });
            abort.abort();
            this.finishTurn(lease, "error");
            return;
          }
          this.send({ t: "speaking_end", traceId });
          this.finishTurn(lease, "spoken");
        },
        onProviderError: (err) => {
          if (!this.turnAuthority.isCurrent(lease)) return;
          if (terminalTtsGeneration !== generation) {
            // A speculative/progress context failure must not abort a still-
            // healthy model turn. The terminal answer gets one fresh provider
            // context; its own failure retains the normal explicit error path.
            releaseNonterminalStream();
            logger.warn("[voice-session] nonterminal TTS context failed", {
              traceId,
              errorClass: "TtsProviderError",
              code: err.code ?? "tts_error",
            });
            return;
          }
          this.send({
            t: "error",
            code: err.code ?? "tts_error",
            retryable: true,
          });
          // Prewarming means TTS can fail while the LLM is still generating.
          // Abort that upstream work before finishTurn clears the controller,
          // otherwise a failed voice turn can keep consuming model resources.
          abort.abort();
          // Close out the failed turn so the client gets usage + returns to
          // listening, instead of the session being stuck on a dead turn.
          this.finishTurn(lease, "error");
        },
      };
      callbackStream = this.createTtsStream(traceId, callbacks);
      tts = callbackStream;
      this.ttsStream = callbackStream;
      return callbackStream;
    };
    const sendTerminalTtsPhrase = (text: string): void => {
      const stream = ensureTts();
      terminalTtsGeneration = ttsGeneration;
      terminalTtsText = text;
      terminalTtsFrameFloor = ttsFrameCounts.get(ttsGeneration) ?? 0;
      stream.sendPhrase({ text, continueContext: false });
    };

    const progressOwner = {
      responseId: traceId,
      taskId: "agent-turn",
      ownerEpoch: this.turnCounter,
    } as const;
    let progressState: VoiceProgressState = createVoiceProgressState({
      ...progressOwner,
      atMs: this.now(),
    });
    let progressStatus: ChatTurnStatus = { kind: "thinking" };
    let progressTimer: ReturnType<typeof setTimeout> | null = null;
    const progressConfig = {
      spokenThresholdMs:
        this.config.voiceProgressSpokenThresholdMs ??
        VOICE_PROGRESS_SPOKEN_THRESHOLD_MS,
      maxSpokenUpdates: VOICE_PROGRESS_MAX_SPOKEN_UPDATES,
    } as const;
    const clearProgressTimer = () => {
      if (progressTimer !== null) {
        clearTimeout(progressTimer);
        progressTimer = null;
      }
    };
    const finishProgress = (type: "final" | "cancel") => {
      clearProgressTimer();
      progressState = reduceVoiceProgress(progressState, {
        ...progressOwner,
        type,
        atMs: this.now(),
      }).state;
    };
    const tryProgress = () => {
      progressTimer = null;
      if (
        abort.signal.aborted ||
        this.closed ||
        !this.turnAuthority.isCurrent(lease)
      ) {
        return;
      }
      const progressAtMs = this.now();
      if (
        progressStatus.kind === "thinking" &&
        progressAtMs - this.lastGenericProgressSpeechAtMs <
          VOICE_GENERIC_PROGRESS_COOLDOWN_MS
      ) {
        return;
      }
      const progress = progressForStatus(progressStatus);
      if (!progress) return;
      const transition = reduceVoiceProgress(
        progressState,
        {
          ...progressOwner,
          type: "progress",
          atMs: progressAtMs,
          ...progress,
          isSpecific: true,
          importance: "normal",
        },
        progressConfig,
      );
      progressState = transition.state;
      const start = transition.effects.find(
        (effect) => effect.type === "progress_speech/start",
      );
      if (
        !start ||
        !isVoiceProgressSpeechAuthorized(progressState, start.speechId) ||
        abort.signal.aborted ||
        !this.turnAuthority.isCurrent(lease)
      ) {
        return;
      }
      // Send the byte-equal caption before provider audio can arrive. The
      // phrase is fixed/bounded by the shared projector and shares the final
      // response's cancellable TTS context.
      this.send({
        t: "assistant_progress",
        text: start.speechText,
        traceId,
      });
      this.send({ t: "trace_mark", name: "speakable_text_ready", traceId });
      this.send({ t: "trace_mark", name: "tts_requested", traceId });
      this.turnTtsChars += start.speechText.length;
      if (progressStatus.kind === "thinking") {
        this.lastGenericProgressSpeechAtMs = progressAtMs;
      }
      ensureTts().sendPhrase({
        text: start.speechText,
        continueContext: true,
      });
    };
    const scheduleProgress = () => {
      clearProgressTimer();
      if (progressState.terminal || progressState.spokenUpdates > 0) return;
      const dueAt =
        progressState.startedAtMs +
        Math.max(0, progressConfig.spokenThresholdMs);
      progressTimer = setTimeout(tryProgress, Math.max(0, dueAt - this.now()));
    };
    const updateProgressStatus = (status: ChatTurnStatus) => {
      progressStatus = status;
      if (
        this.now() - progressState.startedAtMs >=
        progressConfig.spokenThresholdMs
      ) {
        clearProgressTimer();
        tryProgress();
      } else {
        scheduleProgress();
      }
    };
    abort.signal.addEventListener("abort", () => finishProgress("cancel"), {
      once: true,
    });

    try {
      // Open the provider in parallel with the LLM request. Whole-answer safety
      // intentionally delays text until the terminal frame, so overlapping the
      // DNS/TLS/WebSocket handshake preserves the latency work that can happen
      // safely. Interrupted or display-only turns cancel this idle context.
      const prewarmedTts = ensureTts();
      // Cancellation before the provider's open event rejects `opened`. This
      // turn does not await readiness because the final input queues in the
      // adapter, so consume that designed rejection on fast teardown.
      void prewarmedTts.opened.catch(() => undefined);
      scheduleProgress();

      const request = {
        endpoint: this.config.elizaEndpoint,
        authorization: this.config.elizaAuthorization,
        model: this.config.elizaModel,
        transcript,
        ...(options.messageRole ? { messageRole: options.messageRole } : {}),
        ...(options.clientMessageId
          ? { clientMessageId: options.clientMessageId }
          : {}),
        agentId: this.config.agentId,
        conversationId: this.config.conversationId,
        organizationId: this.config.organizationId,
        userId: this.config.userId,
        traceId,
        signal: abort.signal,
        fetchImpl: this.config.fetchImpl,
        onStatus: updateProgressStatus,
        onTaskEvent: (event: {
          phase: "call" | "commit" | "result" | "error";
          callId: string;
          lifetime?: "response" | "durable";
          effect?: "read_only" | "mutating";
          restartable?: boolean;
          commitCrossed: boolean;
        }) => {
          if (abort.signal.aborted || !this.turnAuthority.isCurrent(lease)) {
            return;
          }
          if (
            event.phase === "call" &&
            event.lifetime &&
            event.effect &&
            typeof event.restartable === "boolean"
          ) {
            this.turnAuthority.requestTask(lease, event.callId, {
              lifetime: event.lifetime,
              effect: event.effect,
              restartable: event.restartable,
            });
            return;
          }
          if (event.phase === "commit") {
            this.turnAuthority.markTaskCommitCrossed(event.callId);
            return;
          }
          if (event.commitCrossed) {
            this.turnAuthority.markTaskCommitCrossed(event.callId);
          }
          this.turnAuthority.settleTask(event.callId);
        },
        voiceSpeechProtocol: COMMITTED_SPEECH_PROTOCOL,
        onSpeechSegment: (segment: CommittedSpeechSegment) => {
          const segmentSourceText = canonicalDisplayText.slice(
            segment.sourceStart,
            segment.sourceEnd,
          );
          const ttsSegmentText = withAuthoritativeTtsSeparator(
            segmentSourceText,
            segment.speechText,
            segment.sourceStart > 0,
          );
          if (
            abort.signal.aborted ||
            !this.turnAuthority.isCurrent(lease) ||
            segment.sourceStart !== committedSpeechSourceEnd ||
            ttsSegmentText.length >
              VOICE_TTS_MAX_SPEECH_CHARS -
                this.turnTtsChars -
                retainedCommittedTtsText.length
          ) {
            return;
          }
          // The canonical route and bridge have independently projected and
          // validated this exact sentence. From this point it is irrevocable:
          // enqueue it immediately, and let a later terminal request close the
          // same provider context without repeating the prefix.
          finishProgress("final");
          committedSpeechSourceEnd = segment.sourceEnd;
          committedSpeechChars += segment.speechText.length;
          this.send({
            t: "trace_mark",
            name: "speakable_text_ready",
            traceId,
          });
          // Keep exactly one complete committed phrase in reserve. Cartesia
          // has no empty-text context-close control, so the final real phrase
          // must carry continue:false. When another segment arrives, the prior
          // phrase is proven nonterminal and can synthesize immediately without
          // splitting a sentence or degrading prosody.
          if (retainedCommittedTtsText) {
            this.turnTtsChars += retainedCommittedTtsText.length;
            this.send({ t: "trace_mark", name: "tts_requested", traceId });
            ensureTts().sendPhrase({
              text: retainedCommittedTtsText,
              continueContext: true,
              flush: true,
            });
          }
          retainedCommittedTtsText = ttsSegmentText;
        },
      };
      this.send({ t: "trace_mark", name: "router_decided", traceId });
      this.send({ t: "trace_mark", name: "llm_requested", traceId });
      const onDelta = (delta: string) => {
        if (!this.turnAuthority.isCurrent(lease)) return;
        if (!this.firstLlmTextEmitted) {
          this.firstLlmTextEmitted = true;
          firstModelTextAt = this.now();
          // A display-only delta may still be an incomplete sentence that is
          // intentionally unsafe to synthesize. Keep the bounded progress
          // deadline armed until a validated committed-speech segment or the
          // terminal projection actually makes the answer speakable.
          this.send({ t: "llm_first_text", traceId });
        }
        // Never forward an incremental fragment to synthesis. Secrets,
        // filesystem paths, code fences, and tables can all straddle arbitrary
        // SSE boundaries; only the terminal whole-answer projection may speak.
        canonicalDisplayText += delta;
        sendDisplaySnapshot();
      };
      const retryDelays =
        this.config.cacheWarmingRetryDelaysMs ?? CACHE_WARMING_RETRY_DELAYS_MS;
      let result: Awaited<ReturnType<typeof streamElizaConversation>>;
      for (let attempt = 0; ; attempt += 1) {
        try {
          result = await streamElizaConversation(request, onDelta);
          break;
        } catch (error) {
          const bridgeError =
            error instanceof ElizaSseBridgeError ? error : undefined;
          const retryDelay = retryDelays[attempt];
          if (
            retryDelay === undefined ||
            !bridgeError?.retryable ||
            bridgeError.status !== 503 ||
            !bridgeError.upstreamCode ||
            !CACHE_WARMING_CODES.has(bridgeError.upstreamCode) ||
            abort.signal.aborted ||
            !this.turnAuthority.isCurrent(lease)
          ) {
            throw error;
          }
          logger.info("[voice-session] retrying cold response turn", {
            traceId,
            attempt,
            retryDelayMs: retryDelay,
            upstreamCode: bridgeError.upstreamCode,
            elapsedMs: this.now() - responseStartedAt,
          });
          await new Promise<void>((resolve) => {
            const timeout = setTimeout(resolve, retryDelay);
            abort.signal.addEventListener(
              "abort",
              () => {
                clearTimeout(timeout);
                resolve();
              },
              { once: true },
            );
          });
          if (abort.signal.aborted || !this.turnAuthority.isCurrent(lease)) {
            return;
          }
        }
      }

      if (!this.turnAuthority.isCurrent(lease)) return; // interrupted mid-stream.

      if (result.aborted) {
        // Interruption already handled the teardown of this turn's TTS.
        finishProgress("cancel");
        return;
      }

      finishProgress("final");
      // Flush the final cumulative display before terminal metadata/TTS. This
      // keeps the chat visibly streaming without making fragments speakable.
      sendDisplaySnapshot(true);

      if (result.viewHandoff) {
        this.send({
          t: "navigate_view",
          viewId: result.viewHandoff.viewId,
          ...(result.viewHandoff.viewPath
            ? { viewPath: result.viewHandoff.viewPath }
            : {}),
          ...(result.viewHandoff.subview
            ? { subview: result.viewHandoff.subview }
            : {}),
          traceId,
        });
      }

      const policy = resolveRuntimeVoiceOutputPolicy(
        result.outputDirective?.policy,
      );
      if (
        committedSpeechSourceEnd > 0 &&
        result.outputDirective &&
        (policy !== "both" || result.outputDirective.spoken !== undefined)
      ) {
        throw new ElizaSseBridgeError(
          "Eliza agent terminal voice output contradicts committed speech",
          "protocol_error",
          undefined,
          undefined,
          false,
        );
      }
      const terminalSpeechSource = canonicalDisplayText.slice(
        committedSpeechSourceEnd,
      );
      const terminalTtsPrefix =
        committedSpeechSourceEnd > 0 && /^\s/u.test(terminalSpeechSource)
          ? " "
          : "";
      const remainingTtsChars = Math.max(
        0,
        VOICE_TTS_MAX_SPEECH_CHARS -
          this.turnTtsChars -
          retainedCommittedTtsText.length -
          terminalTtsPrefix.length,
      );
      const terminalProjectionSkippedForBudget =
        remainingTtsChars < VOICE_TTS_MIN_PROJECTABLE_SPEECH_CHARS;
      const terminalArtifacts = projectVoiceOutput({
        policy: "show",
        display: { markdown: "" },
        ...(result.outputDirective?.artifacts
          ? { artifacts: result.outputDirective.artifacts }
          : {}),
      }).artifacts;
      const projection = terminalProjectionSkippedForBudget
        ? null
        : projectVoiceOutput(
            {
              policy,
              display: { markdown: terminalSpeechSource },
              ...(result.outputDirective?.spoken === undefined
                ? {}
                : { spoken: result.outputDirective.spoken }),
              ...(result.outputDirective?.artifacts
                ? { artifacts: result.outputDirective.artifacts }
                : {}),
            },
            { maxSpeechChars: remainingTtsChars },
          );
      if (abort.signal.aborted || !this.turnAuthority.isCurrent(lease)) return;

      // Captions are the speech contract, not a separately normalized view.
      // A future projector regression must fail closed instead of sending bytes
      // that captions would misrepresent.
      const safeSpeechText =
        projection &&
        projection.captions === projection.speechText &&
        projection.captions !== null &&
        projection.captions.length <= remainingTtsChars
          ? `${terminalTtsPrefix}${projection.captions}`
          : null;
      const displayMarkdown = canonicalDisplayText.slice(
        0,
        VOICE_DISPLAY_MAX_CHARS,
      );
      this.send({
        t: "assistant_output",
        displayMarkdown,
        speechText: safeSpeechText,
        displayTruncated:
          displayMarkdown.length !== canonicalDisplayText.length,
        ...((projection?.artifacts.length ?? terminalArtifacts.length) > 0
          ? { artifacts: projection?.artifacts ?? terminalArtifacts }
          : {}),
        ...(result.messageId ? { messageId: result.messageId } : {}),
        traceId,
      });
      if (!safeSpeechText) {
        if (committedSpeechChars > 0) {
          if (SPOKEN_TRANSCRIPT_RE.test(retainedCommittedTtsText)) {
            // The retained tail is already part of a canonical committed speech
            // segment. Use those truthful, previously captioned bytes to close
            // the provider context; queued early audio then drains under the
            // normal onComplete authority. This also handles an unspeakable or
            // over-budget terminal display suffix without leaking it to TTS.
            this.turnTtsChars += retainedCommittedTtsText.length;
            this.send({ t: "trace_mark", name: "tts_requested", traceId });
            sendTerminalTtsPhrase(retainedCommittedTtsText);
            retainedCommittedTtsText = "";
            return;
          }
          // A later unsafe suffix cannot revoke audio that the canonical route
          // already committed. Stop this context after the safe prefix without
          // inventing filler or leaking the blocked suffix; the persisted prefix
          // remains truthful.
          this.send({
            t: "error",
            code: "terminal_speech_projection_blocked",
            retryable: false,
          });
          this.ttsStream?.cancel("terminal_speech_projection_blocked");
          this.finishTurn(lease, "error");
          return;
        }
        // The canonical route has already persisted/displayed non-empty output.
        // Cancel only the speculative provider context and report that truthful
        // outcome; `no_response` is reserved for an actually empty answer.
        this.ttsStream?.cancel(
          canonicalDisplayText ? "display_only_reply" : "empty_llm_reply",
        );
        this.finishTurn(
          lease,
          canonicalDisplayText ? "displayed" : "no_response",
        );
        return;
      }

      if (safeSpeechText) {
        this.send({ t: "trace_mark", name: "speakable_text_ready", traceId });
        if (retainedCommittedTtsText) {
          this.turnTtsChars += retainedCommittedTtsText.length;
          this.send({ t: "trace_mark", name: "tts_requested", traceId });
          ensureTts().sendPhrase({
            text: retainedCommittedTtsText,
            continueContext: true,
            flush: true,
          });
          retainedCommittedTtsText = "";
        }
        this.turnTtsChars += safeSpeechText.length;
        this.send({ t: "trace_mark", name: "tts_requested", traceId });
        sendTerminalTtsPhrase(safeSpeechText);
        return;
      }
    } catch (error) {
      finishProgress("cancel");
      // error-policy:J1 boundary translation — the LLM/TTS turn is the async
      // boundary; provider failures become a structured client `error` frame.
      if (!this.turnAuthority.isCurrent(lease)) return;
      const bridgeError =
        error instanceof ElizaSseBridgeError ? error : undefined;
      const hasRetainedCommittedSpeech = SPOKEN_TRANSCRIPT_RE.test(
        retainedCommittedTtsText,
      );
      logger.warn("[voice-session] Eliza response turn failed", {
        traceId,
        code: bridgeError?.upstreamCode ?? bridgeError?.code,
        status: bridgeError?.status,
        ...(bridgeError?.upstreamMessage
          ? { message: bridgeError.upstreamMessage }
          : {}),
        // Do not forward a writable Error.name from an arbitrary fetch/reader
        // implementation into logs. Provider-owned details belong only in the
        // bridge's bounded, sanitized diagnostic fields above.
        errorClass: bridgeError ? "ElizaSseBridgeError" : "UpstreamError",
      });
      this.send({
        t: "error",
        code: bridgeError
          ? (bridgeError.upstreamCode ?? bridgeError.code)
          : "llm_error",
        // A validated committed phrase owns this turn and the current socket
        // remains usable. Mark even an otherwise-fatal protocol error as a
        // retryable turn failure so the browser does not reconnect/flush its
        // playback queue before that irrevocable phrase drains.
        retryable: hasRetainedCommittedSpeech
          ? true
          : bridgeError
            ? bridgeError.retryable
            : true,
        ...(bridgeError?.status ? { upstreamStatus: bridgeError.status } : {}),
        ...(bridgeError?.upstreamMessage
          ? { upstreamMessage: bridgeError.upstreamMessage }
          : {}),
        ...(bridgeError?.upstreamSnippet
          ? { upstreamSnippet: bridgeError.upstreamSnippet }
          : {}),
      });
      if (hasRetainedCommittedSpeech) {
        // The canonical route already crossed the committed-speech boundary.
        // A later stream failure cannot revoke that persisted/captioned phrase.
        // Close with the retained real text (never an empty/filler request) and
        // let provider completion drain it before the spoken terminal.
        try {
          this.send({ t: "trace_mark", name: "tts_requested", traceId });
          sendTerminalTtsPhrase(retainedCommittedTtsText);
          this.turnTtsChars += retainedCommittedTtsText.length;
          retainedCommittedTtsText = "";
          return;
        } catch (ttsError) {
          // error-policy:J1 boundary translation — a synchronous provider
          // queue failure cannot escape the already-active response task.
          logger.warn(
            "[voice-session] retained speech terminalization failed",
            {
              traceId,
              errorClass: "TtsQueueError",
            },
          );
          this.ttsStream?.cancel("retained_speech_terminalization_failed");
          this.finishTurn(lease, "error");
          void ttsError;
          return;
        }
      }
      // The socket is already open because it was prewarmed before the LLM
      // request. Do not leak an idle provider connection when that request or
      // stream fails before a projected TTS input is sent. finishTurn has not
      // run yet, so ttsStream still belongs to this turn.
      this.ttsStream?.cancel("llm_error");
      this.finishTurn(lease, "error");
    }
  }

  private finishTurn(
    lease: VoiceResponseLease,
    outcome: VoiceTurnEndOutcome,
  ): void {
    if (this.closed || !this.turnAuthority.settle(lease, outcome)) return;
    this.finishTurnWithoutResponse(lease.traceId, outcome);
  }

  private finishTurnWithoutResponse(
    traceId: string,
    outcome: VoiceTurnEndOutcome,
  ): void {
    if (this.closed) return;
    if (outcome !== "spoken") {
      // Protocol-v1 clients do not know `turn_end`; this legacy terminal keeps
      // stop/no-response/error turns from remaining in Thinking. New clients
      // accept it as an idempotent terminal before the explicit outcome.
      this.send({ t: "speaking_end", traceId });
    }
    this.send({
      t: "usage",
      sttMs: this.turnSttMs,
      ttsChars: this.turnTtsChars,
      traceId,
    });
    this.send({ t: "turn_end", outcome, traceId });
    this.llmAbort = null;
    this.ttsStream = null;
    // Reset per-utterance accumulators now that this turn's usage is reported;
    // the next utterance's STT metering starts fresh.
    this.turnSttMs = 0;
    this.turnUnmeteredUplinkBytes = 0;
    this.turnTtsChars = 0;
    this.state = "listening";
  }

  /**
   * Interruption coordinator (§7.5). Everything below happens under the single
   * current response lease and is synchronous up to the point of emitting
   * `interrupted`, so no post-cancel audio can leak to the client.
   */
  private interrupt(
    reason: "acoustic" | "explicit",
    context?: VoiceInterruptionContext,
  ): void {
    const lease = this.turnAuthority.currentLease;
    const revoked =
      reason === "acoustic"
        ? this.turnAuthority.confirmSpeech(lease ? "auto" : "new_turn")
        : this.turnAuthority.explicitInterrupt();
    if (!lease || revoked !== lease) return; // no response work to cancel.
    const { traceId } = lease;
    const effectiveContext =
      context ?? this.currentPlayoutCheckpoint ?? undefined;
    const heardText = effectiveContext
      ? this.heardTextAt(effectiveContext.playedAudioMs)
      : undefined;
    // A stale/replayed browser checkpoint must never become context for the
    // current turn. The interrupt itself remains valid for older clients.
    const interruption =
      effectiveContext?.traceId === traceId
        ? ({
            code: "VOICE_SESSION_INTERRUPTION",
            kind: reason,
            traceId,
            playedAudioMs: effectiveContext.playedAudioMs,
            ...(heardText ? { heardText } : {}),
          } satisfies VoiceSessionInterruptionAbortReason)
        : undefined;
    this.currentPlayoutCheckpoint = null;

    // 1. The reducer published the revoked response FIRST, so every racing
    //    callback fails its exact lease check before provider cancellation.

    // 2. Cancel Cartesia — merged adapter guarantees no post-cancel frames.
    if (this.ttsStream) {
      this.ttsStream.cancel(`interrupted:${reason}`);
      this.ttsStream = null;
    }
    // 3. Abort the Eliza SSE fetch — cancels the upstream provider stream.
    if (this.llmAbort) {
      this.llmAbort.abort(interruption);
      this.llmAbort = null;
    }
    // 4. Report the interrupted turn's usage (STT accrued + TTS chars emitted so
    //    far) so the client sees accurate accounting, then reset the per-turn
    //    accumulators so this turn's duration is NOT carried into the next
    //    committed turn's usage frame.
    this.send({
      t: "usage",
      sttMs: this.turnSttMs,
      ttsChars: this.turnTtsChars,
      traceId,
    });
    this.turnSttMs = 0;
    this.turnUnmeteredUplinkBytes = 0;
    this.turnTtsChars = 0;
    this.llmAbort = null;
    // 5. Emit interrupted and return to listening.
    this.state = "interrupted";
    this.send({ t: "interrupted", reason, traceId });
    this.state = "listening";
  }

  // --- metering (SEC-15) ----------------------------------------------------

  private accrueUplink(byteLength: number): void {
    // Pre-admission audio is accounted by the ADMISSION_MINUTES charge; ongoing
    // metering only runs once admitted so we never double-charge the first
    // window nor stream uncapped before admission.
    if (!this.meteringAdmitted) return;
    if (this.protectedResponseTraceId) {
      this.protectedProvisionalUplinkBytes += byteLength;
    } else {
      this.accrueTurnTelemetry(byteLength);
    }
    this.unmeteredUplinkBytes += byteLength;
    const seconds = Math.floor(
      this.unmeteredUplinkBytes / PCM16_BYTES_PER_SECOND,
    );
    if (seconds < METER_FLUSH_SECONDS) return;
    this.unmeteredUplinkBytes -= seconds * PCM16_BYTES_PER_SECOND;
    this.meterWindowsInFlight += 1;
    void this.recordMeter(seconds / 60);
  }

  private accrueTurnTelemetry(byteLength: number): void {
    if (byteLength <= 0) return;
    this.turnUnmeteredUplinkBytes += byteLength;
    const seconds = Math.floor(
      this.turnUnmeteredUplinkBytes / PCM16_BYTES_PER_SECOND,
    );
    if (seconds <= 0) return;
    this.turnUnmeteredUplinkBytes -= seconds * PCM16_BYTES_PER_SECOND;
    this.turnSttMs += seconds * 1000;
  }

  private async recordMeter(minutes: number): Promise<void> {
    if (minutes <= 0 || this.meteredExhausted || this.closed) {
      this.meterWindowsInFlight = Math.max(0, this.meterWindowsInFlight - 1);
      return;
    }
    try {
      const decision = await this.config.usageStore.checkAndRecord(
        this.usageIdentity,
        minutes,
        this.config.usageLimits,
      );
      this.meterWindowsInFlight = Math.max(0, this.meterWindowsInFlight - 1);
      if (!decision.allowed) {
        this.meteredExhausted = true;
        this.send({ t: "error", code: "quota_exhausted", retryable: false });
        this.teardown("quota_exhausted");
      }
    } catch {
      this.meterWindowsInFlight = Math.max(0, this.meterWindowsInFlight - 1);
      // error-policy:J4 fail-closed degrade — if we cannot record the cost, we
      // do not keep streaming uncapped paid audio to Cartesia; sever.
      this.meteredExhausted = true;
      this.send({ t: "error", code: "metering_unavailable", retryable: false });
      this.teardown("error");
    }
  }

  // --- teardown -------------------------------------------------------------

  private teardown(reason: VoiceSessionSeverReason): void {
    if (this.closed) return;
    this.closed = true;
    this.state = "closed";
    logger.info("[voice-session] session closed", {
      sessionId: this.sessionId,
      reason,
      durationMs:
        this.startedAtMs === null
          ? 0
          : Math.max(0, Math.round(this.now() - this.startedAtMs)),
    });

    // Revoke the bootstrap token's jti on end so a leaked/replayed token cannot
    // open a SECOND paid session within its remaining TTL (the WS endpoint is
    // public and re-verifies hello; without this, a stolen token stays usable
    // until natural expiry). Best-effort and non-blocking.
    if (this.config.onTeardownRevoke) {
      void this.config
        .onTeardownRevoke(this.jti, this.config.tokenExpSeconds)
        .catch(() => {
          // error-policy:J6 best-effort teardown — revoke-on-end is defense in
          // depth; the token still dies at its <=120s TTL.
        });
    }
    if (this.config.onTeardown) {
      void this.config.onTeardown(reason).catch((error) => {
        // error-policy:J6 session closure is already committed; the durable
        // lifecycle marker is idempotent and may be recovered by provider retry.
        logger.warn("[voice-session] lifecycle teardown persistence failed", {
          sessionId: this.sessionId,
          reason,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }

    // Invalidate any live response so racing callbacks are dropped.
    this.turnAuthority.close();
    this.clearProtectedResponseAccounting();
    this.clearPendingSemanticEot();
    this.resetSttPartialDelivery();
    this.sttGeneration += 1;
    if (this.sttReconnectTimer !== null) {
      clearTimeout(this.sttReconnectTimer);
      this.sttReconnectTimer = null;
    }
    this.clearSttConnectTimeout();

    if (this.ttsStream) {
      try {
        this.ttsStream.cancel(`session:${reason}`);
      } catch {
        // error-policy:J6 best-effort teardown — cancel on an already-dead
        // Cartesia stream must not abort the rest of teardown.
      }
      this.ttsStream = null;
    }
    if (this.llmAbort) {
      this.llmAbort.abort();
      this.llmAbort = null;
    }
    if (this.stt) {
      try {
        this.stt.cancel(reason);
      } catch {
        // error-policy:J6 best-effort teardown — cancel on an already-closed
        // Ink socket must not abort the rest of teardown.
      }
      this.stt = null;
    }
    if (this.revocationPoll) {
      clearInterval(this.revocationPoll);
      this.revocationPoll = null;
    }
    if (this.expiryTimer) {
      clearTimeout(this.expiryTimer);
      this.expiryTimer = null;
    }
    this.preAdmissionFrames.length = 0;
    this.reframer.flush();
    this.registry.unregister(this.sessionId);

    // Tell the client why, then close the transport. `completed`/`client_disconnect`
    // are not errors; everything else is an error the client should see.
    if (reason !== "completed" && reason !== "client_disconnect") {
      this.send({ t: "error", code: reason, retryable: reason === "error" });
    }
    this.config.downlink.close(1000, reason);
  }

  private send(frame: ServerControlFrame): void {
    if (this.closed && frame.t !== "error") return;
    this.config.downlink.sendControl(frame);
  }

  private mintTraceId(kind: "session" | "turn"): string {
    if (kind === "turn") this.turnCounter += 1;
    const seq = kind === "turn" ? this.turnCounter : 0;
    return `${this.sessionId}:${kind}:${seq}:${Math.floor(this.now())}`;
  }

  /** Test/observability accessor. */
  get currentState(): SessionState {
    return this.state;
  }
}

interface RealtimeTtsPhraseInput {
  readonly text: string;
  readonly continueContext: boolean;
  readonly flush?: boolean;
  readonly duration?: number;
  readonly maxBufferDelayMs?: number;
}

interface RealtimeTtsStreamCallbacks {
  readonly onFirstAudio?: (event: { readonly elapsedMs: number }) => void;
  readonly onAudioFrame?: (event: { readonly bytes: Uint8Array }) => void;
  readonly onComplete?: (event: { readonly frameCount: number }) => void;
  readonly onProviderError?: (event: { readonly code?: string }) => void;
  readonly onWordTimestamps?: (event: {
    readonly words: readonly CartesiaSonicWordTimestamp[];
  }) => void;
}

interface RealtimeTtsStream {
  readonly opened: Promise<void>;
  readonly closed: Promise<void>;
  sendPhrase(phrase: RealtimeTtsPhraseInput): void;
  cancel(reason?: string): void;
}

/**
 * Fish is primary only until its first audio byte. The production realtime path
 * is `packages/cloud/api/v1/voice/session/lib/session.ts`: after Fish emits
 * audio, this wrapper never switches provider for that turn; before audio, a
 * connect error or first-audio timeout replays queued phrases to Cartesia.
 */
class FishPrimaryRealtimeTtsStream implements RealtimeTtsStream {
  readonly opened: Promise<void>;
  readonly closed: Promise<void>;

  private active: RealtimeTtsStream;
  private readonly phrases: RealtimeTtsPhraseInput[] = [];
  private fishAudioProduced = false;
  private usingCartesia = false;
  private cancelled = false;
  private suppressFishFallback = false;
  private resolveOpened!: () => void;
  private rejectOpened!: (error: unknown) => void;
  private openedSettled = false;
  private resolveClosed!: () => void;

  constructor(
    private readonly input: {
      readonly traceId: string;
      readonly fishAudioAdapter: FishAudioTtsAdapter;
      readonly createCartesia: () => RealtimeTtsStream;
      readonly callbacks: RealtimeTtsStreamCallbacks;
    },
  ) {
    this.opened = new Promise((resolve, reject) => {
      this.resolveOpened = resolve;
      this.rejectOpened = reject;
    });
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
    this.active = this.input.fishAudioAdapter.createStream(
      { traceId: input.traceId },
      {
        onFirstAudio: (event) => {
          this.fishAudioProduced = true;
          this.phrases.length = 0;
          this.resolveOpenedOnce();
          this.input.callbacks.onFirstAudio?.(event);
        },
        onAudioFrame: (event) => this.input.callbacks.onAudioFrame?.(event),
        onComplete: (event) => this.input.callbacks.onComplete?.(event),
        onProviderError: (event) => this.handleFishProviderError(event.code),
      },
    );
    this.watchActiveClosed(this.active);
    void this.active.opened
      .then(() => this.resolveOpenedOnce())
      .catch((error) => {
        if (!this.usingCartesia) this.rejectOpenedOnce(error);
      });
  }

  sendPhrase(phrase: RealtimeTtsPhraseInput): void {
    if (!this.usingCartesia && !this.fishAudioProduced)
      this.phrases.push(phrase);
    this.active.sendPhrase(
      this.usingCartesia
        ? phrase
        : {
            ...phrase,
            // Fish buffers short text events until its generation threshold.
            // Continuation inputs flush immediately; the final stop flushes
            // the terminal input itself.
            flush: phrase.continueContext || phrase.flush,
          },
    );
  }

  cancel(reason?: string): void {
    this.cancelled = true;
    this.rejectOpenedOnce(
      new Error(`Fish TTS stream cancelled${reason ? `: ${reason}` : ""}`),
    );
    this.active.cancel(reason);
  }

  private handleFishProviderError(code?: string): void {
    if (this.cancelled || this.suppressFishFallback) return;
    if (this.fishAudioProduced || !isFishPreAudioFallbackError(code)) {
      this.input.callbacks.onProviderError?.({
        code: code ?? "fish_tts_error",
      });
      this.rejectOpenedOnce(new Error(code ?? "fish_tts_error"));
      return;
    }
    this.usingCartesia = true;
    this.suppressFishFallback = true;
    this.active.cancel(`fish_pre_audio_fallback:${code ?? "provider_error"}`);
    this.suppressFishFallback = false;
    this.active = this.input.createCartesia();
    this.watchActiveClosed(this.active);
    void this.active.opened
      .then(() => this.resolveOpenedOnce())
      .catch((error) => this.rejectOpenedOnce(error));
    for (const phrase of this.phrases) this.active.sendPhrase(phrase);
    this.phrases.length = 0;
  }

  private resolveOpenedOnce(): void {
    if (this.openedSettled) return;
    this.openedSettled = true;
    this.resolveOpened();
  }

  private rejectOpenedOnce(error: unknown): void {
    if (this.openedSettled) return;
    this.openedSettled = true;
    this.rejectOpened(error);
  }

  private watchActiveClosed(stream: RealtimeTtsStream): void {
    void stream.closed.then(() => {
      if (this.active === stream) this.resolveClosed();
    });
  }
}

function isFishPreAudioFallbackError(code: string | undefined): boolean {
  return (
    code === "websocket_error" ||
    code === "websocket_closed_before_open" ||
    code === "first_audio_timeout"
  );
}

/** Resolve terminal output policy without pretending display can be hidden. */
function resolveRuntimeVoiceOutputPolicy(
  policy: VoiceOutputPolicy | undefined,
): Exclude<VoiceOutputPolicy, "say"> {
  // The normal chat route always persists and renders canonical text. Until a
  // display renderer can honor `say`, treating it as `both` is the only truthful
  // behavior. Legacy terminals also default to both; say-only is never inferred.
  return policy === undefined || policy === "say" ? "both" : policy;
}
