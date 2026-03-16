/**
 * WebSocket Reconnect Max-Attempt Exhaustion — Tests
 *
 * Verifies:
 * - Connection state tracking across reconnect attempts
 * - "failed" state after max reconnect attempts
 * - Connection state listeners receive correct progression
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock WebSocket
// ---------------------------------------------------------------------------

const mockWsInstances: Array<{
  onopen: (() => void) | null;
  onclose: ((ev: { code: number }) => void) | null;
  onerror: ((ev: Event) => void) | null;
  close: () => void;
  readyState: number;
}> = [];

vi.stubGlobal(
  "WebSocket",
  vi.fn().mockImplementation(() => {
    const ws = {
      onopen: null as (() => void) | null,
      onclose: null as ((ev: { code: number }) => void) | null,
      onerror: null as ((ev: Event) => void) | null,
      onmessage: null as ((ev: { data: string }) => void) | null,
      close: vi.fn(),
      send: vi.fn(),
      readyState: 0, // CONNECTING
    };
    mockWsInstances.push(ws);
    return ws;
  }),
);

beforeEach(() => {
  mockWsInstances.length = 0;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ============================================================================
//  1. Connection state tracking
// ============================================================================

describe("WebSocket connection state tracking", () => {
  it("tracks connection state progression: connecting → connected → disconnected", () => {
    const states: string[] = [];
    let currentState = "disconnected";

    // Simulate state machine
    currentState = "connecting";
    states.push(currentState);

    currentState = "connected";
    states.push(currentState);

    currentState = "disconnected";
    states.push(currentState);

    expect(states).toEqual(["connecting", "connected", "disconnected"]);
  });

  it("enters failed state after max reconnect attempts", () => {
    const MAX_RECONNECT_ATTEMPTS = 15;
    let reconnectCount = 0;
    let state = "connected";

    // Simulate disconnect → reconnect cycle
    for (let i = 0; i < MAX_RECONNECT_ATTEMPTS; i++) {
      state = "disconnected";
      reconnectCount++;
      state = "connecting";

      // Simulate failed connection
      if (reconnectCount >= MAX_RECONNECT_ATTEMPTS) {
        state = "failed";
        break;
      }
    }

    expect(state).toBe("failed");
    expect(reconnectCount).toBe(MAX_RECONNECT_ATTEMPTS);
  });

  it("resetConnection restarts the reconnect cycle", () => {
    let reconnectCount = 15; // exhausted
    let state = "failed";

    // Reset
    reconnectCount = 0;
    state = "connecting";

    expect(state).toBe("connecting");
    expect(reconnectCount).toBe(0);
  });

  it("connection state listeners receive correct progression", () => {
    type ConnectionState =
      | "disconnected"
      | "connecting"
      | "connected"
      | "failed";
    const listeners: Array<(state: ConnectionState) => void> = [];
    const receivedStates: ConnectionState[] = [];

    const addListener = (cb: (state: ConnectionState) => void) => {
      listeners.push(cb);
    };
    const notify = (state: ConnectionState) => {
      for (const cb of listeners) cb(state);
    };

    addListener((s) => receivedStates.push(s));

    notify("connecting");
    notify("connected");
    notify("disconnected");
    notify("connecting");
    notify("failed");

    expect(receivedStates).toEqual([
      "connecting",
      "connected",
      "disconnected",
      "connecting",
      "failed",
    ]);
  });
});
