/**
 * React lifecycle binding for the realtime voice-session client: it arms the
 * WebSocket voice path as an ADDITIVE enhancement of the existing batch mic —
 * same button, same `VoiceContinuousStatus` bar, no second UI surface.
 *
 * Arming requires the VITE realtime flag AND a successful server mint; a mint
 * 404 (feature disabled), a consent failure, or a fatal start failure latches
 * `available` false so the caller quietly runs its unchanged batch flow.
 * `active` is truthful: it turns on only when the client reports a live phase
 * (socket open, server `ready`, mic capturing) — never merely because
 * `start()` resolved — and a bounded connect/ready timer fails a stalled
 * session into a retryable `transport` error instead of hanging in `connecting`.
 *
 * Errors are typed (`RealtimeVoiceError`) and every one is rendered by the
 * status bar: actionable kinds (permission, no-device, transport) keep
 * `available` true so the same mic control retries realtime, while
 * consent/mint failures disarm realtime so the next tap truthfully uses the
 * batch path — the surfaced copy matches that behavior.
 *
 * iOS/WebView: the client constructs + resumes playback synchronously at the
 * start of the user gesture, before consent/mint awaits can consume transient
 * activation; `needsUnlock` drives the existing status-bar CTA when the
 * browser still blocks it. Everything third-party is injectable so tests
 * drive the REAL client over fake transports.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  VoiceContinuousStatus,
  VoiceSpeakerMetadata,
} from "../voice/voice-chat-types";
import {
  createVoiceSessionClient,
  type VoiceSessionClient,
  type VoiceSessionClientOptions,
  VoiceSessionConsentError,
  VoiceSessionMintError,
} from "../voice/voice-session-client";
import { VoiceMicCaptureError } from "../voice/voice-session-mic-capture";
import type {
  ServerControlFrame,
  VoiceSessionMintResponse,
} from "../voice/voice-session-protocol";

/** A realtime-voice error the UI can branch on for an actionable message. */
export type RealtimeVoiceErrorKind =
  | "permission" // mic permission denied — surface a re-enable CTA.
  | "no-device" // no input device — surface an actionable notice.
  | "mint" // mint failed (not a 404; a real failure — 503/500/malformed).
  | "consent" // consent nonce could not be obtained (503 / store off).
  | "transport" // WS transport lost past the reconnect budget.
  | "unknown";

export interface RealtimeVoiceError {
  kind: RealtimeVoiceErrorKind;
  message: string;
  /** True when the user can recover by an action (grant mic, retry). */
  actionable: boolean;
}

/** Consent-nonce source. Returns null when consent could not be issued. */
export type MintConsentNonce = () => Promise<string | null>;

export interface UseRealtimeVoiceSessionOptions {
  /** Owner agent id (UUID) for the mint request. */
  agentId: string | null | undefined;
  /** Conversation id (UUID) for the mint request. */
  conversationId: string | null | undefined;
  /**
   * Whether the VITE-side realtime flag is on. When false the hook is inert
   * (never arms, never mints) and `available` stays false so the caller uses
   * the batch path. Injected (not read here) so the caller owns the flag source
   * and tests drive both branches.
   */
  flagEnabled: boolean;
  /**
   * Obtain a one-time consent nonce (POST /api/v1/voice/session/consent) in
   * response to the visible consent gesture that starts the session. Called
   * by the client immediately before every mint/re-mint so one-use nonces are
   * never replayed. Returning null (503 / store not configured) surfaces a
   * `consent` error and leaves the batch path as the fallback.
   */
  getConsentNonce: MintConsentNonce;
  /**
   * Injectable client factory (defaults to `createVoiceSessionClient`). Tests
   * pass a factory that wires the fake transports.
   */
  createClient?: (options: VoiceSessionClientOptions) => VoiceSessionClient;
  /**
   * Extra client options merged into the created client (mint `fetch`, mint
   * `mintPath`, injected AudioContext/WebSocket factories for tests). NEVER
   * overrides agentId/conversationId/getConsentNonce (those come from this
   * hook).
   */
  clientOptions?: Omit<
    VoiceSessionClientOptions,
    "agentId" | "conversationId" | "getConsentNonce"
  >;
  /**
   * Fired once per session with the mint response — lets the caller record the
   * sessionId for its own telemetry. Optional.
   */
  onMinted?: (minted: VoiceSessionMintResponse) => void;
  /**
   * How long a session may sit in connecting/ready (per stage: socket connect,
   * then server-ready → mic capture) before it is failed into a retryable
   * `transport` error instead of hanging. Default 15s.
   */
  readyTimeoutMs?: number;
  /** Live speaker attribution passthrough for the status bar. Optional. */
  speaker?: VoiceSpeakerMetadata | null;
}

