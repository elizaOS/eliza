/**
 * Voice-session orchestrator — the keystone of the realtime voice loop.
 *
 * One instance == one live WS session. It owns the turn state machine and wires
 * the three legs together using the ALREADY-MERGED adapters as the provider
 * layer (never a reimplementation):
 *   - STT: `createDeepgramFluxRealtimeSession` (#15950). Uplink PCM re-framed to
 *     exact 2560-byte Flux chunks; Flux semantic-turn events drive the turn
 *     boundary. `Connected` handshake and any residual `channels=` rejection are
 *     handled per live-provider intel.
 *   - LLM: `streamElizaConversation` (existing SSE / Cerebras pass-through). No
 *     new LLM client.
 *   - TTS: `CartesiaSonicTtsAdapter` (#15949). Phrase-aggregated deltas stream
 *     in; the adapter's strict no-post-cancel guarantee makes barge-in correct.
 *
 * Interruption (contract §7.5): acoustic speech-start / Flux turn / explicit
 * `barge_in` -> under one `voiceTurnId`, cancel Cartesia (no post-cancel
 * frames), abort the Eliza SSE fetch, flush the downlink, drop pending phrase
 * aggregation, emit `interrupted`, return to listening. Target <250ms.
 *
 * Metering (SEC-15): server-derived uplink duration only; the client is NEVER
 * trusted for cost. Every audio frame accrues real-time seconds against the
 * injected usage store; over-cap severs with `quota_exhausted`.
 *
 * SEC-6: the session registers a `sever()` with the live-session registry so a
 * revoke — same-worker or cross-device — stops uplink to Deepgram in <=500ms.
 */

import {
  CartesiaSonicTtsAdapter,
  type CartesiaSonicTtsStream,
  type CartesiaWebSocketFactory,
} from "@/lib/services/cartesia-sonic-tts";
import type {
  VoiceUsageIdentity,
  VoiceUsageLimits,
  VoiceUsageStore,
} from "@/lib/services/voice-usage-meter";
import { streamElizaConversation } from "@/lib/voice-session/eliza-sse-bridge";
import { PhraseAggregator } from "@/lib/voice-session/phrase-aggregator";
import type { ServerControlFrame } from "@/lib/voice-session/protocol";
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
  createDeepgramFluxRealtimeSession,
  type DeepgramFluxRealtimeEvent,
  type DeepgramFluxRealtimeSession,
  type DeepgramFluxWebSocketFactory,
} from "../../stt/providers/deepgram-flux";
import { UplinkReframer } from "./uplink-reframer";

const PCM16_BYTES_PER_SECOND = 16_000 * 2; // 16kHz mono linear16.
/** Accrue metered minutes in whole seconds to keep the store's math simple. */
const METER_FLUSH_SECONDS = 5;
/** Nominal minutes charged on admission before ANY audio is forwarded (SEC-15). */
const ADMISSION_MINUTES = METER_FLUSH_SECONDS / 60;
/** Cap pre-admission buffered frames so an in-flight check can't be flooded. */
const MAX_PREADMISSION_FRAMES = 64; // ~5s of 80ms frames.
/** How often a live session polls the durable revocation store (SEC-6). */
const REVOCATION_POLL_MS = 400;
/**
 * Max un-verified metered windows we forward ahead of confirmed quota. Each
 * window is ~5s; a couple of windows tolerates normal Redis latency, but a
 * store that can't keep up (or a faster-than-realtime flood) trips the guard
 * and severs fail-closed instead of streaming unbounded paid audio.
 */
const MAX_OUTSTANDING_METER_WINDOWS = 2;

export type { VoiceSessionDownlink } from "@/lib/voice-session/ws-handler";

export interface VoiceSessionConfig {
  sessionId: string;
  jti: string;
  organizationId: string;
  userId: string;
  agentId: string;
  conversationId: string;
  /** Unix-seconds expiry of the bootstrap token; the session self-severs at exp. */
  tokenExpSeconds: number;

  // Provider wiring (injectable for tests: fake transports, real adapter code).
  deepgramApiKey: string;
  deepgramWebSocketFactory: DeepgramFluxWebSocketFactory;
  cartesiaApiKey: string;
  cartesiaVoiceId: string;
  cartesiaWebSocketFactory: CartesiaWebSocketFactory;

  // LLM leg.
  elizaEndpoint: string;
  elizaAuthorization: string;
  elizaModel: string;
  fetchImpl?: typeof fetch;

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

  private stt: DeepgramFluxRealtimeSession | null = null;
  private readonly cartesiaAdapter: CartesiaSonicTtsAdapter;
  private ttsStream: CartesiaSonicTtsStream | null = null;

  private state: SessionState = "ready";
  private started = false;
  private closed = false;

