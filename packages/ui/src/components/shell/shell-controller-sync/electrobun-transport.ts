/**
 * The production `ShellSyncTransport`: relays shell-controller envelopes between
 * desktop webviews through the Electrobun native main process (#16442). Each
 * renderer holds an isolated JS context, so the only path between windows is the
 * native host — a renderer sends via the `shellControllerRelay` bun request, and
 * the main process rebroadcasts to every OTHER window as a `shellControllerSync`
 * push message.
 *
 * `createElectrobunShellSyncTransport` returns null when the Electrobun bridge is
 * absent (web, mobile, single-window dev), which is the signal the React host
 * uses to run as a lone always-owner with no cross-window traffic — preserving
 * today's behaviour everywhere except the multi-window desktop.
 */
import {
  getElectrobunRendererRpc,
  type ElectrobunRendererRpc,
} from "../../../bridge/electrobun-rpc";
import { parseShellSyncEnvelope, type ShellSyncEnvelope } from "./protocol";
import type { ShellSyncTransport } from "./transport";

export const SHELL_SYNC_RELAY_RPC_METHOD = "shellControllerRelay";
export const SHELL_SYNC_PUSH_MESSAGE = "shellControllerSync";

interface RelayRequest {
  (params: { envelope: ShellSyncEnvelope }): Promise<unknown>;
}

/** Build the transport over an explicit RPC handle (injected so it can be
 *  driven by a fake bridge in tests). */
export function buildElectrobunShellSyncTransport(
  rpc: ElectrobunRendererRpc,
  onError: (error: unknown) => void,
): ShellSyncTransport {
  return {
    send(envelope) {
      const relay = rpc.request?.[SHELL_SYNC_RELAY_RPC_METHOD] as
        | RelayRequest
        | undefined;
      if (!relay) return;
      // error-policy:J5 fire-and-forget relay — a transient send failure is
      // reported to the host, and its consequence is still observed downstream:
      // a command that never reaches the owner fails closed via the coordinator's
      // ack timeout, and a dropped snapshot self-heals on the next publish. This
      // never fabricates delivery.
      void relay.call(rpc.request, { envelope }).catch(onError);
    },
    subscribe(listener) {
      const handler = (payload: unknown): void => {
        const envelope = (payload as { envelope?: unknown })?.envelope;
        // error-policy:J3 untrusted IPC input — a malformed payload is dropped,
        // never fed into the state machine as a partly-typed object.
        const parsed: ShellSyncEnvelope | null =
          parseShellSyncEnvelope(envelope);
        if (parsed) listener(parsed);
      };
      rpc.onMessage(SHELL_SYNC_PUSH_MESSAGE, handler);
      return () => rpc.offMessage(SHELL_SYNC_PUSH_MESSAGE, handler);
    },
  };
}

export function createElectrobunShellSyncTransport(
  onError: (error: unknown) => void,
): ShellSyncTransport | null {
  const rpc = getElectrobunRendererRpc();
  if (!rpc) return null;
  return buildElectrobunShellSyncTransport(rpc, onError);
}
