/**
 * Remote-guest RPC seam + VM provider backends (#9170 M13).
 *
 * The op→RPC translation, URL resolution, and the success/failure unwrap run in
 * the default lane with a fake transport (no VM, no network). WSB/QEMU boot is
 * driven through injected launchers; real-hypervisor behavior is out of scope
 * for unit tests.
 */

import { describe, expect, it, vi } from "vitest";
import { QEMUBackend } from "../sandbox/qemu-backend.js";
import {
  type GuestRpcRequest,
  type GuestRpcResponse,
  HttpGuestTransport,
  RemoteGuestBackend,
  type RemoteGuestTransport,
  resolveGuestRpcUrl,
  sandboxOpToRpc,
} from "../sandbox/remote-guest.js";
import { SandboxBackendUnavailableError } from "../sandbox/types.js";
import { WSBBackend } from "../sandbox/wsb-backend.js";

function recordingTransport(
  result: unknown = { ok: true },
  success = true,
): RemoteGuestTransport & { calls: GuestRpcRequest[] } {
  const calls: GuestRpcRequest[] = [];
  return {
    name: "fake",
    calls,
    async dispatch(req): Promise<GuestRpcResponse> {
      calls.push(req);
      return success
        ? { success: true, result }
        : { success: false, error: "boom" };
    },
  };
}

describe("sandboxOpToRpc", () => {
  it("maps mouse + keyboard + screenshot ops to cua command names", () => {
    expect(sandboxOpToRpc({ kind: "mouse_move", x: 1, y: 2 })).toEqual({
      command: "move_cursor",
      params: { x: 1, y: 2 },
    });
    expect(sandboxOpToRpc({ kind: "mouse_click", x: 3, y: 4 })).toEqual({
      command: "left_click",
      params: { x: 3, y: 4 },
    });
    expect(sandboxOpToRpc({ kind: "keyboard_type", text: "hi" })).toEqual({
      command: "type_text",
      params: { text: "hi" },
    });
    expect(
      sandboxOpToRpc({
        kind: "screenshot",
        region: { x: 0, y: 0, width: 10, height: 10 },
      }),
    ).toEqual({
      command: "screenshot",
      params: { region: { x: 0, y: 0, width: 10, height: 10 } },
    });
  });

  it("maps run_command with optional cwd/timeout", () => {
    expect(
      sandboxOpToRpc({
        kind: "run_command",
        command: "ls",
        cwd: "/tmp",
        timeout_seconds: 5,
      }),
    ).toEqual({
      command: "run_command",
      params: { command: "ls", cwd: "/tmp", timeout_seconds: 5 },
    });
    expect(sandboxOpToRpc({ kind: "run_command", command: "ls" })).toEqual({
      command: "run_command",
      params: { command: "ls" },
    });
  });
});

describe("resolveGuestRpcUrl", () => {
  it("prefers explicit url, then port, then default", () => {
    expect(resolveGuestRpcUrl({ rpcUrl: "http://x/y" })).toBe("http://x/y");
    expect(resolveGuestRpcUrl({ rpcPort: 9001 })).toBe(
      "http://127.0.0.1:9001/cua",
    );
    expect(resolveGuestRpcUrl({})).toBe("http://127.0.0.1:8000/cua");
  });
});

class FakeBackend extends RemoteGuestBackend {
  readonly name = "fake";
  constructor(private readonly t: RemoteGuestTransport) {
    super();
  }
  protected transport(): RemoteGuestTransport {
    return this.t;
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
}

describe("RemoteGuestBackend.invoke", () => {
  it("returns the result on success", async () => {
    const t = recordingTransport({ base64Png: "AAAA" });
    const backend = new FakeBackend(t);
    const out = await backend.invoke<{ base64Png: string }>({
      kind: "screenshot",
    });
    expect(out).toEqual({ base64Png: "AAAA" });
    expect(t.calls[0]?.command).toBe("screenshot");
  });

  it("throws SandboxInvocationError on failure", async () => {
    const t = recordingTransport(undefined, false);
    const backend = new FakeBackend(t);
    await expect(
      backend.invoke({ kind: "mouse_click", x: 1, y: 1 }),
    ).rejects.toThrow(/left_click.*failed/);
  });
});

describe("HttpGuestTransport", () => {
  it("POSTs the RPC and returns the parsed body", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ success: true, result: { windows: [] } }),
    })) as unknown as typeof fetch;
    const t = new HttpGuestTransport({ url: "http://guest/cua", fetchImpl });
    const res = await t.dispatch({ command: "get_windows", params: {} });
    expect(res).toEqual({ success: true, result: { windows: [] } });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("returns a failure response on a non-2xx status", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
    })) as unknown as typeof fetch;
    const t = new HttpGuestTransport({ url: "http://guest/cua", fetchImpl });
    const res = await t.dispatch({ command: "screenshot", params: {} });
    expect(res.success).toBe(false);
    expect(res.error).toContain("503");
  });
});

describe("WSBBackend", () => {
  it("throws when Windows Sandbox is unavailable and nothing is injected", () => {
    expect(() => new WSBBackend({ available: false })).toThrow(
      SandboxBackendUnavailableError,
    );
  });

  it("boots via the injected launcher and drives ops over the transport", async () => {
    const t = recordingTransport({ ok: true });
    const launch = vi.fn(async () => {});
    const shutdown = vi.fn(async () => {});
    const backend = new WSBBackend({
      available: false,
      transport: t,
      launcher: { launch, shutdown },
      rpcPort: 8123,
    });
    await backend.start();
    await backend.invoke({ kind: "mouse_move", x: 5, y: 6 });
    await backend.stop();
    expect(launch).toHaveBeenCalledWith({ rpcPort: 8123 });
    expect(shutdown).toHaveBeenCalledOnce();
    expect(t.calls[0]?.command).toBe("move_cursor");
  });
});

describe("QEMUBackend", () => {
  it("throws when QEMU is unavailable and no transport is injected", () => {
    expect(
      () =>
        new QEMUBackend({
          image: "guest.qcow2",
          launcher: {
            isAvailable: () => false,
            launch: async () => {},
            shutdown: async () => {},
          },
        }),
    ).toThrow(SandboxBackendUnavailableError);
  });

  it("boots via the injected launcher and drives ops over the transport", async () => {
    const t = recordingTransport({ ok: true });
    const launch = vi.fn(async () => {});
    const backend = new QEMUBackend({
      image: "guest.qcow2",
      transport: t,
      launcher: { isAvailable: () => true, launch, shutdown: async () => {} },
      rpcPort: 9000,
    });
    await backend.start();
    await backend.invoke({ kind: "keyboard_key_press", key: "Enter" });
    expect(launch).toHaveBeenCalledWith({
      image: "guest.qcow2",
      rpcPort: 9000,
    });
    expect(t.calls[0]).toEqual({
      command: "press_key",
      params: { key: "Enter" },
    });
  });
});
