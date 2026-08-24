/** Companion coverage for the electrobun shell-authority transport: the
 * bootstrap fallback plus the request-plumbing and malformed-push branches the
 * primary suite does not exercise. Deterministic unit harness — the real
 * transport module runs against a stubbed renderer bridge only. */
import { describe, expect, it, vi } from "vitest";
import type { ElectrobunRendererRpc } from "../../../../bridge/electrobun-rpc";
import {
  buildElectrobunShellAuthorityTransport,
  createElectrobunShellAuthorityTransport,
  SHELL_AUTHORITY_COMMAND_MESSAGE,
  SHELL_AUTHORITY_DELIVERY_MESSAGE,
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

describe("buildElectrobunShellAuthorityTransport request plumbing", () => {
  it("rejects connect and heartbeat when the desktop RPC handler is missing", async () => {
    const { rpc } = fakeRpc();
    rpc.request = {};
    const transport = buildElectrobunShellAuthorityTransport(rpc, () => {});
    await expect(transport.connect("2")).rejects.toThrow(
      "missing desktop RPC: shellControllerConnect",
    );
    await expect(transport.heartbeat("2")).rejects.toThrow(
      "missing desktop RPC: shellControllerHeartbeat",
    );
  });

  it("throws when connect or heartbeat receive an unparsable state", async () => {
    const { rpc, requests } = fakeRpc();
    requests.shellControllerConnect.mockResolvedValue({ broken: true });
    requests.shellControllerHeartbeat.mockResolvedValue(null);
    const transport = buildElectrobunShellAuthorityTransport(rpc, () => {});
    await expect(transport.connect("2")).rejects.toThrow(
      "shell authority returned invalid state",
    );
    await expect(transport.heartbeat("2")).rejects.toThrow(
      "shell authority returned invalid state",
    );
  });

  it("heartbeats with the protocol version and resolves the parsed state", async () => {
    const { rpc, requests } = fakeRpc();
    const transport = buildElectrobunShellAuthorityTransport(rpc, () => {});
    await expect(transport.heartbeat("7")).resolves.toEqual(state);
    expect(requests.shellControllerHeartbeat).toHaveBeenCalledWith({
      protocolVersion: "7",
    });
  });

  it("publishes snapshots, reports rejections, and rejects malformed responses", async () => {
    const { rpc, requests } = fakeRpc();
    const snapshot = baseSnapshot({ phase: "responding" });
    const transport = buildElectrobunShellAuthorityTransport(rpc, () => {});

    await expect(transport.publishSnapshot(4, snapshot)).resolves.toEqual({
      ok: true,
    });
    expect(requests.shellControllerPublishSnapshot).toHaveBeenCalledWith({
      generation: 4,
      snapshot,
    });

    requests.shellControllerPublishSnapshot.mockResolvedValue({ ok: false });
    await expect(transport.publishSnapshot(5, snapshot)).resolves.toEqual({
      ok: false,
    });

    requests.shellControllerPublishSnapshot.mockResolvedValue({ ok: "yes" });
    await expect(transport.publishSnapshot(6, snapshot)).rejects.toThrow(
      "shell authority returned an invalid response",
    );
  });

  it("surfaces failed dispatch outcomes and defaults their missing error", async () => {
    const { rpc, requests } = fakeRpc();
    const transport = buildElectrobunShellAuthorityTransport(rpc, () => {});

    requests.shellControllerDispatchCommand.mockResolvedValue({
      ok: false,
      error: "mic-busy",
    });
    await expect(
      transport.dispatchCommand("command-2", { kind: "startRecording" }),
    ).resolves.toEqual({ ok: false, error: "mic-busy" });

    requests.shellControllerDispatchCommand.mockResolvedValue({ ok: false });
    await expect(
      transport.dispatchCommand("command-3", { kind: "stop" }),
    ).resolves.toEqual({ ok: false, error: "owner-command-failed" });

    requests.shellControllerDispatchCommand.mockResolvedValue("nope");
    await expect(
      transport.dispatchCommand("command-4", { kind: "stop" }),
    ).rejects.toThrow("shell authority returned an invalid command outcome");
  });

  it("completes commands by spreading the terminal outcome into the request", async () => {
    const { rpc, requests } = fakeRpc();
    const transport = buildElectrobunShellAuthorityTransport(rpc, () => {});
    await expect(
      transport.completeCommand(3, "command-1", "shell-2", {
        ok: false,
        error: "denied",
      }),
    ).resolves.toEqual({ ok: true });
    expect(requests.shellControllerCompleteCommand).toHaveBeenCalledWith({
      generation: 3,
      commandId: "command-1",
      fromEndpointId: "shell-2",
      ok: false,
      error: "denied",
    });
  });

  it("delivers payloads to a target endpoint", async () => {
    const { rpc, requests } = fakeRpc();
    const transport = buildElectrobunShellAuthorityTransport(rpc, () => {});
    await expect(
      transport.deliver(3, "shell-2", {
        kind: "composer-prefill",
        text: "hi",
      }),
    ).resolves.toEqual({ ok: true });
    expect(requests.shellControllerDeliver).toHaveBeenCalledWith({
      generation: 3,
      targetEndpointId: "shell-2",
      delivery: { kind: "composer-prefill", text: "hi" },
    });
  });
});

describe("buildElectrobunShellAuthorityTransport malformed pushes", () => {
  it("routes every invalid push shape to onError without invoking handlers", () => {
    const { rpc, listeners } = fakeRpc();
    const errors: unknown[] = [];
    const onState = vi.fn();
    const onCommand = vi.fn();
    const onDelivery = vi.fn();
    const onPing = vi.fn();
    const transport = buildElectrobunShellAuthorityTransport(rpc, (error) =>
      errors.push(error),
    );
    transport.subscribe({ onState, onCommand, onDelivery, onPing });

    listeners.get(SHELL_AUTHORITY_STATE_MESSAGE)?.({ role: "owner" });
    listeners.get(SHELL_AUTHORITY_DELIVERY_MESSAGE)?.({
      generation: Number.NaN,
      delivery: { kind: "dictation", text: "hello" },
    });
    listeners.get(SHELL_AUTHORITY_DELIVERY_MESSAGE)?.({
      generation: 3,
      delivery: { kind: "unknown-kind" },
    });

    expect(errors).toEqual([
      new Error("shell authority pushed invalid state"),
      new Error("shell authority pushed invalid delivery envelope"),
      new Error("shell authority pushed invalid delivery"),
    ]);
    expect(onState).not.toHaveBeenCalled();
    expect(onCommand).not.toHaveBeenCalled();
    expect(onDelivery).not.toHaveBeenCalled();
    expect(onPing).not.toHaveBeenCalled();
  });
});

describe("createElectrobunShellAuthorityTransport", () => {
  type BridgeWindow = {
    __ELIZA_ELECTROBUN_RPC__?: ElectrobunRendererRpc;
  };

  function bridgeGlobal(): { window?: BridgeWindow } {
    return globalThis as unknown as { window?: BridgeWindow };
  }

  function setBridgeWindow(value: BridgeWindow | undefined): void {
    bridgeGlobal().window = value;
  }

  function currentBridgeWindow(): BridgeWindow | undefined {
    return bridgeGlobal().window;
  }

  it("returns null when no renderer bridge is installed", () => {
    const previous = currentBridgeWindow();
    try {
      setBridgeWindow(undefined);
      expect(createElectrobunShellAuthorityTransport(() => {})).toBeNull();
    } finally {
      setBridgeWindow(previous);
    }
  });

  it("returns null when the bridge lacks shell-authority endpoints", () => {
    const { rpc } = fakeRpc();
    rpc.request = {};
    const previous = currentBridgeWindow();
    try {
      setBridgeWindow({ __ELIZA_ELECTROBUN_RPC__: rpc });
      expect(createElectrobunShellAuthorityTransport(() => {})).toBeNull();
    } finally {
      setBridgeWindow(previous);
    }
  });

  it("builds a working transport when the bridge exposes the authority", () => {
    const { rpc, listeners } = fakeRpc();
    const previous = currentBridgeWindow();
    try {
      setBridgeWindow({ __ELIZA_ELECTROBUN_RPC__: rpc });
      const errors: unknown[] = [];
      const transport = createElectrobunShellAuthorityTransport((error) =>
        errors.push(error),
      );
      expect(transport).not.toBeNull();
      const onState = vi.fn();
      const onCommand = vi.fn();
      const unsubscribe = transport?.subscribe({
        onState,
        onCommand,
        onDelivery: vi.fn(),
        onPing: vi.fn(),
      });
      listeners.get(SHELL_AUTHORITY_STATE_MESSAGE)?.(state);
      listeners.get(SHELL_AUTHORITY_COMMAND_MESSAGE)?.({ forged: true });
      expect(onState).toHaveBeenCalledWith(state);
      expect(errors).toEqual([
        new Error("shell authority pushed invalid command"),
      ]);
      expect(onCommand).not.toHaveBeenCalled();
      unsubscribe?.();
      expect(listeners).toHaveLength(0);
    } finally {
      setBridgeWindow(previous);
    }
  });
});
