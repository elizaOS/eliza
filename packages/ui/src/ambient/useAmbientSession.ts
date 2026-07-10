/**
 * Ambient capture controller hook.
 *
 * Ties the pendant capture stack (batch transport — {@link usePendant}), the
 * view-owned transcript store (`pendant-transcript-session`, REUSED — no new
 * transcript store), the per-session consent gate, and session bookkeeping
 * (duration, segment count) into one surface the ambient components render.
 *
 * The hook is transport-agnostic at its edges: it reports an
 * {@link AmbientSessionSnapshot} and a segment list, never leaking whether the
 * data arrived over BLE-local-ASR (today) or the ambient WebSocket (later —
 * TODO seam in ambient-session-adapter). Today it selects the `batch`
 * transport; when the WS adapter lands, only the internals change.
 *
 * Consent is enforced here: `start()` refuses unless consent is granted for
 * the current session, and stopping revokes consent so the next session
 * re-prompts (AMBIENT-MODE-DESIGN §8.1).
 */

import * as React from "react";
import {
  createLocalOptimisticPendantTranscriptSessionAdapter,
  EMPTY_PENDANT_TRANSCRIPT_SESSION,
  type PendantTranscriptSegment,
  type PendantTranscriptSessionState,
  pendantTranscriptSessionReducer,
} from "../pendant/pendant-transcript-session";
import { usePendant } from "../pendant/usePendant";
import {
  type AmbientProcessingLocation,
  type AmbientSessionSnapshot,
  type AmbientTransportKind,
  ambientStatusFromPendant,
  selectAmbientTransport,
} from "./ambient-session-adapter";
import {
  type AmbientConsentState,
  ambientCaptureAllowed,
  ambientConsentReducer,
} from "./ambient-consent";

export interface UseAmbientSessionResult {
  /** Coarse transport-agnostic capture state for rendering. */
  snapshot: AmbientSessionSnapshot;
  /** Consent state for the current session attempt. */
  consent: AmbientConsentState;
  /** The live transcript segments (reused pendant transcript store). */
  segments: PendantTranscriptSegment[];
  /** Elapsed capture time in ms (excludes paused spans). */
  elapsedMs: number;
  /** Count of committed (resolved) segments this session. */
  resolvedCount: number;
  /** Count of in-flight (pending) segments. */
  pendingCount: number;
  /** True when a persistent cache read/write failed. */
  cacheError: string | null;
  /** Grant per-session consent (does not start capture). */
  grantConsent: () => void;
  /** Start capture. No-op unless consent is granted. */
  start: () => void;
  /** Sever capture (real pause). */
  pause: () => void;
  /** Resume paused capture. */
  resume: () => void;
  /** Stop capture, end the session, and revoke consent. */
  stop: () => void;
  /** Clear the local transcript view/cache. */
  clear: () => void;
}

/** Monotonic-ish clock; injectable for tests. */
type NowFn = () => number;

export interface UseAmbientSessionOptions {
  /** Override the clock (tests). Defaults to Date.now. */
  now?: NowFn;
  /**
   * Force a transport for testing. Defaults to {@link selectAmbientTransport}
   * (which picks `batch` until the ambient WS adapter is merged).
   */
  transport?: AmbientTransportKind;
}

function processingLocationFor(
  transport: AmbientTransportKind,
): AmbientProcessingLocation {
  // The ambient WS path streams to Deepgram → cloud. The batch/local-ASR path
  // on develop today transcribes on-device. Surface this honestly (§8.1).
  return transport === "websocket" ? "cloud" : "on-device";
}

