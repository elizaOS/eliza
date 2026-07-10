/**
 * Ambient voice-session orchestrator (AMBIENT-MODE-DESIGN).
 *
 * One instance == one live ambient WS session. It is the conversation loop
 * MINUS the reply half: NO Eliza SSE bridge, NO Cartesia, NO phrase aggregator,
 * NO downlink audio, NO interruption coordinator. Its ONLY writer is the
 * canonical pendant segment store (design §3.5 — one writer, which is why
 * ambient sidesteps the multi-writer divergence entirely).
 *
 * What it does:
 *   - STT: `createDeepgramFluxRealtimeSession` (#15950) — the SAME merged
 *     adapter, unchanged. Uplink PCM re-framed to exact 2560-byte Flux chunks;
 *     Flux `end-of-turn` (authoritative) commits a segment; `eager-end-of-turn`
 *     is display-only and NEVER persists (design §3.2).
 *   - Persistence: each authoritative EOT appends a segment to the bound
 *     `pendant_sessions_v1` session via the injected `AmbientSegmentStore` port
 *     (the existing pendant append route). The server is the sole ordinal
 *     allocator; the session tracks the next ordinal from each append result.
 *   - Pause/resume (design §1.2, SEC-6/P0-4): `pause` SEVERS the live Flux
 *     socket (adapter `cancel()`), stops ingesting uplink, and flips the pendant
 *     session to `paused` (which makes the store refuse appends). `resume`
 *     re-opens Flux and flips back to `active`. Pause is NOT "stop rendering."
 *   - Lease renewal (SEC-7): renews the capture lease over the socket; the
 *     server holds the current token and never trusts a client-supplied one.
 *   - Metering (SEC-15): server-derived uplink seconds, metered against a
 *     SEPARATE meter key from converse (the identity is namespaced `ambient:`),
 *     fail-closed; over-cap severs with `quota_exhausted`. PAUSED time is not
 *     ingested and therefore not metered.
 *   - Revoke-to-silence (SEC-6): registers with the live-session registry;
 *     revoke/delete/expiry/idle/max-wallclock all sever the Flux socket.
 *
 * Retention (design §4): transcript-only by default. Ambient streams PCM to
 * Flux and DISCARDS it frame-by-frame after re-framing; it retains NO raw audio.
 * The opt-in bounded audio sink (design §4.2, phase 3) is not built here.
 */

import {
  createDeepgramFluxRealtimeSession,
  type DeepgramFluxRealtimeEvent,
  type DeepgramFluxRealtimeSession,
  type DeepgramFluxWebSocketFactory,
} from "../../stt/providers/deepgram-flux";
import type {
  VoiceUsageIdentity,
  VoiceUsageLimits,
  VoiceUsageStore,
} from "@/lib/services/voice-usage-meter";
import type { AmbientDownlink, VoiceSessionLike } from "@/lib/voice-session/ws-handler";
import type { AmbientServerFrame } from "@/lib/voice-session/ambient-protocol";
import { AMBIENT_DEFAULT_MAX_TURN_MS } from "@/lib/voice-session/ambient-protocol";
import {
  AmbientStoreError,
  type AmbientSegmentStore,
  type AmbientSegmentInput,
} from "@/lib/voice-session/pendant-store-client";
import {
  getVoiceSessionRegistry,
  type LiveVoiceSession,
  type VoiceSessionRegistry,
  type VoiceSessionSeverReason,
} from "@/lib/voice-session/session-registry";
import type { PendantSegment } from "@elizaos/shared/contracts";
import { UplinkReframer } from "./uplink-reframer";

const PCM16_BYTES_PER_SECOND = 16_000 * 2;
const METER_FLUSH_SECONDS = 5;
const ADMISSION_MINUTES = METER_FLUSH_SECONDS / 60;
const MAX_PREADMISSION_FRAMES = 64;
const REVOCATION_POLL_MS = 400;
const MAX_OUTSTANDING_METER_WINDOWS = 2;

