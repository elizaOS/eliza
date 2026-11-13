/**
 * The shared PTY output subscription: live output is subscribed before the
 * scrollback fetch, chunks that arrive meanwhile survive the snapshot, a
 * reconnect resubscribes and refetches, and nothing runs after stop.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/ui", () => ({ client: {} }));

const { overlapLength, streamPtyOutput } = await import(
  "../ui/pty-output-stream.js"
);

function fakeClient() {
  let wsHandler: ((data: Record<string, unknown>) => void) | undefined;
  let reconnect: (() => void) | undefined;
  const buffers: Array<(text: string) => void> = [];
  const calls: string[] = [];
  const ptyClient = {
    getPtyBufferedOutput: vi.fn(() => {
      calls.push("fetch");
      return new Promise<string>((resolve) => buffers.push(resolve));
    }),
    subscribePtyOutput: vi.fn(() => calls.push("subscribe")),
    unsubscribePtyOutput: vi.fn(() => calls.push("unsubscribe")),
    onWsEvent: vi.fn(
      (_type: string, handler: (data: Record<string, unknown>) => void) => {
        wsHandler = handler;
        return () => {
          wsHandler = undefined;
        };
      },
    ),
    onReconnect: vi.fn((listener: () => void) => {
      reconnect = listener;
      return () => {
        reconnect = undefined;
      };
    }),
  };
  return {
    ptyClient,
    calls,
    emit: (data: string, sessionId = "s1") => wsHandler?.({ sessionId, data }),
    resolveBuffer: async (index: number, text: string) => {
      buffers[index]?.(text);
      await Promise.resolve();
      await Promise.resolve();
    },
    reconnect: () => reconnect?.(),
    hasListeners: () => wsHandler !== undefined || reconnect !== undefined,
  };
}

function recorder() {
  let shown = "";
  return {
    handlers: {
      onSnapshot: (text: string) => {
        shown = text;
      },
      onData: (text: string) => {
        shown += text;
      },
    },
    shown: () => shown,
  };
}

describe("streamPtyOutput", () => {
  it("subscribes before fetching and keeps chunks that arrive during the fetch", async () => {
    const fake = fakeClient();
    const view = recorder();
    streamPtyOutput("s1", view.handlers, fake.ptyClient);
    expect(fake.calls).toEqual(["subscribe", "fetch"]);

    fake.emit("line 3\n");
    fake.emit("line 4\n");
    fake.emit("other\n", "s2");
    await fake.resolveBuffer(0, "line 1\nline 2\nline 3\n");

    expect(view.shown()).toBe("line 1\nline 2\nline 3\nline 4\n");
    fake.emit("line 5\n");
    expect(view.shown()).toBe("line 1\nline 2\nline 3\nline 4\nline 5\n");
  });

  it("resubscribes and replaces the output after a reconnect", async () => {
    const fake = fakeClient();
    const view = recorder();
    streamPtyOutput("s1", view.handlers, fake.ptyClient);
    await fake.resolveBuffer(0, "before\n");

    fake.reconnect();
    expect(fake.ptyClient.subscribePtyOutput).toHaveBeenCalledTimes(2);
    fake.emit("live\n");
    await fake.resolveBuffer(1, "before\nmissed\n");

    expect(view.shown()).toBe("before\nmissed\nlive\n");
  });

  it("ignores a stale fetch that resolves after a newer one started", async () => {
    const fake = fakeClient();
    const view = recorder();
    streamPtyOutput("s1", view.handlers, fake.ptyClient);
    fake.reconnect();
    await fake.resolveBuffer(1, "fresh\n");
    await fake.resolveBuffer(0, "stale\n");
    expect(view.shown()).toBe("fresh\n");
  });

  it("does nothing after stop, even when the fetch resolves later", async () => {
    const fake = fakeClient();
    const view = recorder();
    const stop = streamPtyOutput("s1", view.handlers, fake.ptyClient);
    stop();
    await fake.resolveBuffer(0, "late\n");

    expect(view.shown()).toBe("");
    expect(fake.calls).toEqual(["subscribe", "fetch", "unsubscribe"]);
    expect(fake.hasListeners()).toBe(false);
  });
});

describe("overlapLength", () => {
  it("finds the live prefix the snapshot already ends with", () => {
    expect(overlapLength("abcdef", "defgh")).toBe(3);
    expect(overlapLength("abc", "xyz")).toBe(0);
    expect(overlapLength("", "abc")).toBe(0);
  });
});
