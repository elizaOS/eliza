/**
 * React hook wrapping {@link PendantConnection} for UI surfaces.
 *
 * Owns one connection instance across its lifetime, mirrors its state into
 * React state, and exposes connect/disconnect. The connection dispatches
 * finalized transcripts as `PENDANT_VOICE_TRANSCRIPT_EVENT`, which the shell
 * routes into a spoken VOICE_DM — so this hook itself does not need to touch the
 * chat send path.
 */

import * as React from "react";

import {
  isPendantSupported,
  PendantConnection,
  type PendantConnectionOptions,
  type PendantState,
} from "./pendant-connection";
import { isPendantLiveStatus } from "./pendant-status";
import type { PendantTranscriptSegmentDetail } from "./transcript-segment-event";

export interface UsePendantOptions {
  vadSilenceMs?: number;
  vadSpeechRmsThreshold?: number;
  onTranscript?: (text: string) => void;
  onSegment?: (detail: PendantTranscriptSegmentDetail) => void;
}

export interface UsePendantResult {
  state: PendantState;
  supported: boolean;
  connect: () => void;
  disconnect: () => void;
  pause: () => void;
  resume: () => void;
}

const INITIAL_STATE: PendantState = {
  status: isPendantSupported() ? "idle" : "unsupported",
  connectStep: "idle",
  deviceName: null,
  batteryPercent: null,
  codecId: null,
  lastTranscript: null,
  droppedPackets: 0,
  error: null,
  typedError: null,
  paused: false,
};

export function usePendant(options: UsePendantOptions = {}): UsePendantResult {
  const [state, setState] = React.useState<PendantState>(INITIAL_STATE);
  const stateRef = React.useRef<PendantState>(INITIAL_STATE);
  const connectionRef = React.useRef<PendantConnection | null>(null);
  // Keep the latest options in a ref so connect() always reads fresh values
  // without re-creating the callback (which would churn the button identity).
  const optionsRef = React.useRef(options);
  optionsRef.current = options;

  const supported = React.useMemo(() => isPendantSupported(), []);

  const setPendantState = React.useCallback((next: PendantState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const connect = React.useCallback(() => {
    const existing = connectionRef.current;
    const currentStatus = stateRef.current.status;
    const busy =
      currentStatus === "requesting" ||
      currentStatus === "connecting" ||
      currentStatus === "reconnecting";
    if (existing && (busy || isPendantLiveStatus(currentStatus))) return;
    if (existing) {
      void existing.connect();
      return;
    }
    const opts: PendantConnectionOptions = {
      onState: setPendantState,
      onTranscript: optionsRef.current.onTranscript,
      onSegment: optionsRef.current.onSegment,
      vadSilenceMs: optionsRef.current.vadSilenceMs,
      vadSpeechRmsThreshold: optionsRef.current.vadSpeechRmsThreshold,
    };
    const conn = new PendantConnection(opts);
    connectionRef.current = conn;
    void conn.connect();
  }, [setPendantState]);

  const disconnect = React.useCallback(() => {
    const conn = connectionRef.current;
    connectionRef.current = null;
    void conn?.disconnect();
  }, []);

  const pause = React.useCallback(() => {
    connectionRef.current?.pause();
  }, []);

  const resume = React.useCallback(() => {
    connectionRef.current?.resume();
  }, []);

  // Tear down on unmount so a background BLE stream doesn't outlive the view.
  React.useEffect(() => {
    return () => {
      void connectionRef.current?.disconnect();
      connectionRef.current = null;
    };
  }, []);

  return { state, supported, connect, disconnect, pause, resume };
}