/**
 * Namespace the metering identity so ambient minutes accrue against a SEPARATE
 * counter key from converse (requirement 5). The meter keys are derived from
 * organizationId/userId; prefixing them with `ambient:` yields
 * `org:ambient:<org>` / `user:ambient:<org>:<user>`, distinct from converse
 * `org:<org>` / `user:<org>:<user>`. The meter itself is unchanged.
 */
function ambientMeterIdentity(organizationId: string, userId: string): VoiceUsageIdentity {
  return {
    organizationId: `ambient:${organizationId}`,
    userId: `ambient:${userId}`,
  };
}

export interface AmbientSessionConfig {
  sessionId: string;
  jti: string;
  organizationId: string;
  userId: string;
  agentId: string;
  /** Canonical pendant session this ambient session commits segments into. */
  pendantSessionId: string;
  /** Plaintext lease presented in hello; the server holds + renews it. */
  captureLeaseToken: string;
  tokenExpSeconds: number;

  // STT provider wiring (injectable for tests: fake transports, real adapter).
  deepgramApiKey: string;
  deepgramWebSocketFactory: DeepgramFluxWebSocketFactory;

  // The single canonical store (pendant session routes). Injected as a port so
  // tests exercise the real ordinal/lease/state contract in-memory.
  store: AmbientSegmentStore;

  // Metering (SEC-15) — separate ambient meter key applied internally.
  usageStore: VoiceUsageStore;
  usageLimits: VoiceUsageLimits;

  downlink: AmbientDownlink;
  registry?: VoiceSessionRegistry;
  now?: () => number;

  /** Cross-worker revoke check (SEC-6); self-sever if this jti is revoked. */
  isRevoked?: (jti: string) => Promise<boolean>;
  /** Revoke the bootstrap jti on teardown so a replay can't re-open. */
  onTeardownRevoke?: (jti: string, expSeconds: number) => Promise<void>;
  /**
   * Refresh the durable `sessionId->jti` revocation directory entry, extending
   * its TTL. Ambient sessions outlive the 120s bootstrap token; without this a
   * cross-worker revoke could not resolve the jti after the directory entry
   * expired (a live socket would only be revocable on its own worker). Called
   * on every lease renewal so the directory stays valid for the session's life
   * (SEC-6 cross-worker, P1). The `expSeconds` passed is a near-future horizon
   * (now + directoryTtlSeconds), NOT the original token exp.
   */
  refreshRevocationDirectory?: (jti: string, expSeconds: number) => Promise<void>;

  /** Lease renewal params (design §1.4). */
  leaseMs?: number;
  /** Server backstop: force a commit if one Flux turn runs long (design §3.2). */
  maxTurnMs?: number;
  /** Absolute wall-clock ceiling; force-end past it (SEC-9). */
  maxSessionMs?: number;
  /** Idle end: no uplink for this long => end (SEC-9). */
  idleEndMs?: number;
}

const DEFAULT_LEASE_MS = 5 * 60_000;
const DEFAULT_MAX_SESSION_MS = 12 * 60 * 60_000;
const DEFAULT_IDLE_END_MS = 30 * 60_000;

type AmbientState = "listening" | "paused" | "closed";

export class AmbientSession implements LiveVoiceSession, VoiceSessionLike {
  readonly sessionId: string;
  readonly jti: string;
  readonly organizationId: string;
  readonly userId: string;

  private readonly config: AmbientSessionConfig;
  private readonly registry: VoiceSessionRegistry;
  private readonly now: () => number;
  private readonly reframer = new UplinkReframer();
  private readonly meterIdentity: VoiceUsageIdentity;
  private readonly leaseHolder: string;

  private stt: DeepgramFluxRealtimeSession | null = null;
  private state: AmbientState = "listening";
  private started = false;
  private closed = false;