  /** Monotonic turn counter; the current turn's trace id derives from it. */
  private turnCounter = 0;
  private currentTraceId: string | null = null;
  private currentVoiceTurnId: string | null = null;
  private llmAbort: AbortController | null = null;
  private phrase: PhraseAggregator | null = null;
  private turnSttMs = 0;
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
  }

  /**
   * Open the Flux STT socket and register for revoke-to-silence. Emits `ready`.
   * Idempotent — a second `start()` is a no-op.
   */
  start(): void {
    if (this.started || this.closed) return;
    this.started = true;

    this.stt = createDeepgramFluxRealtimeSession({
      deepgramApiKey: this.config.deepgramApiKey,
      webSocketFactory: this.config.deepgramWebSocketFactory,
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
    // The session-level trace span id is stable until the first turn mints its own.
    const sessionTrace = this.mintTraceId("session");
    this.currentTraceId = sessionTrace;
    this.send({ t: "ready", sessionId: this.sessionId, traceId: sessionTrace });
  }

  /**
   * Push a client uplink audio chunk (PCM16). Re-frames to Flux chunk size and
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

    for (const frame of frames) {
      try {
        this.stt.sendAudioChunk(frame);
      } catch {
        // error-policy:J6 best-effort teardown race — a closed/closing Flux
        // socket after a concurrent sever; stop forwarding.
        return;
      }
    }
  }

  /**
   * Run the one-time admission quota check, then release buffered frames. This
   * is what makes forwarding fail-closed: nothing reaches Deepgram until
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
        for (const frame of buffered) {
          try {
            this.stt?.sendAudioChunk(frame);
          } catch {
            // error-policy:J6 best-effort teardown race — Flux socket closed by
            // a concurrent sever while releasing the buffer; stop forwarding.
            break;
          }
        }
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

  private onSttEvent(event: DeepgramFluxRealtimeEvent): void {
    if (this.closed) return;
    switch (event.type) {
      case "start-of-turn": {
        // A new user turn started. If the agent is mid-speech, this is a
        // barge-in (acoustic speech-start via Flux's semantic turn detector).
        if (this.state === "speaking" || this.state === "thinking") {
          this.interrupt("acoustic");
        }
        this.state = "transcribing";
        break;
      }
      case "transcript-update": {
        if (event.transcript) {
          this.send({
            t: "stt_partial",
            text: event.transcript,
            traceId: this.currentTraceId ?? this.mintTraceId("turn"),
          });
        }
        break;
      }
      case "eager-end-of-turn": {
        this.send({
          t: "stt_eager_eot",
          traceId: this.currentTraceId ?? this.mintTraceId("turn"),
        });
        break;
      }
      case "end-of-turn": {
        // A missing transcript commits as "" on purpose: commitTurn's empty-
        // final path still reports+resets the turn's metered usage and clears
        // the turn id, which skipping the commit would leak into the next turn.
        this.commitTurn(event.transcript ?? "");
        break;
      }
      case "turn-resumed": {
        // The user kept talking; the eager EOT was speculative. Stay listening.
        break;
      }
      case "error": {
        // A benign `Connected` handshake maps to malformed in the adapter; treat
        // an initial malformed with no transcript as non-fatal noise, everything
        // else as a real error surfaced to the client (retryable next session).
        if (event.code === "malformed_event") return;
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

    if (transcript.trim() === "") {
      // Empty final (silence/noise): no TTS turn. Close it out like any other
      // turn — report + reset usage and CLEAR the turn id — so its metered STT
      // ms don't bleed into the next utterance and a stray barge_in can't emit
      // an `interrupted` for a turn that isn't really active.
      this.finishTurn(traceId);
      return;
    }

    this.state = "thinking";
    void this.runResponseTurn(transcript, traceId);
  }

  private async runResponseTurn(
    transcript: string,
    traceId: string,
  ): Promise<void> {
    const abort = new AbortController();
    this.llmAbort = abort;
    const phrase = new PhraseAggregator();
    this.phrase = phrase;

    let tts: CartesiaSonicTtsStream | null = null;
    // Held phrase (see the streaming loop below): kept back by one so the
    // terminal phrase can be sent with continue:false to close the Cartesia
    // context, rather than an empty-transcript finish() the live API rejects.
    let pendingPhrase: string | null = null;
    const ensureTts = (): CartesiaSonicTtsStream => {
      if (tts) return tts;
      tts = this.cartesiaAdapter.createStream(
        { traceId },
        {
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
            this.finishTurn(traceId);
          },
          onProviderError: (err) => {
            if (this.currentVoiceTurnId !== traceId) return;
            this.send({
              t: "error",
              code: err.code ?? "tts_error",
              retryable: true,
            });
            // Close out the failed turn so the client gets usage + returns to
            // listening, instead of the session being stuck on a dead turn
            // until a later barge-in or teardown.
            this.finishTurn(traceId);
          },
        },
      );
      this.ttsStream = tts;
      return tts;
    };

    try {
      const result = await streamElizaConversation(
        {
          endpoint: this.config.elizaEndpoint,
          authorization: this.config.elizaAuthorization,
          model: this.config.elizaModel,
          transcript,
          agentId: this.config.agentId,
          conversationId: this.config.conversationId,
          traceId,
          signal: abort.signal,
          fetchImpl: this.config.fetchImpl,
        },
        (delta) => {
          if (this.currentVoiceTurnId !== traceId) return;
          if (!this.firstLlmTextEmitted) {
            this.firstLlmTextEmitted = true;
            this.send({ t: "llm_first_text", traceId });
          }
          // Cartesia closes a synthesis context via the FINAL phrase carrying
          // `continue:false` (verified against the LIVE API: a real terminal
          // phrase with continue:false yields `done`; an empty-transcript
          // request is rejected with "No valid transcripts passed"). So a phrase
          // is only safe to send once we know whether ANOTHER follows. We hold
          // back exactly one phrase: when a new phrase arrives, flush the held
          // one with continue:true; the held phrase at stream-end is the
          // terminal one and is sent with continue:false.
          const phrases = phrase.push(delta);
          for (const p of phrases) {
            this.turnTtsChars += p.length;
            const stream = ensureTts();
            if (pendingPhrase !== null) {
              stream.sendPhrase({ text: pendingPhrase, continueContext: true });
            }
            pendingPhrase = p;
          }
        },
      );

      if (this.currentVoiceTurnId !== traceId) return; // interrupted mid-stream.

      if (result.aborted) {
        // Interruption already handled the teardown of this turn's TTS.
        return;
      }

      const tail = phrase.flush();
      if (tail) {
        // A trailing phrase remains. Flush any held phrase (continue:true), then
        // send the tail as the terminal phrase with continue:false.
        if (pendingPhrase !== null) {
          ensureTts().sendPhrase({
            text: pendingPhrase,
            continueContext: true,
          });
          pendingPhrase = null;
        }
        this.turnTtsChars += tail.length;
        ensureTts().sendPhrase({ text: tail, continueContext: false });
      } else if (pendingPhrase !== null) {
        // The held phrase is the LAST speakable unit: send it with
        // continue:false to close the context cleanly (yields `done` ->
        // onComplete). This replaces the empty-transcript finish() that the
        // LIVE Cartesia API rejects.
        ensureTts().sendPhrase({ text: pendingPhrase, continueContext: false });
        pendingPhrase = null;
      } else if (!tts) {
        // No speakable output at all (empty LLM reply): close the turn.
        this.finishTurn(traceId);
      }
      // If tts exists but nothing above matched (all phrases already terminal),
      // the context was already closed with continue:false; nothing to do.
    } catch (error) {
      // error-policy:J1 boundary translation — the LLM/TTS turn is the async
      // boundary; provider failures become a structured client `error` frame.
      if (this.currentVoiceTurnId !== traceId) return;
      this.send({
        t: "error",
        code: error instanceof Error ? error.name : "llm_error",
        retryable: true,
      });
      this.finishTurn(traceId);
    }
  }

  private finishTurn(traceId: string): void {
    if (this.currentVoiceTurnId !== traceId || this.closed) return;
    this.send({
      t: "usage",
      sttMs: this.turnSttMs,
      ttsChars: this.turnTtsChars,
      traceId,
    });
    this.currentVoiceTurnId = null;
    this.llmAbort = null;
    this.phrase = null;
    this.ttsStream = null;
    // Reset per-utterance accumulators now that this turn's usage is reported;
    // the next utterance's STT metering starts fresh.
    this.turnSttMs = 0;
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
    // 4. Drop pending phrase aggregation.
    if (this.phrase) {
      this.phrase.reset();
      this.phrase = null;
    }
    // 5. Report the interrupted turn's usage (STT accrued + TTS chars emitted so
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
    this.turnTtsChars = 0;
    this.llmAbort = null;
    // 6. Emit interrupted and return to listening.
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
    this.unmeteredUplinkBytes += byteLength;
    const seconds = Math.floor(
      this.unmeteredUplinkBytes / PCM16_BYTES_PER_SECOND,
    );
    if (seconds < METER_FLUSH_SECONDS) return;
    this.unmeteredUplinkBytes -= seconds * PCM16_BYTES_PER_SECOND;
    this.turnSttMs += seconds * 1000;
    this.meterWindowsInFlight += 1;
    void this.recordMeter(seconds / 60);
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
      // do not keep streaming uncapped paid audio to Deepgram; sever.
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
        // Flux socket must not abort the rest of teardown.
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
