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

  it("ignores authority states that regress generation or snapshot sequence", async () => {
    const fake = authorityTransport({
      endpointId: "follower",
      ownerEndpointId: "owner",
      generation: 3,
      role: "follower",
      status: "connected",
      snapshotSeq: 5,
      snapshot: baseSnapshot({ transcript: "current" }),
    });
    const view = renderHook(() =>
      useShellControllerSync({ transport: fake.transport }),
    );
    await act(async () => {});
    expect(view.result.current.snapshot?.transcript).toBe("current");

    act(() => {
      fake.handlers().onState({
        endpointId: "follower",
        ownerEndpointId: "owner",
        generation: 2,
        role: "follower",
        status: "connected",
        snapshotSeq: 9,
        snapshot: baseSnapshot({ transcript: "older-generation" }),
      });
      fake.handlers().onState({
        endpointId: "follower",
        ownerEndpointId: "owner",
        generation: 3,
        role: "follower",
        status: "connected",
        snapshotSeq: 4,
        snapshot: baseSnapshot({ transcript: "older-sequence" }),
      });
    });
    expect(view.result.current.snapshot?.transcript).toBe("current");

    act(() => {
      fake.handlers().onState({
        endpointId: "follower",
        ownerEndpointId: "owner",
        generation: 3,
        role: "follower",
        status: "connected",
        snapshotSeq: 6,
        snapshot: baseSnapshot({ transcript: "newer-sequence" }),
      });
    });
    expect(view.result.current.snapshot?.transcript).toBe("newer-sequence");
  });

  it("reports an error and keeps prior state when the authority endpoint identity changes", async () => {
    const onError = vi.fn();
    const fake = authorityTransport({
      endpointId: "ep-a",
      ownerEndpointId: "ep-a",
      generation: 1,
      role: "owner",
      status: "connected",
      snapshotSeq: 0,
      snapshot: null,
    });
    const view = renderHook(() =>
      useShellControllerSync({ transport: fake.transport, onError }),
    );
    await act(async () => {});
    expect(view.result.current.generation).toBe(1);

    act(() => {
      fake.handlers().onState({
        endpointId: "ep-b",
        ownerEndpointId: "ep-b",
        generation: 2,
        role: "owner",
        status: "connected",
        snapshotSeq: 0,
        snapshot: null,
      });
    });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBe(
      "shell authority endpoint identity changed",
    );
    expect((onError.mock.calls[0][1] as Error).message).toBe(
      "expected ep-a, received ep-b",
    );
    expect(view.result.current.generation).toBe(1);
    expect(view.result.current.role).toBe("owner");
  });

  it("disconnects and reports when the authority supplies an invalid follower snapshot", async () => {
    const onError = vi.fn();
    const fake = authorityTransport({
      endpointId: "follower",
      ownerEndpointId: "owner",
      generation: 2,
      role: "follower",
      status: "connected",
      snapshotSeq: 1,
      snapshot: { phase: "not-a-real-phase" },
    });
    const view = renderHook(() =>
      useShellControllerSync({ transport: fake.transport, onError }),
    );
    await act(async () => {});
    expect(view.result.current.status).toBe("disconnected");
    expect(view.result.current.snapshot).toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBe(
      "shell authority supplied an invalid snapshot",
    );
  });

  it("disconnects and reports when the initial connection fails", async () => {
    const onError = vi.fn();
    const fake = authorityTransport({
      endpointId: "follower",
      ownerEndpointId: "owner",
      generation: 1,
      role: "follower",
      status: "connected",
      snapshotSeq: 0,
      snapshot: null,
    });
    fake.transport.connect = vi.fn(async () => {
      throw new Error("bridge down");
    });
    const view = renderHook(() =>
      useShellControllerSync({ transport: fake.transport, onError }),
    );
    expect(view.result.current.status).toBe("connecting");
    await act(async () => {});
    expect(view.result.current.status).toBe("disconnected");
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBe("shell authority connection failed");
    expect((onError.mock.calls[0][1] as Error).message).toBe("bridge down");
  });

  it("applies refreshed authority state delivered by a ping", async () => {
    const initial = {
      endpointId: "ep-owner",
      ownerEndpointId: "ep-owner",
      generation: 4,
      role: "owner" as const,
      status: "connected" as const,
      snapshotSeq: 0,
      snapshot: null,
    };
    const fake = authorityTransport(initial);
    fake.transport.heartbeat = vi.fn(async () => ({
      ...initial,
      generation: 6,
      snapshotSeq: 2,
      status: "version-mismatch" as const,
    }));
    const view = renderHook(() =>
      useShellControllerSync({ transport: fake.transport }),
    );
    await act(async () => {});
    expect(view.result.current.status).toBe("connected");

    await act(async () => {
      fake.handlers().onPing();
    });
    expect(fake.transport.heartbeat).toHaveBeenCalledWith(expect.any(String));
    expect(view.result.current.status).toBe("version-mismatch");
  });

  it("reports heartbeat failures raised by the authority transport", async () => {
    const onError = vi.fn();
    const fake = authorityTransport({
      endpointId: "ep-owner",
      ownerEndpointId: "ep-owner",
      generation: 1,
      role: "owner",
      status: "connected",
      snapshotSeq: 0,
      snapshot: null,
    });
    fake.transport.heartbeat = vi.fn(async () => {
      throw new Error("hb down");
    });
    renderHook(() =>
      useShellControllerSync({ transport: fake.transport, onError }),
    );
    await act(async () => {});

    await act(async () => {
      fake.handlers().onPing();
    });
    await vi.waitFor(() =>
      expect(onError).toHaveBeenCalledWith(
        "shell authority heartbeat failed",
        expect.any(Error),
      ),
    );
    expect((onError.mock.calls[0][1] as Error).message).toBe("hb down");
  });

  it("completes an owner command as failed when no controller handler is mounted", async () => {
    const fake = authorityTransport({
      endpointId: "ep-owner",
      ownerEndpointId: "ep-owner",
      generation: 9,
      role: "owner",
      status: "connected",
      snapshotSeq: 0,
      snapshot: null,
    });
    renderHook(() => useShellControllerSync({ transport: fake.transport }));
    await act(async () => {});

    act(() => {
      fake.handlers().onCommand({
        generation: 9,
        commandId: "command-orphan",
        fromEndpointId: "follower",
        command: { kind: "stop" },
      });
    });
    await vi.waitFor(() =>
      expect(fake.completeCommand).toHaveBeenCalledWith(
        9,
        "command-orphan",
        "follower",
        { ok: false, error: "owner controller is not mounted" },
      ),
    );
  });

  it("completes an owner command with the thrown reason when its handler fails", async () => {
    const fake = authorityTransport({
      endpointId: "ep-owner",
      ownerEndpointId: "ep-owner",
      generation: 11,
      role: "owner",
      status: "connected",
      snapshotSeq: 0,
      snapshot: null,
    });
    const view = renderHook(() =>
      useShellControllerSync({ transport: fake.transport }),
    );
    await act(async () => {});

    act(() => {
      view.result.current.setCommandHandler(async () => {
        throw new Error("boom");
      });
      fake.handlers().onCommand({
        generation: 11,
        commandId: "c-err",
        fromEndpointId: "follower",
        command: { kind: "stop" },
      });
    });
    await vi.waitFor(() =>
      expect(fake.completeCommand).toHaveBeenLastCalledWith(
        11,
        "c-err",
        "follower",
        { ok: false, error: "boom" },
      ),
    );

    act(() => {
      view.result.current.setCommandHandler(async () => {
        throw "raw";
      });
      fake.handlers().onCommand({
        generation: 11,
        commandId: "c-raw",
        fromEndpointId: "follower",
        command: { kind: "stop" },
      });
    });
    await vi.waitFor(() =>
      expect(fake.completeCommand).toHaveBeenLastCalledWith(
        11,
        "c-raw",
        "follower",
        { ok: false, error: "raw" },
      ),
    );
  });

  it("reports when the authority rejects a successful command completion", async () => {
    const onError = vi.fn();
    const fake = authorityTransport({
      endpointId: "ep-owner",
      ownerEndpointId: "ep-owner",
      generation: 12,
      role: "owner",
      status: "connected",
      snapshotSeq: 0,
      snapshot: null,
    });
    fake.completeCommand.mockResolvedValue({ ok: false });
    const view = renderHook(() =>
      useShellControllerSync({ transport: fake.transport, onError }),
    );
    await act(async () => {});

    act(() => {
      view.result.current.setCommandHandler(async () => {});
      fake.handlers().onCommand({
        generation: 12,
        commandId: "c-rej",
        fromEndpointId: "follower",
        command: { kind: "stop" },
      });
    });
    await vi.waitFor(() =>
      expect(onError).toHaveBeenCalledWith(
        "shell command completion failed",
        expect.any(Error),
      ),
    );
    expect((onError.mock.calls[0][1] as Error).message).toBe(
      "authority rejected command completion",
    );
  });

  it("ignores command requests outside the applied generation or while not owner", async () => {
    const handler = vi.fn(async () => {});
    const fake = authorityTransport({
      endpointId: "ep-owner",
      ownerEndpointId: "ep-owner",
      generation: 13,
      role: "owner",
      status: "connected",
      snapshotSeq: 0,
      snapshot: null,
    });
    const view = renderHook(() =>
      useShellControllerSync({ transport: fake.transport }),
    );
    await act(async () => {});
    act(() => {
      view.result.current.setCommandHandler(handler);
      fake.handlers().onCommand({
        generation: 99,
        commandId: "c-wrong-gen",
        fromEndpointId: "follower",
        command: { kind: "stop" },
      });
    });
    await act(async () => {});
    expect(handler).not.toHaveBeenCalled();
    expect(fake.completeCommand).not.toHaveBeenCalled();

    const followerFake = authorityTransport({
      endpointId: "follower",
      ownerEndpointId: "owner",
      generation: 2,
      role: "follower",
      status: "connected",
      snapshotSeq: 0,
      snapshot: null,
    });
    const followerView = renderHook(() =>
      useShellControllerSync({ transport: followerFake.transport }),
    );
    await act(async () => {});
    let reached = false;
    act(() => {
      followerView.result.current.setCommandHandler(async () => {
        reached = true;
      });
      followerFake.handlers().onCommand({
        generation: 2,
        commandId: "c-follower",
        fromEndpointId: "someone-else",
        command: { kind: "stop" },
      });
    });
    await act(async () => {});
    expect(reached).toBe(false);
    expect(followerFake.completeCommand).not.toHaveBeenCalled();
  });

  it("dispatches locally as a lone owner and refuses without a mounted handler", async () => {
    const view = renderHook(() => useShellControllerSync({ transport: null }));
    let seenKind = "";
    let seenFrom = "";
    act(() => {
      view.result.current.setCommandHandler(async (command, fromEndpointId) => {
        seenKind = command.kind;
        seenFrom = fromEndpointId;
      });
    });
    await act(async () => {
      await view.result.current.dispatch({ kind: "stop" });
    });
    expect(seenKind).toBe("stop");
    expect(seenFrom).toBe("local");

    act(() => {
      view.result.current.setCommandHandler(null);
    });
    let refusal = "";
    await act(async () => {
      try {
        await view.result.current.dispatch({ kind: "stop" });
      } catch (error) {
        refusal = (error as Error).message;
      }
    });
    expect(refusal).toBe("shell controller is not mounted");
  });

  it("forwards follower dispatch through the authority and surfaces its failures", async () => {
    const fake = authorityTransport({
      endpointId: "follower",
      ownerEndpointId: "owner",
      generation: 3,
      role: "follower",
      status: "connected",
      snapshotSeq: 0,
      snapshot: null,
    });
    const view = renderHook(() =>
      useShellControllerSync({ transport: fake.transport }),
    );
    await act(async () => {});

    await act(async () => {
      await view.result.current.dispatch({ kind: "toggleRecording" });
    });
    expect(fake.transport.dispatchCommand).toHaveBeenCalledWith(
      expect.any(String),
      { kind: "toggleRecording" },
    );

    const captureDispatchError = async (): Promise<string> => {
      let message = "";
      await act(async () => {
        try {
          await view.result.current.dispatch({ kind: "stop" });
        } catch (error) {
          message = (error as Error).message;
        }
      });
      return message;
    };

    fake.transport.dispatchCommand = vi.fn(async () => ({
      ok: false,
      error: "owner declined",
    }));
    expect(await captureDispatchError()).toBe("owner declined");

    fake.transport.dispatchCommand = vi.fn(async () => ({ ok: false }));
    expect(await captureDispatchError()).toBe("owner command failed");
  });

  it("publishes snapshots only from the owner with an authority transport", async () => {
    const lone = renderHook(() => useShellControllerSync({ transport: null }));
    expect(() =>
      lone.result.current.publishSnapshot(baseSnapshot()),
    ).not.toThrow();

    const followerFake = authorityTransport({
      endpointId: "follower",
      ownerEndpointId: "owner",
      generation: 7,
      role: "follower",
      status: "connected",
      snapshotSeq: 0,
      snapshot: null,
    });
    const followerView = renderHook(() =>
      useShellControllerSync({ transport: followerFake.transport }),
    );
    await act(async () => {});
    followerView.result.current.publishSnapshot(baseSnapshot());
    await act(async () => {});
    expect(followerFake.transport.publishSnapshot).not.toHaveBeenCalled();

    const onError = vi.fn();
    const ownerFake = authorityTransport({
      endpointId: "ep-owner",
      ownerEndpointId: "ep-owner",
      generation: 21,
      role: "owner",
      status: "connected",
      snapshotSeq: 0,
      snapshot: null,
    });
    const ownerView = renderHook(() =>
      useShellControllerSync({ transport: ownerFake.transport, onError }),
    );
    await act(async () => {});
    const published = baseSnapshot({ recording: true });
    ownerView.result.current.publishSnapshot(published);
    await vi.waitFor(() =>
      expect(ownerFake.transport.publishSnapshot).toHaveBeenCalledWith(
        21,
        published,
      ),
    );

    ownerFake.transport.publishSnapshot = vi.fn(async () => ({ ok: false }));
    ownerView.result.current.publishSnapshot(published);
    await vi.waitFor(() =>
      expect(onError).toHaveBeenCalledWith(
        "shell snapshot publish failed",
        expect.any(Error),
      ),
    );
    expect((onError.mock.calls[0][1] as Error).message).toBe(
      "authority rejected owner snapshot",
    );
  });

  it("delivers targeted payloads only from the owner with an authority transport", async () => {
    const delivery = { kind: "dictation", text: "hi" } as const;

    const lone = renderHook(() => useShellControllerSync({ transport: null }));
    await act(async () => {
      await expect(
        lone.result.current.deliver("ep-x", delivery),
      ).rejects.toThrow("targeted delivery requires desktop authority");
    });

    const followerFake = authorityTransport({
      endpointId: "follower",
      ownerEndpointId: "owner",
      generation: 5,
      role: "follower",
      status: "connected",
      snapshotSeq: 0,
      snapshot: null,
    });
    const followerView = renderHook(() =>
      useShellControllerSync({ transport: followerFake.transport }),
    );
    await act(async () => {});
    await act(async () => {
      await expect(
        followerView.result.current.deliver("ep-y", delivery),
      ).rejects.toThrow("only owner can deliver");
    });
    expect(followerFake.transport.deliver).not.toHaveBeenCalled();

    const ownerFake = authorityTransport({
      endpointId: "ep-owner",
      ownerEndpointId: "ep-owner",
      generation: 5,
      role: "owner",
      status: "connected",
      snapshotSeq: 0,
      snapshot: null,
    });
    const ownerView = renderHook(() =>
      useShellControllerSync({ transport: ownerFake.transport }),
    );
    await act(async () => {});
    await act(async () => {
      await ownerView.result.current.deliver("ep-t", delivery);
    });
    expect(ownerFake.transport.deliver).toHaveBeenCalledWith(
      5,
      "ep-t",
      delivery,
    );

    ownerFake.transport.deliver = vi.fn(async () => ({ ok: false }));
    await act(async () => {
      await expect(
        ownerView.result.current.deliver("ep-z", delivery),
      ).rejects.toThrow("authority rejected targeted delivery");
    });
  });

  it("forwards reportError to the injected error handler", () => {
    const onError = vi.fn();
    const view = renderHook(() =>
      useShellControllerSync({ transport: null, onError }),
    );
    const boom = new Error("manual");
    view.result.current.reportError("operator note", boom);
    expect(onError).toHaveBeenCalledWith("operator note", boom);
  });
});