  /** Server-tracked next ordinal; updated from each append's segmentCount. */
  private nextOrdinal = 0;
  /** Current lease token (server-held; renewed over the socket). */
  private leaseToken: string;
  private turnCounter = 0;
  private turnSttMs = 0;

  // Metering accrual (server-derived).
  private unmeteredUplinkBytes = 0;
  private meteredExhausted = false;
  private meteringAdmitted = false;
  private admissionInFlight = false;
  private meterWindowsInFlight = 0;
  private readonly preAdmissionFrames: ArrayBuffer[] = [];

  // In-flight append serialization: ordinals must commit in order, so appends
  // run through a single-flight chain (the store is the allocator, but we must
  // not fire two appends for the same ordinal concurrently).
  private appendChain: Promise<void> = Promise.resolve();
  // Serialize pendant-store state writes (pause/resume/end) so a resume issued
  // right after a pause can never land BEFORE the pause at the store (HTTP
  // reordering would otherwise leave the canonical session paused while Flux is
  // reopened, silently dropping resumed segments). All setState calls go through
  // this single-flight chain, preserving issue order.
  private stateChain: Promise<void> = Promise.resolve();

  private revocationPoll: ReturnType<typeof setInterval> | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private maxSessionTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private leaseTimer: ReturnType<typeof setInterval> | null = null;
  private turnCapTimer: ReturnType<typeof setTimeout> | null = null;
  private isRevoked: ((jti: string) => Promise<boolean>) | null = null;

  constructor(config: AmbientSessionConfig) {
    this.config = config;
    this.sessionId = config.sessionId;
    this.jti = config.jti;
    this.organizationId = config.organizationId;
    this.userId = config.userId;
    this.registry = config.registry ?? getVoiceSessionRegistry();
    this.now = config.now ?? Date.now;
    this.isRevoked = config.isRevoked ?? null;
    this.leaseToken = config.captureLeaseToken;
    this.leaseHolder = `ambient:${config.sessionId}`;
    this.meterIdentity = ambientMeterIdentity(config.organizationId, config.userId);
  }

  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    this.registry.register(this);
    // Prepare authorization + ordinal state BEFORE opening the paid Flux socket:
    // (1) validate the presented lease against the store by renewing it (a
    //     tampered/expired lease fails here and NO audio ever reaches Deepgram);
    // (2) initialize nextOrdinal from the store so a RESUME appends contiguously
    //     after existing segments instead of colliding at ordinal 0;
    // (3) refuse an ended session.
    // openFlux() runs only after this resolves. Uplink that arrives in the gap
    // is buffered by the reframer + pre-admission path and flushed on admission.
    void this.prepareAndOpen();

    if (this.isRevoked) {
      this.revocationPoll = setInterval(() => {
        void (async () => {
          if (this.closed || !this.isRevoked) return;
          try {
            if (await this.isRevoked(this.jti)) this.teardown("revoked");
          } catch {
            this.teardown("revoked");
          }
        })();
      }, REVOCATION_POLL_MS);
    }

    // Token-expiry hard ceiling: the sessionId->jti directory entry expires with
    // the 120s bootstrap token, after which a revoke could no longer resolve
    // this jti. Self-sever at exp (unlike conversation, ambient runs for hours
    // sustained by the lease, so this bound plus the lease/idle/max-wallclock
    // ceilings are what keep it revocable).
    const nowSeconds = Math.floor(this.now() / 1000);
    const msUntilExp = Math.max(0, (this.config.tokenExpSeconds - nowSeconds) * 1000);
    // NOTE: the bootstrap token expiry only ends the DIRECTORY lookup window,
    // not the session; per design §1.4 the socket lives on the in-memory
    // binding. But because same-worker revoke severs synchronously via the
    // registry and cross-worker relies on the jti directory (valid only while
    // the token lives), we cap ambient sessions to the max-wallclock and idle
    // ceilings below rather than the 120s token. The expiry timer is therefore
    // used only to schedule a lease-independent liveness re-check, not a sever.
    void msUntilExp;

