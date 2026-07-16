/**
 * The relay abstraction the shell-controller coordinator talks to (#16442). A
 * transport is a broadcast bus: `send` publishes an envelope to every OTHER
 * participant, `subscribe` receives everyone else's. The coordinator never
 * assumes delivery order or reliability — the protocol's seq/epoch/idempotency
 * do — so a transport only has to fan messages out.
 *
 * Production uses `electrobun-transport.ts` (relayed through the native main
 * process across webviews). `createInMemoryShellSyncBus` here is a real, in-
 * process implementation of the same contract: tests wire several coordinators
 * to one bus to exercise genuine multi-window races without a desktop.
 */
import type { ShellSyncEnvelope } from "./protocol";

export type ShellSyncEnvelopeListener = (envelope: ShellSyncEnvelope) => void;

export interface ShellSyncTransport {
  /** Broadcast to every other participant on the bus. */
  send(envelope: ShellSyncEnvelope): void;
  /** Subscribe to envelopes from other participants; returns an unsubscribe. */
  subscribe(listener: ShellSyncEnvelopeListener): () => void;
}

/** A bus that connects many in-process transports, each of which delivers to
 *  the others but never echoes to itself. */
export interface InMemoryShellSyncBus {
  /** Create one participant's transport endpoint. */
  connect(): ShellSyncTransport;
  /** Sever a participant abruptly (crash simulation): its endpoint stops
   *  sending and receiving without a `bye`. */
  disconnect(transport: ShellSyncTransport): void;
}

export function createInMemoryShellSyncBus(): InMemoryShellSyncBus {
  interface Endpoint {
    transport: ShellSyncTransport;
    listeners: Set<ShellSyncEnvelopeListener>;
    live: boolean;
  }
  const endpoints: Endpoint[] = [];

  return {
    connect(): ShellSyncTransport {
      const listeners = new Set<ShellSyncEnvelopeListener>();
      const transport: ShellSyncTransport = {
        send(envelope) {
          const self = endpoints.find((e) => e.transport === transport);
          if (!self?.live) return;
          for (const endpoint of endpoints) {
            if (endpoint.transport === transport || !endpoint.live) continue;
            // Copy so a receiver mutating a payload cannot corrupt the sender's
            // object; the wire relay serialises, so callers must not rely on
            // reference identity across the bus anyway.
            const copy = structuredClone(envelope);
            for (const listener of endpoint.listeners) listener(copy);
          }
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
      endpoints.push({ transport, listeners, live: true });
      return transport;
    },
    disconnect(transport) {
      const endpoint = endpoints.find((e) => e.transport === transport);
      if (endpoint) endpoint.live = false;
    },
  };
}
