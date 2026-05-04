// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useActivityEvents } from "./useActivityEvents";

type WsHandler = (data: Record<string, unknown>) => void;

const { wsHandlers, onWsEventMock } = vi.hoisted(() => ({
  wsHandlers: new Map<string, Set<WsHandler>>(),
  onWsEventMock: vi.fn((type: string, handler: WsHandler): (() => void) => {
    const handlers = wsHandlers.get(type) ?? new Set<WsHandler>();
    handlers.add(handler);
    wsHandlers.set(type, handlers);
    return () => handlers.delete(handler);
  }),
}));

vi.mock("../api", () => ({
  client: {
    onWsEvent: onWsEventMock,
  },
}));

function emitWsEvent(type: string, data: Record<string, unknown>): void {
  for (const handler of wsHandlers.get(type) ?? []) {
    handler(data);
  }
}

describe("useActivityEvents", () => {
  let frameCallbacks: Map<number, FrameRequestCallback>;
  let nextFrameId: number;

  beforeEach(() => {
    wsHandlers.clear();
    onWsEventMock.mockClear();
    frameCallbacks = new Map();
    nextFrameId = 1;
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        const id = nextFrameId;
        nextFrameId += 1;
        frameCallbacks.set(id, callback);
        return id;
      }),
    );
    vi.stubGlobal(
      "cancelAnimationFrame",
      vi.fn((id: number) => {
        frameCallbacks.delete(id);
      }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  function flushAnimationFrames(): void {
    const callbacks = Array.from(frameCallbacks.values());
    frameCallbacks.clear();
    for (const callback of callbacks) {
      callback(performance.now());
    }
  }

  it("coalesces websocket bursts into one animation-frame state update", () => {
    const { result } = renderHook(() => useActivityEvents());

    act(() => {
      emitWsEvent("pty-session-event", {
        eventType: "tool_running",
        sessionId: "session-1",
        data: { toolName: "Read" },
      });
      emitWsEvent("proactive-message", {
        message: "Remember to check the build",
      });
    });

    expect(result.current.events).toEqual([]);
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);

    act(() => {
      flushAnimationFrames();
    });

    expect(result.current.events).toHaveLength(2);
    expect(result.current.events[0]?.eventType).toBe("proactive-message");
    expect(result.current.events[1]?.eventType).toBe("tool_running");
  });

  it("clearEvents cancels a pending frame flush", () => {
    const { result } = renderHook(() => useActivityEvents());

    act(() => {
      emitWsEvent("proactive-message", {
        message: "Queued but cleared before paint",
      });
      result.current.clearEvents();
    });

    expect(result.current.events).toEqual([]);
    expect(frameCallbacks.size).toBe(0);

    act(() => {
      flushAnimationFrames();
    });

    expect(result.current.events).toEqual([]);
  });
});
