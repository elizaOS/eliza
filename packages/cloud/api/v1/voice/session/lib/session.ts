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
 *     `CartesiaSonicTtsAdapter` (#15949). Canonical assistant text is buffered
 *     through its explicit terminal frame, projected once through the shared
 *     speech/display safety policy, then sent as at most one synthesis input.
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

import { projectVoiceOutput, type VoiceOutputPolicy } from "@elizaos/shared";
import {
  CartesiaSonicTtsAdapter,
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
/** Human-readable interim captions do not benefit from provider-rate redraws. */
const STT_PARTIAL_EMIT_INTERVAL_MS = 40;
/**
 * Cold shared-runtime turns can cross several independent cache boundaries.
 * Retry the same trace/idempotency key long enough for their waitUntil fills to
 * land, while keeping the total first-turn penalty bounded below eight seconds.
 */
const CACHE_WARMING_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000] as const;
const CACHE_WARMING_CODES = new Set([
  "agent_cache_warming",
  "shared_runtime_cache_warming",
  "conversation_cache_warming",
]);
const SPOKEN_TRANSCRIPT_RE = /[\p{L}\p{N}]/u;
const SPOKEN_STOP_COMMAND_RE =
  /^(?:(?:ok(?:ay)?|please),?\s+)?(?:stop(?:\s+(?:(?:talking|speaking)(?:\s+now)?|now))?|be\s+quiet|cancel|never\s*mind|that(?:['’]s| is)\s+enough)$/u;

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
  /** Deterministic test override; production uses bounded exponential backoff. */
  cacheWarmingRetryDelaysMs?: readonly number[];

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
}

type SessionState =
  | "ready"
  | "listening"
  | "transcribing"
  | "thinking"
  | "speaking"
  | "interrupted"
  | "closed";

export class VoiceSession implements LiveVoiceSession, VoiceSessionLike {
  readonly sessionId: string;
  readonly jti: string;
  readonly organizationId: string;
  readonly userId: string;

  private readonly config: VoiceSessionConfig;
  private readonly registry: VoiceSessionRegistry;
  private readonly now: () => number;
  private readonly reframer = new UplinkReframer();
  private readonly usageIdentity: VoiceUsageIdentity;

  private stt: CartesiaInkRealtimeSession | null = null;
  private sttReady = false;
  private readonly providerPendingFrames: ArrayBuffer[] = [];
  private readonly cartesiaAdapter: CartesiaSonicTtsAdapter;
  private readonly fishAudioAdapter: FishAudioTtsAdapter | null = null;
  private ttsStream: RealtimeTtsStream | null = null;

  private state: SessionState = "ready";
  private started = false;
  private closed = false;

  /** Monotonic turn counter; the current turn's trace id derives from it. */
  private turnCounter = 0;
  private currentTraceId: string | null = null;
  private currentVoiceTurnId: string | null = null;
  private activeSttTurn = false;
  /** Active response protected from a browser/local false acoustic start. */
  private protectedResponseTraceId: string | null = null;
  private protectedProvisionalUplinkBytes = 0;
  private pendingSttPartial: { text: string; traceId: string } | null = null;
  private lastSttPartialText = "";
  private lastSttPartialSentAtMs = Number.NEGATIVE_INFINITY;
  private sttPartialTimer: ReturnType<typeof setTimeout> | null = null;
  private llmAbort: AbortController | null = null;
  private elizaPrewarm: Promise<void> | null = null;
  private turnSttMs = 0;
  /** Per-turn telemetry remainder; quota accounting has a separate accumulator. */
  private turnUnmeteredUplinkBytes = 0;
  private turnTtsChars = 0;
  private firstLlmTextEmitted = false;

  // Metering accrual (server-derived): count uplink bytes, convert to seconds.
  private unmeteredUplinkBytes = 0;
  private meteredExhausted = false;
  private meteringAdmitted = false;
  private admissionInFlight = false;
  private meterWindowsInFlight = 0;
  private readonly preAdmissionFrames: ArrayBuffer[] = [];
  private revocationPoll: ReturnType<typeof setInterval> | null = null;
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

    this.stt = createCartesiaInkRealtimeSession({
      cartesiaApiKey: this.config.cartesiaApiKey,
      webSocketFactory: this.config.cartesiaInkWebSocketFactory,
      onEvent: (event) => this.onSttEvent(event),
    });

    this.registry.register(this);

    // Cross-worker revoke poll (SEC-6): if this session's jti is revoked on a
    // DIFFERENT worker (the same-worker path severs synchronously via the
    // registry), the poll observes it and self-severs within the poll window.
    if (this.isRevoked) {
      this.revocationPoll = setInterval(() => {
        void (async () => {
          if (this.closed || !this.isRevoked) return;
          try {
            if (await this.isRevoked(this.jti)) this.teardown("revoked");
          } catch {
            // error-policy:J4 fail-closed degrade — a failing revocation check
            // must not keep a possibly-revoked session alive: sever (SEC-6).
            this.teardown("revoked");
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
    // A miss schedules authoritative hydration under the Worker lifetime; the
    // first turn joins that work so it does not burn time polling a cold cache.
    if (this.config.prewarmElizaContext) {
      this.elizaPrewarm = this.config.prewarmElizaContext().catch((error) => {
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
    if (this.config.openingGreeting?.trim()) {
      this.speakOpeningGreeting(this.config.openingGreeting.trim());
    }
  }

  /**
   * Push a client uplink audio chunk (PCM16). Re-frames to Ink chunk size and
   * meters server-derived seconds. Silently drops if the session is torn down.
   */
  pushUplinkAudio(bytes: Uint8Array): void {
    if (this.closed || !this.stt || this.meteredExhausted) return;

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
    if (this.closed || !this.stt) return false;
    if (!this.sttReady) {
      this.providerPendingFrames.push(frame);
      if (this.providerPendingFrames.length <= MAX_PROVIDER_PENDING_FRAMES) {
        return true;
      }
      this.meteredExhausted = true;
      this.send({
        t: "error",
        code: "provider_unavailable",
        retryable: true,
      });
      this.teardown("error");
      return false;
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
  bargeIn(): void {
    this.interrupt("explicit");
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

  private onSttEvent(event: CartesiaInkRealtimeEvent): void {
    if (this.closed) return;
    switch (event.type) {
      case "connected": {
        // Provider readiness is transport metadata; the client-facing session
        // has already emitted its own authenticated `ready` frame.
        this.sttReady = true;
        const buffered = this.providerPendingFrames.splice(0);
        for (const frame of buffered) if (!this.forwardSttFrame(frame)) break;
        break;
      }
      case "start-of-turn": {
        this.resetSttPartialDelivery();
        this.activeSttTurn = true;
        this.clearProtectedResponseAccounting();
        if (this.config.acousticInterruptPolicy === "semantic_start") {
          // Telephony has no local provisional playback gate, so Ink's semantic
          // start remains the earliest signal that can clear buffered audio.
          const responseActive = Boolean(this.currentVoiceTurnId);
          this.interrupt("acoustic");
          if (!responseActive) this.config.downlink.clearAudio?.();
          this.state = "transcribing";
        } else {
          // Browser/local playback is paused provisionally on-device. Retain
          // the authoritative response until Ink confirms actual caller words,
          // allowing noise-only starts to resume without losing callbacks.
          this.protectedResponseTraceId = this.currentVoiceTurnId;
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
          this.interruptForConfirmedSpeech(event.transcript);
          this.queueSttPartial(event.transcript);
        }
        break;
      }
      case "eager-end-of-turn": {
        if (
          this.protectedResponseTraceId &&
          !SPOKEN_TRANSCRIPT_RE.test(event.transcript)
        ) {
          break;
        }
        this.interruptForConfirmedSpeech(event.transcript);
        this.flushSttPartial();
        this.send({
          t: "stt_eager_eot",
          traceId: this.currentTraceId ?? this.mintTraceId("turn"),
        });
        break;
      }
      case "end-of-turn": {
        if (!this.activeSttTurn) return;
        const transcript = event.transcript ?? "";
        this.activeSttTurn = false;
        this.resetSttPartialDelivery();
        if (
          this.protectedResponseTraceId &&
          !SPOKEN_TRANSCRIPT_RE.test(transcript)
        ) {
          // A false browser/local acoustic start never owns the response turn.
          // Discard it without minting a trace, invalidating old callbacks, or
          // carrying its metered/partial audio into a later semantic turn.
          this.discardProtectedFalseStartAccounting();
          break;
        }
        if (isSpokenStopCommand(transcript)) {
          const confirmedUplinkBytes = this.detachProtectedSpeechAccounting();
          this.interrupt("explicit");
          this.accrueTurnTelemetry(confirmedUplinkBytes);
        } else {
          this.interruptForConfirmedSpeech(transcript);
        }
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
        this.resetSttPartialDelivery();
        this.send({ t: "error", code: event.code, retryable: false });
        break;
      }
      case "close": {
        // Provider closed. If we were mid-session and not already tearing down,
        // this is fatal for the turn; end the session so the client re-mints.
        if (!this.closed) this.teardown("error");
        break;
      }
    }
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
    if (this.currentVoiceTurnId) this.interrupt("acoustic");
    this.accrueTurnTelemetry(confirmedUplinkBytes);
    this.state = "transcribing";
  }

  private discardProtectedFalseStartAccounting(): void {
    // Provisional bytes never entered per-turn telemetry, so discarding a
    // noise-only start cannot mutate either the live response's accounting or
    // a response that completed while Ink was still evaluating the start.
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

  /** Authoritative user turn: mint the turn trace, run the LLM+TTS legs. */
  private commitTurn(transcript: string): void {
    const traceId = this.mintTraceId("turn");
    this.currentTraceId = traceId;
    this.currentVoiceTurnId = traceId;
    // turnSttMs already holds the STT duration metered while this utterance's
    // audio was flowing (admission + ongoing windows); do NOT reset it or the
    // usage frame would under-report the duration the quota store was charged.
    this.turnTtsChars = 0;
    this.firstLlmTextEmitted = false;

    this.send({ t: "stt_final", text: transcript, traceId });

    if (isSpokenStopCommand(transcript)) {
      // Spoken stop is a control command, not a semantic chat turn. It never
      // enters the conversation bridge or opens a synthesis context.
      this.finishTurn(traceId, "stopped");
      return;
    }

    if (!SPOKEN_TRANSCRIPT_RE.test(transcript)) {
      // Silence/noise/punctuation has no response leg. Report settlement and a
      // terminal outcome so clients cannot remain parked in Thinking.
      this.finishTurn(traceId, "no_response");
      return;
    }

    this.state = "thinking";
    void this.runResponseTurn(transcript, traceId);
  }

  /** Speak a fixed live opener while the first agent context is warming. */
  private speakOpeningGreeting(text: string): void {
    if (this.closed || this.currentVoiceTurnId) return;
    const traceId = this.mintTraceId("turn");
    this.currentTraceId = traceId;
    this.currentVoiceTurnId = traceId;
    this.turnTtsChars = text.length;
    this.firstLlmTextEmitted = false;

    const stream = this.createTtsStream(traceId, {
      onFirstAudio: () => {
        if (this.currentVoiceTurnId !== traceId) return;
        this.state = "speaking";
        this.send({ t: "speaking_start", traceId });
      },
      onAudioFrame: (frame) => {
        if (this.currentVoiceTurnId !== traceId) return;
        this.config.downlink.sendAudio(frame.bytes);
      },
      onComplete: () => {
        if (this.currentVoiceTurnId !== traceId) return;
        this.send({ t: "speaking_end", traceId });
        this.finishTurn(traceId, "spoken");
      },
      onProviderError: (error) => {
        if (this.currentVoiceTurnId !== traceId) return;
        this.send({
          t: "error",
          code: error.code ?? "tts_error",
          retryable: true,
        });
        this.finishTurn(traceId, "error");
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
    const createCartesia = () =>
      this.cartesiaAdapter.createStream(
        { traceId, maxBufferDelayMs: VOICE_TTS_MAX_BUFFER_DELAY_MS },
        callbacks,
      );
    if (!this.fishAudioAdapter) return createCartesia();
    return new FishPrimaryRealtimeTtsStream({
      traceId,
      fishAudioAdapter: this.fishAudioAdapter,
      createCartesia,
      callbacks,
    });
  }

  private async runResponseTurn(
    transcript: string,
    traceId: string,
  ): Promise<void> {
    const abort = new AbortController();
    this.llmAbort = abort;

    let tts: RealtimeTtsStream | null = null;
    let canonicalDisplayText = "";
    const ensureTts = (): RealtimeTtsStream => {
      if (tts) return tts;
      const callbacks: RealtimeTtsStreamCallbacks = {
        onFirstAudio: () => {
          if (this.currentVoiceTurnId !== traceId) return;
          this.state = "speaking";
          this.send({ t: "speaking_start", traceId });
        },
        onAudioFrame: (frame) => {
          // Guard: no post-cancel / stale-turn frames ever reach the client.
          if (this.currentVoiceTurnId !== traceId) return;
          this.config.downlink.sendAudio(frame.bytes);
        },
        onComplete: () => {
          if (this.currentVoiceTurnId !== traceId) return;
          this.send({ t: "speaking_end", traceId });
          this.finishTurn(traceId, "spoken");
        },
        onProviderError: (err) => {
          if (this.currentVoiceTurnId !== traceId) return;
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
          this.finishTurn(traceId, "error");
        },
      };
      tts = this.createTtsStream(traceId, callbacks);
      this.ttsStream = tts;
      return tts;
    };

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

      const elizaPrewarm = this.elizaPrewarm;
      if (elizaPrewarm) {
        await elizaPrewarm;
        if (this.elizaPrewarm === elizaPrewarm) this.elizaPrewarm = null;
        if (abort.signal.aborted || this.currentVoiceTurnId !== traceId) return;
      }

      const request = {
        endpoint: this.config.elizaEndpoint,
        authorization: this.config.elizaAuthorization,
        model: this.config.elizaModel,
        transcript,
        agentId: this.config.agentId,
        conversationId: this.config.conversationId,
        organizationId: this.config.organizationId,
        userId: this.config.userId,
        traceId,
        signal: abort.signal,
        fetchImpl: this.config.fetchImpl,
      };
      const onDelta = (delta: string) => {
        if (this.currentVoiceTurnId !== traceId) return;
        if (!this.firstLlmTextEmitted) {
          this.firstLlmTextEmitted = true;
          this.send({ t: "llm_first_text", traceId });
        }
        // Never forward an incremental fragment to synthesis. Secrets,
        // filesystem paths, code fences, and tables can all straddle arbitrary
        // SSE boundaries; only the terminal whole-answer projection may speak.
        canonicalDisplayText += delta;
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
            this.currentVoiceTurnId !== traceId
          ) {
            throw error;
          }
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
          if (abort.signal.aborted || this.currentVoiceTurnId !== traceId) {
            return;
          }
        }
      }

      if (this.currentVoiceTurnId !== traceId) return; // interrupted mid-stream.

      if (result.aborted) {
        // Interruption already handled the teardown of this turn's TTS.
        return;
      }

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
      const projection = projectVoiceOutput(
        {
          policy,
          display: { markdown: canonicalDisplayText },
          ...(result.outputDirective?.spoken === undefined
            ? {}
            : { spoken: result.outputDirective.spoken }),
        },
        { maxSpeechChars: VOICE_TTS_MAX_SPEECH_CHARS },
      );
      if (abort.signal.aborted || this.currentVoiceTurnId !== traceId) return;

      // Captions are the speech contract, not a separately normalized view.
      // A future projector regression must fail closed instead of sending bytes
      // that captions would misrepresent.
      const safeSpeechText =
        projection.captions === projection.speechText
          ? projection.captions
          : null;
      if (!safeSpeechText) {
        // The canonical route has already persisted/displayed non-empty output.
        // Cancel only the speculative provider context and report that truthful
        // outcome; `no_response` is reserved for an actually empty answer.
        this.ttsStream?.cancel(
          canonicalDisplayText ? "display_only_reply" : "empty_llm_reply",
        );
        this.finishTurn(
          traceId,
          canonicalDisplayText ? "displayed" : "no_response",
        );
        return;
      }

      this.turnTtsChars = safeSpeechText.length;
      ensureTts().sendPhrase({
        text: safeSpeechText,
        continueContext: false,
      });
    } catch (error) {
      // error-policy:J1 boundary translation — the LLM/TTS turn is the async
      // boundary; provider failures become a structured client `error` frame.
      if (this.currentVoiceTurnId !== traceId) return;
      const bridgeError =
        error instanceof ElizaSseBridgeError ? error : undefined;
      logger.warn("[voice-session] Eliza response turn failed", {
        traceId,
        code: bridgeError?.upstreamCode ?? bridgeError?.code,
        status: bridgeError?.status,
        message:
          bridgeError?.upstreamMessage ??
          (error instanceof Error ? error.message : String(error)),
      });
      this.send({
        t: "error",
        code: bridgeError
          ? (bridgeError.upstreamCode ?? bridgeError.code)
          : error instanceof Error
            ? error.name
            : "llm_error",
        retryable: bridgeError ? bridgeError.retryable : true,
        ...(bridgeError?.status ? { upstreamStatus: bridgeError.status } : {}),
        ...(bridgeError?.upstreamMessage
          ? { upstreamMessage: bridgeError.upstreamMessage }
          : {}),
        ...(bridgeError?.upstreamSnippet
          ? { upstreamSnippet: bridgeError.upstreamSnippet }
          : {}),
      });
      // The socket is already open because it was prewarmed before the LLM
      // request. Do not leak an idle provider connection when that request or
      // stream fails before a projected TTS input is sent. finishTurn has not
      // run yet, so ttsStream still belongs to this turn.
      this.ttsStream?.cancel("llm_error");
      this.finishTurn(traceId, "error");
    }
  }

  private finishTurn(traceId: string, outcome: VoiceTurnEndOutcome): void {
    if (this.currentVoiceTurnId !== traceId || this.closed) return;
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
    this.currentVoiceTurnId = null;
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
   * current voiceTurnId and is synchronous up to the point of emitting
   * `interrupted`, so no post-cancel audio can leak to the client.
   */
  private interrupt(reason: "acoustic" | "explicit"): void {
    const traceId = this.currentVoiceTurnId;
    if (!traceId) return; // nothing speaking/thinking to interrupt.

    // 1. Invalidate the turn id FIRST so any in-flight adapter callback that
    //    races this path is dropped by the `currentVoiceTurnId` guard.
    this.currentVoiceTurnId = null;

    // 2. Cancel Cartesia — merged adapter guarantees no post-cancel frames.
    if (this.ttsStream) {
      this.ttsStream.cancel(`interrupted:${reason}`);
      this.ttsStream = null;
    }
    // 3. Abort the Eliza SSE fetch — cancels the upstream provider stream.
    if (this.llmAbort) {
      this.llmAbort.abort();
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

    // Invalidate any live turn so racing callbacks are dropped.
    this.currentVoiceTurnId = null;
    this.clearProtectedResponseAccounting();
    this.resetSttPartialDelivery();

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