export interface UseRealtimeVoiceSessionState {
  /**
   * True when the realtime path is usable RIGHT NOW: the flag is on AND we have
   * agent+conversation ids AND the last mint attempt did not report the feature
   * disabled. The caller drives the mic button to the realtime lifecycle only
   * while this is true; otherwise it runs the unchanged batch flow.
   */
  available: boolean;
  /**
   * True only while the session is genuinely live: socket open, server `ready`
   * received, and the mic actually capturing. Never true merely because
   * `start()` resolved.
   */
  active: boolean;
  /**
   * True while a started session is still working toward live (consent, mint,
   * socket connect, server ready, mic bring-up). Bounded by the ready timer.
   */
  connecting: boolean;
  /** Unified status for the existing `ChatVoiceStatusBar`. */
  status: VoiceContinuousStatus;
  /** Live partial transcript (server `stt_partial`). "" when none. */
  transcriptPartial: string;
  /** Committed final transcript for the current turn (server `stt_final`). */
  transcriptFinal: string;
  /** True while the agent is audibly speaking (phase `speaking`). */
  agentSpeaking: boolean;
  /** True when queued realtime audio is waiting for a browser autoplay tap. */
  needsUnlock: boolean;
  /**
   * True when the session is alive but the mic was suspended by a
   * visibility-hide — a PAUSED state, not a broken one. Clears on resume.
   */
  paused: boolean;
  /** Actionable/typed error, or null. */
  error: RealtimeVoiceError | null;
  /** Speaker attribution passthrough. */
  speaker: VoiceSpeakerMetadata | null;
  /**
   * Begin a realtime session: unlock playback on THIS gesture, obtain a consent
   * nonce, mint, connect, start capture. Resolves once connect is under way.
   * A mint-disabled (404) result flips `available` false and resolves without
   * error so the caller can fall back to batch on the same gesture.
   */
  start: () => Promise<void>;
  /** Clean `bye` + full teardown. Idempotent. */
  stop: () => Promise<void>;
  /** Barge-in: flush local playback + notify server. No-op when not speaking. */
  bargeIn: () => void;
  /** Resume the AudioContext on a user gesture (iOS autoplay). */
  unlock: () => Promise<void>;
}

function classifyError(error: Error): RealtimeVoiceError {
  if (error instanceof VoiceMicCaptureError) {
    if (error.code === "permission_denied") {
      return {
        kind: "permission",
        message: "Microphone access was blocked. Enable it to talk with voice.",
        actionable: true,
      };
    }
    if (error.code === "no_device") {
      return {
        kind: "no-device",
        message: "No microphone was found. Connect one to talk with voice.",
        actionable: true,
      };
    }
    return {
      kind: "unknown",
      message: error.message || "Voice capture failed.",
      actionable: false,
    };
  }
  if (error instanceof VoiceSessionMintError) {
    // A 404 (feature disabled) is NOT an error surface — the caller falls back
    // to batch. Any other mint status is a real failure; it latches realtime
    // off, so "will use standard voice" is what the next mic tap actually does.
    return {
      kind: "mint",
      message:
        "Couldn't start realtime voice. The mic will use standard voice instead.",
      actionable: false,
    };
  }
  if (error instanceof VoiceSessionConsentError) {
    // Consent failures latch realtime off for this surface, so the copy's
    // promise ("standard voice") is exactly what the next mic tap does.
    return {
      kind: "consent",
      message:
        "Couldn't confirm consent for realtime voice. The mic will use standard voice instead.",
      actionable: false,
    };
  }
  // Transport loss past the reconnect budget surfaces as a generic Error from
  // the client (`voice session lost: ...`). It does NOT latch realtime off —
  // the same mic control retries, so the CTA is honest.
  if (/voice session lost/i.test(error.message)) {
    return {
      kind: "transport",
      message: "Voice connection dropped. Tap the mic to try again.",
      actionable: true,
    };
  }
  return {
    kind: "unknown",
    message: error.message || "Voice session error.",
    actionable: false,
  };
}

