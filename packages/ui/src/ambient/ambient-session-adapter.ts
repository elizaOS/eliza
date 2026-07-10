/**
 * Ambient capture data-layer adapter.
 *
 * AMBIENT-MODE-DESIGN says ambient is "a second mode on the existing
 * voice-session WebSocket" whose finals commit to the canonical
 * `pendant_sessions_v1` store. That WS mode is NOT merged yet (design section 9,
 * Phase 1a rides an in-flight server lane). So the ambient UI talks to the data
 * layer through THIS small adapter interface, with two implementations:
 *
 *   - `batch` — the working impl. It drives the pendant capture stack that
 *     exists on develop today: {@link usePendant} (BLE mic → local VAD → local
 *     ASR) surfacing `PendantTranscriptSegmentDetail`s, folded into the existing
 *     view-owned transcript store (`pendant-transcript-session`). No new
 *     transcript store, no new session store — the adapter is a thin control
 *     surface over the surfaces already in packages/ui/src/pendant.
 *
 *   - `ws` — a TODO seam only. When the ambient WebSocket mode
 *     (`mode:"ambient"` mint + `stt_final`/`segment_committed` events) lands, a
 *     second implementation binds here and the UI is unchanged. Until then it
 *     is `null` and the UI selects `batch`.
 *
 * The adapter is deliberately transport-agnostic: it exposes lifecycle
 * (start/pause/resume/stop), a live status snapshot, and a segment subscription,
 * so the ambient control + feed components never learn whether the segments
 * arrived over BLE-local-ASR (today) or over the ambient WS (later).
 *
 * FORBIDDEN (per design section 11): this adapter never creates a second
 * transcript store, a second session store, a second STT client, or a second
 * VAD. It reuses the pendant surfaces.
 */

import type { PendantStatus } from "../pendant/pendant-status";
import type { PendantTranscriptSegmentDetail } from "../pendant/transcript-segment-event";

/**
 * Which transport backs the ambient data layer. `batch` is the develop-today
 * BLE + local-ASR path; `websocket` is the not-yet-merged ambient WS mode.
 */
export type AmbientTransportKind = "batch" | "websocket";

/** High-level ambient capture lifecycle, independent of transport internals. */
export type AmbientCaptureStatus =
  | "unsupported"
  | "idle"
  | "starting"
  | "capturing"
  | "paused"
  | "stopping"
  | "error";

/**
 * Where audio is processed. Ambient over the WS is unambiguously "cloud"
 * (streams to Deepgram); the batch/local-ASR path today is "on-device". The UI
 * surfaces this honestly and never claims on-device for a cloud path
 * (design section 8.1).
 */
export type AmbientProcessingLocation = "on-device" | "cloud";

/** Immutable snapshot of ambient capture state for rendering. */
export interface AmbientSessionSnapshot {
  status: AmbientCaptureStatus;
  transport: AmbientTransportKind;
  /** Where the audio is processed, surfaced verbatim to the user. */
  processingLocation: AmbientProcessingLocation;
  /** Human-facing device / source name, when known. */
  deviceName: string | null;
  /** True while audio is actively being captured (not paused, not idle). */
  capturing: boolean;
  /** True when the transport cannot run in this environment. */
  supported: boolean;
  /** Last error message, if the session is in an error state. */
  error: string | null;
}

/** A segment lifecycle update from the ambient data layer. */
export type AmbientSegmentListener = (
  detail: PendantTranscriptSegmentDetail,
) => void;

/** A snapshot-change listener (status/device/error transitions). */
export type AmbientSnapshotListener = (
  snapshot: AmbientSessionSnapshot,
) => void;

/**
 * The transport-agnostic ambient data adapter the UI drives. Implementations
 * bridge to a concrete capture stack (BLE-local today, WS later).
 */
export interface AmbientSessionAdapter {
  readonly transport: AmbientTransportKind;
  /** Current state snapshot. */
  snapshot(): AmbientSessionSnapshot;
  /** Begin capture. No-op / idempotent if already capturing. */
  start(): void;
  /** Sever the capture stream (real pause, not "stop rendering"). */
  pause(): void;
  /** Resume a paused capture stream. */
  resume(): void;
  /** End the session and release the capture source. */
  stop(): void;
  /** Subscribe to segment lifecycle updates. Returns an unsubscribe fn. */
  onSegment(listener: AmbientSegmentListener): () => void;
  /** Subscribe to snapshot changes. Returns an unsubscribe fn. */
  onSnapshot(listener: AmbientSnapshotListener): () => void;
}

/**
 * Map a raw pendant status into the coarser ambient capture status. Ambient
 * does not surface the fine-grained BLE connect steps; it collapses them into
 * `starting`, and treats any "live" audio state as `capturing`.
 */
export function ambientStatusFromPendant(
  status: PendantStatus,
  paused: boolean,
): AmbientCaptureStatus {
  if (status === "unsupported") return "unsupported";
  if (status === "error") return "error";
  if (status === "idle") return "idle";
  if (
    status === "requesting" ||
    status === "connecting" ||
    status === "reconnecting"
  ) {
    return "starting";
  }
  // connected / listening / hearing / transcribing / paused → capturing/paused
  if (paused || status === "paused") return "paused";
  return "capturing";
}

/**
 * TODO(ambient-ws): return the ambient WebSocket adapter once `mode:"ambient"`
 * mint + `stt_final`/`segment_committed` land (AMBIENT-MODE-DESIGN §1, §9
 * Phase 1a). It will bind to a stable `pendantSessionId`, renew the capture
 * lease over the socket, and surface `processingLocation: "cloud"`. Until then
 * this is `null` and {@link selectAmbientTransport} falls back to `batch`.
 */
export function createAmbientWebSocketAdapter(): AmbientSessionAdapter | null {
  return null;
}

/**
 * Pick the ambient transport. Prefers the WS adapter when available; otherwise
 * uses `batch` (the develop-today path). The `preferWebSocket` arg exists so a
 * future flag can force the WS path for testing without changing call sites.
 */
export function selectAmbientTransport(
  preferWebSocket = true,
): AmbientTransportKind {
  if (preferWebSocket && createAmbientWebSocketAdapter() !== null) {
    return "websocket";
  }
  return "batch";
}