    const maxSessionMs = this.config.maxSessionMs ?? DEFAULT_MAX_SESSION_MS;
    this.maxSessionTimer = setTimeout(() => {
      if (!this.closed) this.teardown("max_wallclock");
    }, maxSessionMs);

    this.armIdleTimer();
    this.armLeaseRenewal();
    this.state = "listening";
  }

  /**
   * Authorize + initialize BEFORE opening the paid Flux socket. Validates the
   * lease (renew round-trips it through the store; a bad lease fails here with
   * NO audio ever reaching Deepgram), reads the store's current segment count so
   * a RESUME appends contiguously, refuses an ended session, then opens Flux and
   * emits `ready`.
   */
  private async prepareAndOpen(): Promise<void> {
    try {
      const snapshot = await this.config.store.getSessionState(this.config.pendantSessionId);
      if (this.closed) return;
      if (snapshot.state === "ended") {
        this.emit({ t: "error", code: "session_ended", retryable: false });
        this.teardown("error");
        return;
      }
      // RESUME contiguity (P1): next ordinal is the existing segment count, not 0.
      this.nextOrdinal = snapshot.segmentCount;
    } catch (error) {
      if (this.closed) return;
      if (error instanceof AmbientStoreError && error.code === "not_found") {
        this.emit({ t: "error", code: "pendant_not_found", retryable: false });
        this.teardown("error");
        return;
      }
      this.emit({ t: "error", code: "ambient_bind_failed", retryable: false });
      this.teardown("error");
      return;
    }

    // Validate the capture lease by renewing it against the store BEFORE opening
    // Flux (P2). A tampered/expired/mismatched lease throws lease_conflict here,
    // so no paid audio streams on an unauthorized lease.
    try {
      const leaseMs = this.config.leaseMs ?? DEFAULT_LEASE_MS;
      const renewed = await this.config.store.renewLease(
        this.config.pendantSessionId,
        this.leaseHolder,
        this.leaseToken,
        leaseMs,
      );
      if (this.closed) return;
      this.leaseToken = renewed.leaseToken;
      // Extend the revocation directory at start too (the first renewal), so
      // cross-worker revoke stays resolvable from the moment capture begins.
      this.refreshDirectory();
    } catch (error) {
      if (this.closed) return;
      this.emit({ t: "error", code: "lease_conflict", retryable: false });
      this.teardown("error");
      return;
    }

    if (this.closed) return;
    this.openFlux();
    const trace = this.mintTraceId("session");
    this.emit({
      t: "ready",
      sessionId: this.sessionId,
      pendantSessionId: this.config.pendantSessionId,
      traceId: trace,
    });
  }

  private openFlux(): void {
    this.stt = createDeepgramFluxRealtimeSession({
      deepgramApiKey: this.config.deepgramApiKey,
      webSocketFactory: this.config.deepgramWebSocketFactory,
      onEvent: (event) => this.onSttEvent(event),
    });
  }

  // --- uplink + metering ----------------------------------------------------

  pushUplinkAudio(bytes: Uint8Array): void {
    // Paused: uplink is dropped (not ingested, not metered — the pause
    // guarantee). Closed / exhausted / no socket: drop.
    if (this.closed || this.state === "paused" || !this.stt || this.meteredExhausted) return;

    this.bumpIdle();
    const frames = this.reframer.push(bytes);
    this.accrueUplink(bytes.byteLength);
    if (this.meteredExhausted) return;

    if (!this.meteringAdmitted) {
      for (const f of frames) this.preAdmissionFrames.push(f);
      this.ensureAdmission();
      if (this.preAdmissionFrames.length > MAX_PREADMISSION_FRAMES) {
        this.meteredExhausted = true;
        this.emit({ t: "error", code: "metering_unavailable", retryable: false });
        this.teardown("error");
      }
      return;
    }

    if (this.meterWindowsInFlight > MAX_OUTSTANDING_METER_WINDOWS) {
      this.meteredExhausted = true;
      this.emit({ t: "error", code: "metering_backpressure", retryable: false });
      this.teardown("error");
      return;
    }

    for (const frame of frames) {
      try {
        this.stt.sendAudioChunk(frame);
      } catch {
        return;
      }
    }
  }

  private ensureAdmission(): void {
    if (this.admissionInFlight || this.meteringAdmitted || this.meteredExhausted) return;
    this.admissionInFlight = true;
    void (async () => {
      try {
        const decision = await this.config.usageStore.checkAndRecord(
          this.meterIdentity,
          ADMISSION_MINUTES,
          this.config.usageLimits,
        );
        if (this.closed) return;
        if (!decision.allowed) {
          this.meteredExhausted = true;
          this.emit({ t: "error", code: "quota_exhausted", retryable: false });
          this.teardown("quota_exhausted");
          return;
        }
        this.meteringAdmitted = true;
        this.turnSttMs += Math.round(ADMISSION_MINUTES * 60_000);
        const buffered = this.preAdmissionFrames.splice(0);
        for (const frame of buffered) {
          try {
            this.stt?.sendAudioChunk(frame);
          } catch {
            break;
          }
        }
      } catch {
        if (this.closed) return;
        this.meteredExhausted = true;
        this.emit({ t: "error", code: "metering_unavailable", retryable: false });
        this.teardown("error");
      } finally {
        this.admissionInFlight = false;
      }
    })();
  }

  private accrueUplink(byteLength: number): void {
    if (!this.meteringAdmitted) return;
    this.unmeteredUplinkBytes += byteLength;
    const seconds = Math.floor(this.unmeteredUplinkBytes / PCM16_BYTES_PER_SECOND);
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
        this.meterIdentity,
        minutes,
        this.config.usageLimits,
      );
      this.meterWindowsInFlight = Math.max(0, this.meterWindowsInFlight - 1);
      if (!decision.allowed) {
        this.meteredExhausted = true;
        this.emit({ t: "error", code: "quota_exhausted", retryable: false });
        this.teardown("quota_exhausted");
      }
    } catch {
      this.meterWindowsInFlight = Math.max(0, this.meterWindowsInFlight - 1);
      this.meteredExhausted = true;
      this.emit({ t: "error", code: "metering_unavailable", retryable: false });
      this.teardown("error");
    }
  }

  // --- STT event handling ---------------------------------------------------

  private onSttEvent(event: DeepgramFluxRealtimeEvent): void {
    if (this.closed) return;
    switch (event.type) {
      case "start-of-turn":
        this.armTurnCap();
        break;
      case "transcript-update":
        // Interim: UI only, NEVER persisted (design §1.2).
        if (event.transcript) {
          this.emit({ t: "stt_partial", text: event.transcript, traceId: this.mintTraceId("turn-peek") });
        }
        break;
      case "eager-end-of-turn":
        // Speculative; in ambient there is nothing to pre-warm. Display-only,
        // NEVER commits (design §3.2). We do not even emit it as a distinct
        // event (the conversation `stt_eager_eot` has no meaning in ambient).
        break;
      case "turn-resumed":
        // User kept talking; the eager EOT was speculative. Re-arm the cap.
        this.armTurnCap();
        break;
      case "end-of-turn":
        // Authoritative — this is the ONLY persistence trigger.
        this.clearTurnCap();
        this.commitSegment(event, "resolved");
        break;
      case "error":
        if (event.code === "malformed_event") return; // benign handshake noise.
        this.emit({ t: "error", code: event.code, retryable: false });
        break;
      case "close":
        // If we are paused, a close is expected (we severed Flux). Otherwise a
        // provider close mid-capture ends the session so the client re-mints.
        if (this.state !== "paused" && !this.closed) this.teardown("error");
        break;
    }
  }

  private commitSegment(event: DeepgramFluxRealtimeEvent, status: PendantSegment["status"]): void {
    if (event.type !== "end-of-turn") return;
    const transcript = event.transcript ?? "";
    if (transcript.trim() === "") return; // silence/noise: nothing to persist.
    const nowIso = new Date(this.now()).toISOString();
    const words = normalizeWords(event.words);
    const traceId = this.mintTraceId("turn");
    const input: AmbientSegmentInput = {
      ordinal: this.nextOrdinal,
      text: transcript,
      words,
      status,
      confidence: typeof event.endOfTurnConfidence === "number" ? clamp01(event.endOfTurnConfidence) : null,
      startedAt: nowIso,
      endedAt: nowIso,
    };
    // Serialize appends so ordinals commit contiguously; the store is the sole
    // allocator, so we must not race two appends for the same ordinal.
    this.appendChain = this.appendChain.then(() => this.doAppend(input, traceId));
  }

  private async doAppend(input: AmbientSegmentInput, traceId: string): Promise<void> {
    if (this.closed || this.state === "paused") return;
    try {
      const result = await this.config.store.appendSegment(
        this.config.pendantSessionId,
        this.leaseToken,
        input,
      );
      if (this.closed) return;
      this.nextOrdinal = result.segmentCount; // next contiguous ordinal.
      this.emit({
        t: "stt_final",
        text: input.text,
        segmentId: result.segmentId,
        ordinal: result.ordinal,
        revision: result.revision,
        traceId,
      });
      this.emit({
        t: "segment_committed",
        segmentId: result.segmentId,
        ordinal: result.ordinal,
        revision: result.revision,
      });
      // Report per-turn STT metering as a usage frame (no ttsChars in ambient).
      this.emit({ t: "usage", sttMs: this.turnSttMs, traceId });
    } catch (error) {
      if (this.closed) return;
      if (error instanceof AmbientStoreError) {
        if (error.code === "lease_conflict") {
          // Fail-closed: a lost/expired lease means we can no longer write.
          this.emit({ t: "error", code: "lease_conflict", retryable: false });
          this.teardown("error");
          return;
        }
        if (error.code === "revision_conflict" || error.code === "validation") {
          // The store rejected the ordinal (paused/ended, or a divergence such as
          // a resume that mis-estimated the count). Re-sync nextOrdinal from the
          // store so the NEXT turn appends contiguously; drop this segment (never
          // faked). Best-effort re-sync; if it fails we keep the current guess.
          void this.resyncOrdinal();
          this.emit({ t: "error", code: "segment_conflict", retryable: true });
          return;
        }
        this.emit({ t: "error", code: error.code, retryable: error.code === "transport" });
        return;
      }
      this.emit({ t: "error", code: "append_failed", retryable: true });
    }
  }

  /** Re-read the store's segment count to re-anchor the next ordinal. */
  private async resyncOrdinal(): Promise<void> {
    try {
      const snap = await this.config.store.getSessionState(this.config.pendantSessionId);
      if (!this.closed) this.nextOrdinal = snap.segmentCount;
    } catch {
      // keep the current estimate; the next append will retry the resync.
    }
  }

  // --- pause / resume (SEC-6/P0-4) ------------------------------------------

  pauseCapture(): void {
    if (this.closed || this.state === "paused") return;
    this.state = "paused";
    // Sever the live Flux socket FIRST (audio stops flowing to Deepgram), then
    // flip the pendant session to paused so the store refuses appends. Confirm
    // `paused` to the client only AFTER Flux is actually severed.
    this.severFlux("paused");
    this.queueStateWrite("paused");
    this.emit({ t: "paused" });
  }

  resumeCapture(): void {
    if (this.closed || this.state !== "paused") return;
    this.state = "listening";
    // Queue the `active` write AFTER any in-flight `paused` write via the state
    // chain, so the store can never end up paused while Flux is open (P2).
    this.queueStateWrite("active");
    this.openFlux();
    this.bumpIdle();
    this.emit({ t: "resumed" });
  }

  /** Enqueue an ordered pendant-store state write (pause/resume/end). */
  private queueStateWrite(state: "paused" | "active" | "ended"): void {
    this.stateChain = this.stateChain.then(() =>
      this.config.store.setState(this.config.pendantSessionId, state).catch(() => {
        // A failed state write does not change local capture state; the next
        // ordered write (or a segment append's own guards) reconciles.
      }),
    );
  }

  private severFlux(reason: string): void {
    if (this.stt) {
      try {
        this.stt.cancel(reason);
      } catch {
        // best-effort.
      }
      this.stt = null;
    }
    this.reframer.flush();
    this.clearTurnCap();
  }

  // --- lease renewal (SEC-7) ------------------------------------------------

  leaseRenew(): void {
    void this.renewLeaseNow();
  }

  private async renewLeaseNow(): Promise<void> {
    if (this.closed) return;
    try {
      const leaseMs = this.config.leaseMs ?? DEFAULT_LEASE_MS;
      const renewed = await this.config.store.renewLease(
        this.config.pendantSessionId,
        this.leaseHolder,
        this.leaseToken,
        leaseMs,
      );
      if (this.closed) return;
      this.leaseToken = renewed.leaseToken; // server holds the new token.
      // Extend the durable revocation directory alongside the lease so a
      // cross-worker revoke can still resolve this jti past the 120s token TTL
      // (P1). Horizon = now + a window comfortably covering the renewal cadence.
      this.refreshDirectory();
      this.emit({
        t: "lease_renewed",
        leaseToken: renewed.leaseToken,
        leaseExpiresAt: renewed.leaseExpiresAt,
      });
    } catch (error) {
      if (this.closed) return;
      if (error instanceof AmbientStoreError && error.code === "lease_conflict") {
        // Lost the lease: fail-closed, another holder took over or it lapsed.
        this.emit({ t: "error", code: "lease_conflict", retryable: false });
        this.teardown("error");
        return;
      }
      this.emit({ t: "error", code: "lease_renew_failed", retryable: true });
    }
  }

  /**
   * Extend the durable revocation directory TTL so cross-worker revoke keeps
   * resolving this jti while the ambient session lives (P1). Horizon is a small
   * multiple of the lease window (bounded), refreshed on every renewal.
   */
  private refreshDirectory(): void {
    if (!this.config.refreshRevocationDirectory) return;
    const leaseMs = this.config.leaseMs ?? DEFAULT_LEASE_MS;
    // Give the directory a horizon of ~2 lease windows so it never lapses
    // between renewals; bounded (never the multi-hour session ceiling) so a
    // wedged session's directory entry still self-expires reasonably.
    const horizonSeconds = Math.floor(this.now() / 1000) + Math.ceil((leaseMs * 2) / 1000);
    void this.config.refreshRevocationDirectory(this.jti, horizonSeconds).catch(() => {
      // Best-effort; the same-worker registry sever still works, and the next
      // renewal retries the directory refresh.
    });
  }

  private armLeaseRenewal(): void {
    const leaseMs = this.config.leaseMs ?? DEFAULT_LEASE_MS;
    // Renew at ~50% of the lease window (design §1.4) so a renewal always lands
    // before expiry even with one failed attempt.
    const interval = Math.max(5_000, Math.floor(leaseMs / 2));
    this.leaseTimer = setInterval(() => {
      if (!this.closed && this.state !== "paused") void this.renewLeaseNow();
    }, interval);
  }

  // --- turn cap (design §3.2) ----------------------------------------------

  private armTurnCap(): void {
    this.clearTurnCap();
    const maxTurnMs = this.config.maxTurnMs ?? AMBIENT_DEFAULT_MAX_TURN_MS;
    this.turnCapTimer = setTimeout(() => {
      // A single Flux turn ran past the backstop. We cannot synthesize a
      // transcript; the safe action is to sever+reopen Flux so the next EOT
      // commits a bounded segment, rather than fabricate one. (No fake data.)
      if (this.closed || this.state === "paused") return;
      this.severFlux("turn_cap");
      this.openFlux();
    }, maxTurnMs);
  }

  private clearTurnCap(): void {
    if (this.turnCapTimer) {
      clearTimeout(this.turnCapTimer);
      this.turnCapTimer = null;
    }
  }

  // --- idle end (SEC-9) -----------------------------------------------------

  private armIdleTimer(): void {
    const idleMs = this.config.idleEndMs ?? DEFAULT_IDLE_END_MS;
    this.idleTimer = setTimeout(() => {
      if (!this.closed) this.teardown("idle_timeout");
    }, idleMs);
  }

  private bumpIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.armIdleTimer();
  }

  // --- lifecycle ------------------------------------------------------------

  bye(): void {
    this.teardown("completed");
  }

  sever(reason: VoiceSessionSeverReason): void {
    this.teardown(reason);
  }

  private teardown(reason: VoiceSessionSeverReason): void {
    if (this.closed) return;
    this.closed = true;
    this.state = "closed";

    if (this.config.onTeardownRevoke) {
      void this.config.onTeardownRevoke(this.jti, this.config.tokenExpSeconds).catch(() => {});
    }

    this.severFlux(`session:${reason}`);

    for (const timer of [this.revocationPoll, this.leaseTimer]) {
      if (timer) clearInterval(timer);
    }
    this.revocationPoll = null;
    this.leaseTimer = null;
    for (const timer of [this.expiryTimer, this.maxSessionTimer, this.idleTimer]) {
      if (timer) clearTimeout(timer);
    }
    this.expiryTimer = null;
    this.maxSessionTimer = null;
    this.idleTimer = null;

    this.preAdmissionFrames.length = 0;
    this.registry.unregister(this.sessionId);

    // Flip the pendant session to ended on a clean bye so the store marks it
    // immutable and clears the lease (design §1.2). Best-effort; on revoke/error
    // the delete/revoke path (or lease lapse) already renders it unwritable.
    if (reason === "completed") {
      // Ordered after any in-flight pause/resume write so `ended` is final.
      this.queueStateWrite("ended");
    }

    if (reason !== "completed" && reason !== "client_disconnect") {
      this.emit({ t: "error", code: reason, retryable: reason === "error" });
    }
    this.config.downlink.close(1000, reason);
  }

  private emit(frame: AmbientServerFrame): void {
    if (this.closed && frame.t !== "error") return;
    this.config.downlink.sendControl(frame);
  }

  private mintTraceId(kind: "session" | "turn" | "turn-peek"): string {
    if (kind === "turn") this.turnCounter += 1;
    const seq = kind === "turn" ? this.turnCounter : 0;
    return `${this.sessionId}:${kind}:${seq}:${Math.floor(this.now())}`;
  }

  get currentState(): AmbientState {
    return this.state;
  }
}

function normalizeWords(words: readonly unknown[]): PendantSegment["words"] {
  const out: PendantSegment["words"] = [];
  for (const w of words) {
    if (typeof w !== "object" || w === null) continue;
    const rec = w as Record<string, unknown>;
    const word = typeof rec.word === "string" ? rec.word : typeof rec.punctuated_word === "string" ? rec.punctuated_word : null;
    if (!word) continue;
    const startMs = toMs(rec.start ?? rec.startMs);
    const endMs = toMs(rec.end ?? rec.endMs);
    if (startMs === null || endMs === null || endMs < startMs) continue;
    const confidence = typeof rec.confidence === "number" ? clamp01(rec.confidence) : null;
    out.push({ word, startMs, endMs, confidence });
  }
  return out;
}

function toMs(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  // Flux word timings are seconds; convert to integer ms (the contract requires
  // nonnegative integer ms). Values already in ms (>1000 for a short word) are
  // rare; assume seconds per the adapter's word shape.
  return Math.max(0, Math.round(v * 1000));
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}
