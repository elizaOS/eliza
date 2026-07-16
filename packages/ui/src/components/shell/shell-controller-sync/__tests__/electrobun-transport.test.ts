/** Electrobun transport adapter: marshals envelopes to the bun relay request and
 *  fans push messages back, validating the untrusted IPC payload. Driven by a
 *  fake bridge (a boundary double, not a mock of the unit under test). */
import { describe, expect, it, vi } from "vitest";
import type { ElectrobunRendererRpc } from "../../../../bridge/electrobun-rpc";
import {
  buildElectrobunShellSyncTransport,
  SHELL_SYNC_PUSH_MESSAGE,
  SHELL_SYNC_RELAY_RPC_METHOD,
} from "../electrobun-transport";
import type { ShellSyncEnvelope } from "../protocol";

const envelope: ShellSyncEnvelope = {
  type: "presence",
  protocolVersion: "1",
  event: "announce",
  windowId: "w",
  priority: 0,
};

function fakeRpc(over: Partial<ElectrobunRendererRpc> = {}): {
  rpc: ElectrobunRendererRpc;
  relay: ReturnType<typeof vi.fn>;
  listeners: Map<string, (payload: unknown) => void>;
} {
  const relay = vi.fn(async () => ({ ok: true }));
  const listeners = new Map<string, (payload: unknown) => void>();
  const rpc: ElectrobunRendererRpc = {
    request: { [SHELL_SYNC_RELAY_RPC_METHOD]: relay },
    onMessage: (name, listener) => listeners.set(name, listener),
    offMessage: (name) => listeners.delete(name),
    ...over,
  };
  return { rpc, relay, listeners };
}

describe("buildElectrobunShellSyncTransport send", () => {
  it("calls the relay request with the envelope", () => {
    const { rpc, relay } = fakeRpc();
    buildElectrobunShellSyncTransport(rpc, () => {}).send(envelope);
    expect(relay).toHaveBeenCalledWith({ envelope });
  });

  it("no-ops when the relay method is absent", () => {
    const { rpc } = fakeRpc({ request: {} });
    expect(() =>
      buildElectrobunShellSyncTransport(rpc, () => {}).send(envelope),
    ).not.toThrow();
  });

  it("routes a relay rejection to onError (never swallowed)", async () => {
    const relay = vi.fn(async () => {
      throw new Error("relay down");
    });
    const { rpc } = fakeRpc({ request: { [SHELL_SYNC_RELAY_RPC_METHOD]: relay } });
    const errors: unknown[] = [];
    buildElectrobunShellSyncTransport(rpc, (e) => errors.push(e)).send(envelope);
    await vi.waitFor(() => expect(errors).toHaveLength(1));
  });
});

describe("buildElectrobunShellSyncTransport subscribe", () => {
  it("delivers a valid pushed envelope and drops a malformed one", () => {
    const { rpc, listeners } = fakeRpc();
    const seen: ShellSyncEnvelope[] = [];
    const unsub = buildElectrobunShellSyncTransport(rpc, () => {}).subscribe((e) =>
      seen.push(e),
    );
    const push = listeners.get(SHELL_SYNC_PUSH_MESSAGE);
    expect(push).toBeTypeOf("function");

    push?.({ envelope });
    push?.({ envelope: { type: "garbage" } });
    push?.({});

    expect(seen).toHaveLength(1);
    expect(seen[0].type).toBe("presence");

    unsub();
    expect(listeners.has(SHELL_SYNC_PUSH_MESSAGE)).toBe(false);
  });
});