export function useAmbientSession(
  options: UseAmbientSessionOptions = {},
): UseAmbientSessionResult {
  const now = options.now ?? Date.now;
  const transport = options.transport ?? selectAmbientTransport();

  // Reused transcript store — the same view-owned optimistic cache the pendant
  // transcript view uses. No second transcript store is created.
  const sessionAdapter = React.useMemo(
    () => createLocalOptimisticPendantTranscriptSessionAdapter(),
    [],
  );
  const initial = React.useMemo<{
    session: PendantTranscriptSessionState;
    error: string | null;
  }>(() => {
    try {
      return { session: sessionAdapter.load(), error: null };
    } catch (error) {
      return {
        session: EMPTY_PENDANT_TRANSCRIPT_SESSION,
        error:
          error instanceof Error
            ? error.message
            : "Ambient transcript cache is unavailable.",
      };
    }
  }, [sessionAdapter]);

  const [session, dispatchSession] = React.useReducer(
    pendantTranscriptSessionReducer,
    initial.session,
  );
  const [cacheError, setCacheError] = React.useState(initial.error);
  const [consent, dispatchConsent] = React.useReducer(
    ambientConsentReducer,
    "ungranted" as AmbientConsentState,
  );

  // Duration bookkeeping — accumulate active spans so paused time is excluded.
  const [elapsedMs, setElapsedMs] = React.useState(0);
  const accumulatedRef = React.useRef(0);
  const activeSinceRef = React.useRef<number | null>(null);

  const {
    state: pendantState,
    supported,
    connect,
    disconnect,
    pause: pendantPause,
    resume: pendantResume,
  } = usePendant({
    onSegment: React.useCallback((detail) => {
      dispatchSession({ type: "segment", detail });
    }, []),
  });

  // Persist the reused store whenever it changes, surfacing write failures.
  React.useEffect(() => {
    if (cacheError) return;
    try {
      sessionAdapter.save(session);
    } catch (error) {
      setCacheError(
        error instanceof Error
          ? error.message
          : "Ambient transcript cache could not be saved.",
      );
    }
  }, [cacheError, session, sessionAdapter]);

  const status = ambientStatusFromPendant(
    pendantState.status,
    pendantState.paused,
  );
  const capturing = status === "capturing";

  // Track active-span start/stop transitions for the duration counter.
  React.useEffect(() => {
    if (capturing) {
      if (activeSinceRef.current === null) {
        activeSinceRef.current = now();
      }
    } else if (activeSinceRef.current !== null) {
      accumulatedRef.current += now() - activeSinceRef.current;
      activeSinceRef.current = null;
      setElapsedMs(accumulatedRef.current);
    }
  }, [capturing, now]);

  // Tick the elapsed clock while actively capturing (1s cadence; the LP3 screen
  // is small + grayscale-ish, a coarse mm:ss counter is plenty).
  React.useEffect(() => {
    if (!capturing) return;
    const id = window.setInterval(() => {
      const base = accumulatedRef.current;
      const since = activeSinceRef.current;
      setElapsedMs(since === null ? base : base + (now() - since));
    }, 1_000);
    return () => window.clearInterval(id);
  }, [capturing, now]);

  const snapshot: AmbientSessionSnapshot = {
    status,
    transport,
    processingLocation: processingLocationFor(transport),
    deviceName: pendantState.deviceName,
    capturing,
    supported,
    error:
      status === "error"
        ? (pendantState.typedError?.message ??
          pendantState.error ??
          "Ambient capture failed.")
        : null,
  };

  const grantConsent = React.useCallback(() => {
    dispatchConsent("grant");
  }, []);

  const start = React.useCallback(() => {
    if (!ambientCaptureAllowed(consent)) return;
    connect();
  }, [connect, consent]);

  const pause = React.useCallback(() => {
    pendantPause();
  }, [pendantPause]);

  const resume = React.useCallback(() => {
    pendantResume();
  }, [pendantResume]);

  const stop = React.useCallback(() => {
    disconnect();
    // Ending the session resets ALL per-session bookkeeping to zero: the next
    // consent+start is a brand-new session, so it must not inherit this
    // session's elapsed time. Consent is revoked so the next start re-prompts
    // (§8.1).
    activeSinceRef.current = null;
    accumulatedRef.current = 0;
    setElapsedMs(0);
    dispatchConsent("revoke");
  }, [disconnect]);

  const clear = React.useCallback(() => {
    const at = now();
    try {
      sessionAdapter.clear(at);
      dispatchSession({ type: "clear", at });
      setCacheError(null);
    } catch (error) {
      setCacheError(
        error instanceof Error
          ? error.message
          : "Ambient transcript cache could not be cleared.",
      );
    }
  }, [now, sessionAdapter]);

  const resolvedCount = session.segments.filter(
    (segment) => segment.status === "resolved",
  ).length;
  const pendingCount = session.segments.filter(
    (segment) => segment.status === "pending",
  ).length;

  return {
    snapshot,
    consent,
    segments: session.segments,
    elapsedMs,
    resolvedCount,
    pendingCount,
    cacheError,
    grantConsent,
    start,
    pause,
    resume,
    stop,
    clear,
  };
}
