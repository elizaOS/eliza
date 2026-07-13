/**
 * React lifecycle adapter for the realtime voice client. It owns sockets and
 * media only while the build flag, identity, and consent gates remain valid;
 * client states, transcripts, pause markers, and actionable failures feed the
 * existing chat voice controls, which fall back to batch voice when disarmed.
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
   * inside `start()` so the nonce is fresh per session. Returning null (503 /
   * store not configured) surfaces a `consent` error and leaves the batch path
   * as the fallback.
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
   * overrides agentId/conversationId/consentNonce (those come from this hook).
   */
  clientOptions?: Omit<
    VoiceSessionClientOptions,
    "agentId" | "conversationId" | "consentNonce"
  >;
  /**
   * Fired once per session with the mint response — lets the caller record the
   * sessionId for its own telemetry. Optional.
   */
  onMinted?: (minted: VoiceSessionMintResponse) => void;
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
  /** True once `start()` has minted+connected and not yet stopped. */
  active: boolean;
  /** Unified status for the existing `ChatVoiceStatusBar`. */
  status: VoiceContinuousStatus;
  /** Live partial transcript (server `stt_partial`). "" when none. */
  transcriptPartial: string;
  /** Committed final transcript for the current turn (server `stt_final`). */
  transcriptFinal: string;
  /** True while the agent is audibly speaking (phase `speaking`). */
  agentSpeaking: boolean;
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
    // to batch. Any other mint status is a real failure.
    return {
      kind: "mint",
      message: "Couldn't start a realtime voice session.",
      actionable: false,
    };
  }
  // Transport loss past the reconnect budget surfaces as a generic Error from
  // the client (`voice session lost: ...`).
  if (/voice session lost/i.test(error.message)) {
    return {
      kind: "transport",
      message: "Voice connection dropped. Tap to try again.",
      actionable: true,
    };
  }
  return {
    kind: "unknown",
    message: error.message || "Voice session error.",
    actionable: false,
  };
}

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
    speaker,
  } = options;

  const [status, setStatus] = useState<VoiceContinuousStatus>("idle");
  const [transcriptPartial, setTranscriptPartial] = useState("");
  const [transcriptFinal, setTranscriptFinal] = useState("");
  const [agentSpeaking, setAgentSpeaking] = useState(false);
  const [paused, setPaused] = useState(false);
  const [active, setActive] = useState(false);
  const [error, setError] = useState<RealtimeVoiceError | null>(null);
  // `featureDisabled` latches when a mint reports 404 so we stop advertising the
  // realtime path as available (the caller uses batch). Cleared on a fresh
  // `start()` so a later server-flag flip re-probes.
  const [featureDisabled, setFeatureDisabled] = useState(false);

  const clientRef = useRef<VoiceSessionClient | null>(null);
  // A generation counter so a stale client's async callbacks (a teardown that
  // races a new start) cannot write state for a session the component moved on
  // from.
  const sessionGenRef = useRef(0);
  const startingRef = useRef(false);

  // Keep the latest callbacks/config in refs so the stable `start`/`stop`
  // identities don't churn the mic button bindings each render.
  const getConsentNonceRef = useRef(getConsentNonce);
  const createClientRef = useRef(createClient);
  const clientOptionsRef = useRef(clientOptions);
  const onMintedRef = useRef(onMinted);
  const idsRef = useRef({ agentId, conversationId });
  getConsentNonceRef.current = getConsentNonce;
  createClientRef.current = createClient;
  clientOptionsRef.current = clientOptions;
  onMintedRef.current = onMinted;
  idsRef.current = { agentId, conversationId };

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

  const stop = useCallback(async () => {
    sessionGenRef.current += 1;
    startingRef.current = false;
    await teardownClient();
    setActive(false);
    setAgentSpeaking(false);
    setPaused(false);
    setStatus("idle");
    setTranscriptPartial("");
  }, [teardownClient]);

  const start = useCallback(async () => {
    if (startingRef.current || clientRef.current) return;
    if (!flagEnabled) return;
    const { agentId: aId, conversationId: cId } = idsRef.current;
    if (!aId?.trim() || !cId?.trim()) return;

    startingRef.current = true;
    setError(null);
    const gen = ++sessionGenRef.current;
    const isCurrent = () => sessionGenRef.current === gen;
    // Local latch so the synchronous start() flow can see a feature-disabled
    // 404 the moment onError fires (state updates are async and can't be read
    // back mid-function).
    let disabledThisSession = false;

    let consentNonce: string | null;
    try {
      consentNonce = await getConsentNonceRef.current();
    } catch {
      // error-policy:J4 Consent failure selects the visible batch-voice path below.
      consentNonce = null;
    }
    if (!isCurrent()) {
      startingRef.current = false;
      return;
    }
    if (!consentNonce) {
      startingRef.current = false;
      setError({
        kind: "consent",
        message:
          "Couldn't confirm consent for a realtime voice session. Falling back to batch voice.",
        actionable: false,
      });
      return;
    }

    const client = createClientRef.current({
      ...clientOptionsRef.current,
      agentId: aId,
      conversationId: cId,
      consentNonce,
      onState: (state, unifiedStatus) => {
        if (!isCurrent()) return;
        setStatus(unifiedStatus);
        setAgentSpeaking(state.phase === "speaking");
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
        // A 404 mint (feature disabled server-side) reaches us through the
        // client's onError (the client swallows the throw + tears down). Treat
        // it as a fall-back-to-batch signal, NOT an error surface: latch
        // `featureDisabled` so `available` flips false and the caller uses the
        // batch path. Any other error is a real, surfaced failure.
        if (err instanceof VoiceSessionMintError) {
          disabledThisSession = true;
          setFeatureDisabled(true);
          if (err.isFeatureDisabled) return;
        }
        const classified = classifyError(err);
        setError(classified);
        if (classified.kind === "transport" || classified.kind === "mint") {
          disabledThisSession = true;
          setFeatureDisabled(true);
          setActive(false);
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
      // iOS/WebView: resume the AudioContext on THIS user gesture so the first
      // downlink audio is audible without a second tap. Runs AFTER start(),
      // which is what creates the playback context — an unlock before it is a
      // no-op. Still inside the same synchronous user-gesture task in the
      // browser (start's awaits resolve on microtasks before the gesture's
      // activation window closes for a resume()).
      await client.unlockPlayback();
      // Only mark active if the client actually connected. A feature-disabled
      // 404 tore the client down; drop the ref and stay inactive so the caller
      // falls back to batch.
      if (disabledThisSession) {
        clientRef.current = null;
        setActive(false);
      } else if (clientRef.current === client) {
        setActive(true);
      }
    } catch (err) {
      // error-policy:J4 Startup failure becomes a surfaced voice error and batch fallback.
      const realError = err instanceof Error ? err : new Error(String(err));
      const classified = classifyError(realError);
      setError(classified);
      if (
        classified.kind === "transport" ||
        classified.kind === "mint" ||
        classified.kind === "unknown"
      ) {
        setFeatureDisabled(true);
      }
      clientRef.current = null;
      // error-policy:J6 Failed startup teardown follows the surfaced primary error.
      await client.stop().catch(() => {});
      setActive(false);
    } finally {
      startingRef.current = false;
    }
  }, [applyServerEventToTranscript, flagEnabled]);

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
      sessionGenRef.current += 1;
      const client = clientRef.current;
      clientRef.current = null;
      // error-policy:J6 Component teardown has already detached ownership of the client.
      void client?.stop().catch(() => {});
    };
  }, []);

  // If the flag flips off (or ids drop) while a session is live, tear it down —
  // the batch path takes over and a stale realtime socket must not linger.
  useEffect(() => {
    if (!flagEnabled && clientRef.current) {
      void stop();
    }
  }, [flagEnabled, stop]);

  return useMemo<UseRealtimeVoiceSessionState>(
    () => ({
      available,
      active,
      status,
      transcriptPartial,
      transcriptFinal,
      agentSpeaking,
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
      status,
      transcriptPartial,
      transcriptFinal,
      agentSpeaking,
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
