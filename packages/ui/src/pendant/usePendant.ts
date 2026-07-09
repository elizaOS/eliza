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
  isWebBluetoothAvailable,
  PendantConnection,
  type PendantConnectionOptions,
  type PendantState,
} from "./pendant-connection";

export interface UsePendantOptions {
  vadSilenceMs?: number;
  vadSpeechRmsThreshold?: number;
  onTranscript?: (text: string) => void;
}

export interface UsePendantResult {
  state: PendantState;
  supported: boolean;
  connect: () => void;
  disconnect: () => void;
}

const INITIAL_STATE: PendantState = {
  status: isWebBluetoothAvailable() ? "idle" : "unsupported",
  deviceName: null,
  batteryPercent: null,
  codecId: null,
  lastTranscript: null,
  droppedPackets: 0,
  error: null,
};

export function usePendant(options: UsePendantOptions = {}): UsePendantResult {
  const [state, setState] = React.useState<PendantState>(INITIAL_STATE);
  const connectionRef = React.useRef<PendantConnection | null>(null);
  // Keep the latest options in a ref so connect() always reads fresh values
  // without re-creating the callback (which would churn the button identity).
  const optionsRef = React.useRef(options);
  optionsRef.current = options;

  const supported = React.useMemo(() => isWebBluetoothAvailable(), []);

  const connect = React.useCallback(() => {
    if (connectionRef.current) return;
    const opts: PendantConnectionOptions = {
      onState: setState,
      onTranscript: optionsRef.current.onTranscript,
      vadSilenceMs: optionsRef.current.vadSilenceMs,
      vadSpeechRmsThreshold: optionsRef.current.vadSpeechRmsThreshold,
    };
    const conn = new PendantConnection(opts);
    connectionRef.current = conn;
    void conn.connect();
  }, []);

  const disconnect = React.useCallback(() => {
    const conn = connectionRef.current;
    connectionRef.current = null;
    void conn?.disconnect();
  }, []);

  // Tear down on unmount so a background BLE stream doesn't outlive the view.
  React.useEffect(() => {
    return () => {
      void connectionRef.current?.disconnect();
      connectionRef.current = null;
    };
  }, []);

  return { state, supported, connect, disconnect };
}
