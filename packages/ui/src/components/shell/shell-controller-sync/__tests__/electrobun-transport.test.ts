/** Native-authority transport contract: typed requests, strict push decoding,
 * awaited command outcomes, and complete listener teardown. */
import { describe, expect, it, vi } from "vitest";
import type { ElectrobunRendererRpc } from "../../../../bridge/electrobun-rpc";
import {
  buildElectrobunShellAuthorityTransport,
  SHELL_AUTHORITY_COMMAND_MESSAGE,
  SHELL_AUTHORITY_DELIVERY_MESSAGE,
  SHELL_AUTHORITY_PING_MESSAGE,
  SHELL_AUTHORITY_STATE_MESSAGE,
} from "../electrobun-transport";
import { baseSnapshot } from "./fixtures";

const state = {
  endpointId: "shell-2",
  ownerEndpointId: "shell-1",
  generation: 3,
  role: "follower" as const,
  status: "connected" as const,
  snapshotSeq: 1,
  snapshot: baseSnapshot(),
};

function fakeRpc(): {
  rpc: ElectrobunRendererRpc;
  requests: Record<string, ReturnType<typeof vi.fn>>;
  listeners: Map<string, (payload: unknown) => void>;
} {
  const requests = {
    shellControllerConnect: vi.fn(async () => state),
    shellControllerHeartbeat: vi.fn(async () => state),
    shellControllerPublishSnapshot: vi.fn(async () => ({ ok: true })),
    shellControllerDispatchCommand: vi.fn(async () => ({ ok: true })),
    shellControllerCompleteCommand: vi.fn(async () => ({ ok: true })),
    shellControllerDeliver: vi.fn(async () => ({ ok: true })),
  };
  const listeners = new Map<string, (payload: unknown) => void>();
  return {
    requests,
    listeners,
    rpc: {
      request: requests,
      onMessage: (name, listener) => listeners.set(name, listener),
      offMessage: (name) => listeners.delete(name),
    },
  };
}

describe("buildElectrobunShellAuthorityTransport", () => {
  it("uses typed authority requests and waits for terminal command results", async () => {
    const { rpc, requests } = fakeRpc();
    const transport = buildElectrobunShellAuthorityTransport(rpc, () => {});
    await expect(transport.connect("2")).resolves.toEqual(state);
    await expect(
      transport.dispatchCommand("command-1", { kind: "stop" }),
    ).resolves.toEqual({ ok: true });
    expect(requests.shellControllerConnect).toHaveBeenCalledWith({
      protocolVersion: "2",
    });
    expect(requests.shellControllerDispatchCommand).toHaveBeenCalledWith({
      commandId: "command-1",
      command: { kind: "stop" },
    });
  });

  it("decodes authority pushes, rejects malformed input, and unsubscribes", () => {
    const { rpc, listeners } = fakeRpc();
    const errors: unknown[] = [];
    const onState = vi.fn();
    const onCommand = vi.fn();
    const onDelivery = vi.fn();
    const onPing = vi.fn();
    const transport = buildElectrobunShellAuthorityTransport(rpc, (error) =>
      errors.push(error),
    );
    const unsubscribe = transport.subscribe({
      onState,
      onCommand,
      onDelivery,
      onPing,
    });

    listeners.get(SHELL_AUTHORITY_STATE_MESSAGE)?.(state);
    listeners.get(SHELL_AUTHORITY_COMMAND_MESSAGE)?.({
      generation: 3,
      commandId: "command-1",
      fromEndpointId: "shell-2",
      command: { kind: "stop" },
    });
    listeners.get(SHELL_AUTHORITY_DELIVERY_MESSAGE)?.({
      generation: 3,
      delivery: { kind: "dictation", text: "hello" },
    });
    listeners.get(SHELL_AUTHORITY_PING_MESSAGE)?.({ now: 1 });
    listeners.get(SHELL_AUTHORITY_COMMAND_MESSAGE)?.({ command: "forged" });

    expect(onState).toHaveBeenCalledWith(state);
    expect(onCommand).toHaveBeenCalledTimes(1);
    expect(onDelivery).toHaveBeenCalledWith(3, {
      kind: "dictation",
      text: "hello",
    });
    expect(onPing).toHaveBeenCalledTimes(1);
    expect(errors).toHaveLength(1);

    unsubscribe();
    expect(listeners).toHaveLength(0);
  });
});
