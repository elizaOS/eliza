// @vitest-environment jsdom
//
// Regression coverage for the WS-reconnect path: a reconnect opens a NEW
// server-side socket whose per-connection PTY subscription map is empty, so a
// mounted pane that doesn't re-send pty-subscribe silently stops receiving
// output and has its keystrokes rejected as "not subscribed". The pane must
// re-subscribe on every reconnect and tear the listener down on unmount.
// xterm and the client boundary are mocked; the component logic is real.
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const reconnectListeners = new Set<() => void>();
  return {
    reconnectListeners,
    subscribePtyOutput: vi.fn(),
    unsubscribePtyOutput: vi.fn(),
    getPtyBufferedOutput: vi.fn(async () => ""),
    sendPtyInput: vi.fn(),
    resizePty: vi.fn(),
    onWsEvent: vi.fn(() => () => undefined),
    onReconnect: vi.fn((listener: () => void) => {
      reconnectListeners.add(listener);
      return () => reconnectListeners.delete(listener);
    }),
    fireReconnect: () => {
      for (const listener of reconnectListeners) listener();
    },
  };
});

vi.mock("@elizaos/ui", () => ({
  client: {
    subscribePtyOutput: mocks.subscribePtyOutput,
    unsubscribePtyOutput: mocks.unsubscribePtyOutput,
    getPtyBufferedOutput: mocks.getPtyBufferedOutput,
    sendPtyInput: mocks.sendPtyInput,
    resizePty: mocks.resizePty,
    onWsEvent: mocks.onWsEvent,
    onReconnect: mocks.onReconnect,
  },
}));

// Lightweight xterm stand-ins — jsdom has no canvas for the real renderer.
vi.mock("@xterm/xterm", () => ({
  Terminal: class TerminalMock {
    cols = 80;
    rows = 24;
    loadAddon(): void {}
    open(): void {}
    write(): void {}
    scrollToBottom(): void {}
    onData(): void {}
    dispose(): void {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class FitAddonMock {
    fit = (): void => {};
  },
}));

import { PtyTerminalPane } from "./PtyTerminalPane";

class ResizeObserverMock {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  vi.stubGlobal(
    "requestAnimationFrame",
    (cb: FrameRequestCallback): number =>
      setTimeout(() => cb(0), 0) as unknown as number,
  );
  vi.stubGlobal("cancelAnimationFrame", (id: number): void => {
    clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.reconnectListeners.clear();
  vi.unstubAllGlobals();
});

describe("PtyTerminalPane — WS reconnect re-subscribe", () => {
  it("subscribes on mount and re-sends pty-subscribe on every reconnect", async () => {
    render(<PtyTerminalPane sessionId="sess-42" visible={true} />);

    await waitFor(() =>
      expect(mocks.subscribePtyOutput).toHaveBeenCalledWith("sess-42"),
    );
    expect(mocks.subscribePtyOutput).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(mocks.onReconnect).toHaveBeenCalledTimes(1));

    mocks.fireReconnect();
    expect(mocks.subscribePtyOutput).toHaveBeenCalledTimes(2);
    expect(mocks.subscribePtyOutput).toHaveBeenLastCalledWith("sess-42");

    mocks.fireReconnect();
    expect(mocks.subscribePtyOutput).toHaveBeenCalledTimes(3);
  });

  it("stops re-subscribing after unmount (listener disposed, session unsubscribed)", async () => {
    const { unmount } = render(
      <PtyTerminalPane sessionId="sess-42" visible={true} />,
    );
    await waitFor(() => expect(mocks.onReconnect).toHaveBeenCalledTimes(1));

    unmount();
    expect(mocks.unsubscribePtyOutput).toHaveBeenCalledWith("sess-42");
    expect(mocks.reconnectListeners.size).toBe(0);

    mocks.fireReconnect();
    expect(mocks.subscribePtyOutput).toHaveBeenCalledTimes(1);
  });
});
