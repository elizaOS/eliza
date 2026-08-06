// @vitest-environment jsdom
/** React authority integration: role/snapshot application, awaited command
 * completion, targeted delivery, and the transport-free lone-owner path. */
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  ShellAuthorityTransport,
  ShellAuthorityTransportHandlers,
} from "../electrobun-transport";
import type { ShellAuthorityState } from "../protocol";
import { useShellControllerSync } from "../useShellControllerSync";
import { baseSnapshot } from "./fixtures";

function authorityTransport(initial: ShellAuthorityState): {
  transport: ShellAuthorityTransport;
  completeCommand: ReturnType<typeof vi.fn>;
  handlers: () => ShellAuthorityTransportHandlers;
} {
  let subscribed: ShellAuthorityTransportHandlers | null = null;
  const completeCommand = vi.fn(async () => ({ ok: true }));
  return {
    completeCommand,
    handlers: () => {
      if (!subscribed) throw new Error("transport not subscribed");
      return subscribed;
    },
    transport: {
      connect: vi.fn(async () => initial),
      heartbeat: vi.fn(async () => initial),
      publishSnapshot: vi.fn(async () => ({ ok: true })),
      dispatchCommand: vi.fn(async () => ({ ok: true })),
      completeCommand,
      deliver: vi.fn(async () => ({ ok: true })),
      subscribe: (handlers) => {
        subscribed = handlers;
        return () => {
          subscribed = null;
        };
      },
    },
  };
}

describe("useShellControllerSync", () => {
  it("reports owner command success only after the async handler settles", async () => {
    const fake = authorityTransport({
      endpointId: "owner",
      ownerEndpointId: "owner",
      generation: 4,
      role: "owner",
      status: "connected",
      snapshotSeq: 0,
      snapshot: null,
    });
    const view = renderHook(() =>
      useShellControllerSync({ transport: fake.transport }),
    );
    await act(async () => {});
    expect(view.result.current.role).toBe("owner");

    let finish!: () => void;
    const applied = new Promise<void>((resolve) => {
      finish = resolve;
    });
    act(() => {
      view.result.current.setCommandHandler(async () => applied);
      fake.handlers().onCommand({
        generation: 4,
        commandId: "command-1",
        fromEndpointId: "follower",
        command: { kind: "stop" },
      });
    });
    expect(fake.completeCommand).not.toHaveBeenCalled();
    await act(async () => finish());
    await vi.waitFor(() =>
      expect(fake.completeCommand).toHaveBeenCalledWith(
        4,
        "command-1",
        "follower",
        { ok: true },
      ),
    );
  });

  it("applies a validated follower snapshot and targeted dictation", async () => {
    const snapshot = baseSnapshot({ transcript: "shared", recording: true });
    const fake = authorityTransport({
      endpointId: "follower",
      ownerEndpointId: "owner",
      generation: 2,
      role: "follower",
      status: "connected",
      snapshotSeq: 1,
      snapshot,
    });
    const view = renderHook(() =>
      useShellControllerSync({ transport: fake.transport }),
    );
    await act(async () => {});
    expect(view.result.current.snapshot?.transcript).toBe("shared");
    const delivery = vi.fn();
    act(() => {
      view.result.current.setDeliveryHandler(delivery);
      fake.handlers().onDelivery(2, { kind: "dictation", text: "hello" });
      fake.handlers().onDelivery(1, { kind: "dictation", text: "stale" });
    });
    expect(delivery).toHaveBeenCalledTimes(1);
    expect(delivery).toHaveBeenCalledWith({ kind: "dictation", text: "hello" });
  });

  it("is owner immediately without a desktop authority", () => {
    const view = renderHook(() => useShellControllerSync({ transport: null }));
    expect(view.result.current.role).toBe("owner");
    expect(view.result.current.status).toBe("connected");
  });
});