/**
 * Client phases in which the session is genuinely live: the socket is open,
 * the server sent `ready`, and the mic is capturing (`beginListening` runs
 * only after the capture pipeline is attached). `connecting`/`ready` are NOT
 * live — the mic may still be pending — and `idle` is torn down.
 */
const LIVE_SESSION_PHASES: ReadonlySet<string> = new Set([
  "listening",
  "transcribing",
  "thinking",
  "speaking",
  "complete",
  "interrupted",
]);

const DEFAULT_READY_TIMEOUT_MS = 15_000;

export function useRealtimeVoiceSession(
  options: UseRealtimeVoiceSessionOptions,
): UseRealtimeVoiceSessionState {
  const {
    agentId,
    conversationId,
    flagEnabled,
    getConsentNonce,
    createClient = createVoiceSessionClient,
    clientOptions,
    onMinted,
    readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
    speaker,
  } = options;

  const [status, setStatus] = useState<VoiceContinuousStatus>("idle");
  const [transcriptPartial, setTranscriptPartial] = useState("");
  const [transcriptFinal, setTranscriptFinal] = useState("");
  const [agentSpeaking, setAgentSpeaking] = useState(false);
  const [needsUnlock, setNeedsUnlock] = useState(false);
  const [paused, setPaused] = useState(false);
  const [active, setActive] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<RealtimeVoiceError | null>(null);
  // `featureDisabled` latches when a mint reports 404 so we stop advertising the
  // realtime path as available for this mounted chat surface (the caller uses
  // batch rather than repeatedly probing a disabled route on every mic tap).
  const [featureDisabled, setFeatureDisabled] = useState(false);

  const clientRef = useRef<VoiceSessionClient | null>(null);
  // A generation counter so a stale client's async callbacks (a teardown that
  // races a new start) cannot write state for a session the component moved on
  // from.
  const sessionGenRef = useRef(0);
  const identityChangeGenRef = useRef(0);
  // Carries automatic restart ownership across rapid A→B→C identity changes.
  // The first teardown clears clientRef synchronously, so the next effect must
  // not mistake that in-flight handoff for an intentionally idle session.
  const identityRestartPendingRef = useRef(false);
  const startingRef = useRef(false);
  // The connect/ready watchdog. Armed while the CURRENT session sits in a
  // pre-live phase; a live phase (or any teardown/error) clears it. There is at
  // most one session, so one shared handle is enough — a newer start's arm
  // clears a stale timer before scheduling its own.
  const readyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep the latest callbacks/config in refs so the stable `start`/`stop`
  // identities don't churn the mic button bindings each render.
  const getConsentNonceRef = useRef(getConsentNonce);
  const createClientRef = useRef(createClient);
  const clientOptionsRef = useRef(clientOptions);
  const onMintedRef = useRef(onMinted);
  const idsRef = useRef({ agentId, conversationId });
  const readyTimeoutMsRef = useRef(readyTimeoutMs);
  getConsentNonceRef.current = getConsentNonce;
  createClientRef.current = createClient;
  clientOptionsRef.current = clientOptions;
  onMintedRef.current = onMinted;
  idsRef.current = { agentId, conversationId };
  readyTimeoutMsRef.current = readyTimeoutMs;

  const clearReadyTimer = useCallback(() => {
    if (readyTimerRef.current !== null) {
      clearTimeout(readyTimerRef.current);
      readyTimerRef.current = null;
    }
  }, []);

  const hasIds = Boolean(agentId?.trim()) && Boolean(conversationId?.trim());
  const available = flagEnabled && hasIds && !featureDisabled;

  const applyServerEventToTranscript = useCallback(
    (event: ServerControlFrame) => {
      switch (event.t) {
        case "stt_partial":
          setTranscriptPartial(event.text);
          break;
        case "stt_final":
          setTranscriptFinal(event.text);
          setTranscriptPartial("");
          break;
        case "ready":
          // A fresh session: clear the previous turn's transcript.
          setTranscriptPartial("");
          setTranscriptFinal("");
          break;
        default:
          break;
      }
    },
    [],
  );

  const teardownClient = useCallback(async () => {
    const client = clientRef.current;
    clientRef.current = null;
    if (client) {
      // error-policy:J6 Socket/microphone teardown is best effort after ownership is cleared.
      await client.stop().catch(() => {});
    }
  }, []);

  const stopCurrentSession = useCallback(async (): Promise<number> => {
    const stoppedGeneration = ++sessionGenRef.current;
    startingRef.current = false;
    clearReadyTimer();
    await teardownClient();
    // A newer lifecycle may start while an old AudioContext close is pending.
    // Only the generation that initiated this teardown may clear UI state.
    if (sessionGenRef.current === stoppedGeneration) {
      setActive(false);
      setConnecting(false);
      setAgentSpeaking(false);
      setNeedsUnlock(false);
      setPaused(false);
      setStatus("idle");
      setTranscriptPartial("");
    }
    return stoppedGeneration;
  }, [clearReadyTimer, teardownClient]);

  const stop = useCallback(async () => {
    // Explicit user/flag-driven stop also revokes any identity-change task that
    // may currently be awaiting teardown before an automatic re-mint.
    identityRestartPendingRef.current = false;
    identityChangeGenRef.current += 1;
    await stopCurrentSession();
  }, [stopCurrentSession]);

  const start = useCallback(async () => {
    if (startingRef.current || clientRef.current) return;
    if (!flagEnabled) return;
    const { agentId: aId, conversationId: cId } = idsRef.current;
    if (!aId?.trim() || !cId?.trim()) return;

    startingRef.current = true;
    setError(null);
    setNeedsUnlock(false);
    const gen = ++sessionGenRef.current;
    const isCurrent = () => sessionGenRef.current === gen;
    // Local latch so the synchronous start() flow can see a feature-disabled
    // 404 the moment onError fires (state updates are async and can't be read
    // back mid-function).
    let failedThisSession = false;

    // Connect/ready watchdog: a session that stalls in connecting/ready (a
    // black-holed socket, a never-arriving `ready`, a hung mic bring-up) must
    // fail into a retryable transport error instead of showing "connecting"
    // forever with the batch mic disabled. Re-armed per pre-live stage so a
    // slow-but-progressing bring-up (e.g. a permission prompt after `ready`)
    // gets a fresh budget at each transition.
    const failOnReadyTimeout = () => {
      readyTimerRef.current = null;
      if (!isCurrent()) return;
      // Invalidate the stalled client's callbacks before tearing it down so a
      // late open/ready cannot resurrect state for a session we just failed.
      sessionGenRef.current += 1;
      startingRef.current = false;
      failedThisSession = true;
      if (clientRef.current === client) clientRef.current = null;
      // error-policy:J6 timed-out session teardown is best effort; the timeout error below is the surfaced failure.
      void client.stop().catch(() => {});
      setError({
        kind: "transport",
        message: "Voice connection timed out. Tap the mic to try again.",
        actionable: true,
      });
      setActive(false);
      setConnecting(false);
      setAgentSpeaking(false);
      setNeedsUnlock(false);
      setPaused(false);
      setStatus("idle");
      setTranscriptPartial("");
    };
    const armReadyTimer = () => {
      clearReadyTimer();
      readyTimerRef.current = setTimeout(
        failOnReadyTimeout,
        readyTimeoutMsRef.current,
      );
    };

    const client = createClientRef.current({
      ...clientOptionsRef.current,
      agentId: aId,
      conversationId: cId,
      // The client invokes this immediately before every mint/re-mint. Keeping
      // the source behind a ref gives reconnects the latest callback and, more
      // importantly, prevents replay of the one-use nonce from the first mint.
      getConsentNonce: () => getConsentNonceRef.current(),
      onState: (state, unifiedStatus) => {
        if (!isCurrent()) return;
        setStatus(unifiedStatus);
        setAgentSpeaking(state.phase === "speaking");
        // `active` derives ONLY from the client's phase: live means the socket
        // opened, the server sent `ready`, and the mic is capturing. Pre-live
        // phases (re)arm the watchdog; a teardown back to idle clears both.
        if (LIVE_SESSION_PHASES.has(state.phase)) {
          clearReadyTimer();
          setConnecting(false);
          setActive(true);
        } else if (state.phase === "connecting" || state.phase === "ready") {
          setConnecting(true);
          armReadyTimer();
        } else {
          clearReadyTimer();
          setConnecting(false);
          setActive(false);
        }
      },
      onMinted: (minted) => {
        if (!isCurrent()) return;
        onMintedRef.current?.(minted);
        clientOptionsRef.current?.onMinted?.(minted);
      },
      onPlaybackUnlockChange: (required) => {
        if (!isCurrent()) return;
        setNeedsUnlock(required);
        clientOptionsRef.current?.onPlaybackUnlockChange?.(required);
      },
      onServerEvent: (event) => {
        if (!isCurrent()) return;
        applyServerEventToTranscript(event);
        clientOptionsRef.current?.onServerEvent?.(event);
      },
      onTraceMark: (marker) => {
        if (!isCurrent()) return;
        // Visibility-suspend surfaces a PAUSED state, not a broken one.
        if (marker.name === "mic_suspended") setPaused(true);
        if (marker.name === "mic_resumed") setPaused(false);
        clientOptionsRef.current?.onTraceMark?.(marker);
      },
      onError: (err) => {
        if (!isCurrent()) return;
        clearReadyTimer();
        // A 404 mint (feature disabled server-side) reaches us through the
        // client's onError (the client swallows the throw + tears down). Treat
        // it as a fall-back-to-batch signal, NOT an error surface: latch
        // `featureDisabled` so `available` flips false and the caller uses the
        // batch path. Any other error is a real, surfaced failure.
        if (err instanceof VoiceSessionMintError) {
          failedThisSession = true;
          setFeatureDisabled(true);
          if (err.isFeatureDisabled) {
            setConnecting(false);
            return;
          }
        }
        const classified = classifyError(err);
        failedThisSession = true;
        setError(classified);
        setActive(false);
        setConnecting(false);
        // Latch realtime off only for failures whose copy promises the batch
        // path ("standard voice"): mint and consent. Actionable kinds
        // (permission, no-device, transport) keep `available` true so the
        // advertised mic-tap retry is actually possible.
        if (classified.kind === "mint" || classified.kind === "consent") {
          setFeatureDisabled(true);
        }
        clientOptionsRef.current?.onError?.(err);
      },
    });
    clientRef.current = client;

    try {
      // `start()` creates the playback AudioContext + mints + connects. The
      // client swallows a mint failure internally (emits via onError, tears
      // down), so this resolves even on a 404 — the fall-back branch is driven
      // by `featureDisabled` (set in onError), not a throw here.
      await client.start();
      if (!isCurrent()) {
        // A newer start/stop superseded us mid-connect; tear this one down.
        // error-policy:J6 A superseded session no longer owns UI state or media resources.
        await client.stop().catch(() => {});
        return;
      }
      // `client.start()` already constructed and attempted to resume playback
      // before its first await, preserving this gesture's transient activation.
      // If that attempt was blocked, `needsUnlock` supplies a fresh CTA gesture;
      // a second resume here would be too late and would only duplicate marks.
      // A resolved start() is NOT "active": the socket may still be connecting
      // and the mic is not capturing yet. `active` flips only when onState
      // reports a live phase; the armed ready timer bounds that wait. A
      // feature-disabled 404 tore the client down; drop the ref so the caller
      // falls back to batch.
      if (failedThisSession) {
        clientRef.current = null;
        setActive(false);
      }
    } catch (err) {
      // error-policy:J4 Startup failure becomes a surfaced voice error and batch fallback.
      clearReadyTimer();
      const realError = err instanceof Error ? err : new Error(String(err));
      const classified = classifyError(realError);
      setError(classified);
      // Same latch policy as onError: only failures whose copy promises the
      // batch path disarm realtime; actionable kinds stay retryable.
      if (
        classified.kind === "mint" ||
        classified.kind === "consent" ||
        classified.kind === "unknown"
      ) {
        setFeatureDisabled(true);
      }
      clientRef.current = null;
      // error-policy:J6 Failed startup teardown follows the surfaced primary error.
      await client.stop().catch(() => {});
      setActive(false);
      setConnecting(false);
      setNeedsUnlock(false);
    } finally {
      // A superseded start may finish after stop + a newer start. It must not
      // clear the newer generation's pending latch.
      if (isCurrent()) startingRef.current = false;
    }
  }, [applyServerEventToTranscript, clearReadyTimer, flagEnabled]);

  const bargeIn = useCallback(() => {
    clientRef.current?.bargeIn();
  }, []);

  const unlock = useCallback(async () => {
    try {
      await clientRef.current?.unlockPlayback();
    } catch (error) {
      // error-policy:J4 Playback denial is visible and disarms the realtime path.
      setError(
        classifyError(
          error instanceof Error ? error : new Error(String(error)),
        ),
      );
      setFeatureDisabled(true);
    }
  }, []);

  // Lifecycle: tear down on unmount so a live socket + hot mic never outlive the
  // component.
  useEffect(() => {
    return () => {
      identityRestartPendingRef.current = false;
      identityChangeGenRef.current += 1;
      sessionGenRef.current += 1;
      if (readyTimerRef.current !== null) {
        clearTimeout(readyTimerRef.current);
        readyTimerRef.current = null;
      }
      const client = clientRef.current;
      clientRef.current = null;
      // error-policy:J6 Component teardown has already detached ownership of the client.
      void client?.stop().catch(() => {});
    };
  }, []);

  // If the flag flips off while a session is live, tear it down — the batch
  // path takes over and a stale realtime socket must not linger.
  useEffect(() => {
    if (!flagEnabled && (clientRef.current || startingRef.current)) {
      void stop();
    }
  }, [flagEnabled, stop]);

  // A mint is scoped to exactly one agent + conversation. If either identity
  // changes while a start/live session owns the mic, stop the old socket and
  // re-mint against the latest ids. A generation guard prevents rapid thread
  // switches from resurrecting an intermediate identity.
  const identityKey = `${agentId?.trim() ?? ""}\n${conversationId?.trim() ?? ""}`;
  const previousIdentityRef = useRef(identityKey);
  useEffect(() => {
    if (previousIdentityRef.current === identityKey) return;
    previousIdentityRef.current = identityKey;

    const shouldRestart = Boolean(
      identityRestartPendingRef.current ||
        clientRef.current ||
        startingRef.current,
    );
    if (!shouldRestart) return;

    identityRestartPendingRef.current = true;
    const changeGen = ++identityChangeGenRef.current;
    let cancelled = false;
    void (async () => {
      const stoppedGeneration = await stopCurrentSession();
      if (
        cancelled ||
        identityChangeGenRef.current !== changeGen ||
        sessionGenRef.current !== stoppedGeneration
      ) {
        return;
      }
      const { agentId: nextAgentId, conversationId: nextConversationId } =
        idsRef.current;
      identityRestartPendingRef.current = false;
      if (flagEnabled && nextAgentId?.trim() && nextConversationId?.trim()) {
        await start();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [flagEnabled, identityKey, start, stopCurrentSession]);

  return useMemo<UseRealtimeVoiceSessionState>(
    () => ({
      available,
      active,
      connecting,
      status,
      transcriptPartial,
      transcriptFinal,
      agentSpeaking,
      needsUnlock,
      paused,
      error,
      speaker: speaker ?? null,
      start,
      stop,
      bargeIn,
      unlock,
    }),
    [
      available,
      active,
      connecting,
      status,
      transcriptPartial,
      transcriptFinal,
      agentSpeaking,
      needsUnlock,
      paused,
      error,
      speaker,
      start,
      stop,
      bargeIn,
      unlock,
    ],
  );
}

/**
 * Read the VITE-side realtime-voice flag. Vite statically replaces
 * `import.meta.env.VITE_*` at build time, so this MUST be a literal member read
 * (not a dynamic key). Absent/blank/anything-but-truthy ⇒ off, so the realtime
 * path never arms unless a build explicitly opts in — the batch path stays the
 * default everywhere.
 */
export function isRealtimeVoiceFlagEnabled(): boolean {
  try {
    const raw = import.meta.env?.VITE_VOICE_REALTIME_WS as unknown;
    if (typeof raw !== "string") return false;
    const v = raw.trim().toLowerCase();
    return v === "1" || v === "true" || v === "yes" || v === "on";
  } catch {
    // error-policy:J4 An unreadable build flag explicitly leaves realtime unavailable.
    return false;
  }
}

// Re-export the mint-error type so the barrel/consumers get it from one place.
export { VoiceSessionMintError };
