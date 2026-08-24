/**
 * Verifies the renderer end of the desktop fused-wake channel (#10351):
 * payload narrowing on `voice:fusedWake`, capability seeding, native detector
 * arming/teardown, and forwarding into the real `window` CustomEvent seam,
 * driven end to end over an in-memory electrobun RPC.
 */
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ElectrobunRendererRpc } from "../bridge/electrobun-rpc";
import {
  type FusedWakeEvent,
  probeFusedWake,
  subscribeFusedWake,
} from "./fused-wake-bridge";
import {
  DESKTOP_FUSED_WAKE_MESSAGE,
  registerDesktopFusedWake,
} from "./fused-wake-desktop-bridge";

type MessageListener = (payload: unknown) => void;

interface BridgeWindow {
  __ELIZA_ELECTROBUN_RPC__?: ElectrobunRendererRpc;
  __ELIZA_FUSED_WAKE__?: boolean;
}

const bridgeWindow = () => window as unknown as BridgeWindow;

/**
 * Minimal in-memory stand-in for the desktop main process: records bridge
 * requests, stores message listeners, and delivers payloads exactly like the
 * electrobun runtime→renderer bus would.
 */
function installFakeBridge() {
  const listeners = new Map<string, MessageListener[]>();
  const requests: Array<{ method: string; params: unknown }> = [];
  const record = (method: string, params?: unknown) =>
    requests.push({ method, params });
  const rpc: ElectrobunRendererRpc = {
    request: {
      fusedWakeStart: (params?: unknown) => {
        record("fusedWakeStart", params);
        return Promise.resolve({ started: true });
      },
      fusedWakeStop: (params?: unknown) => {
        record("fusedWakeStop", params);
        return Promise.resolve({ started: false });
      },
    },
    onMessage(name, listener) {
      const arr = listeners.get(name) ?? [];
      arr.push(listener);
      listeners.set(name, arr);
    },
    offMessage(name, listener) {
      const arr = listeners.get(name) ?? [];
      const index = arr.indexOf(listener);
      if (index >= 0) arr.splice(index, 1);
    },
  };
  bridgeWindow().__ELIZA_ELECTROBUN_RPC__ = rpc;
  return {
    requests,
    listenerCount(name: string): number {
      return (listeners.get(name) ?? []).length;
    },
    /** Deliver a runtime→renderer message to the currently subscribed listeners. */
    emit(payload: unknown): void {
      for (const listener of [
        ...(listeners.get(DESKTOP_FUSED_WAKE_MESSAGE) ?? []),
      ]) {
        listener(payload);
      }
    },
  };
}

const collectEvents = (): {
  events: FusedWakeEvent[];
  unsubscribe: () => void;
} => {
  const events: FusedWakeEvent[] = [];
  const unsubscribe = subscribeFusedWake((event) => events.push(event));
  return { events, unsubscribe };
};

describe("registerDesktopFusedWake", () => {
  beforeEach(() => {
    delete bridgeWindow().__ELIZA_ELECTROBUN_RPC__;
    delete bridgeWindow().__ELIZA_FUSED_WAKE__;
  });

  afterEach(() => {
    delete bridgeWindow().__ELIZA_ELECTROBUN_RPC__;
    delete bridgeWindow().__ELIZA_FUSED_WAKE__;
  });

  it("is a no-op on a non-desktop host, leaving the Swabble fallback intact", () => {
    expect(bridgeWindow().__ELIZA_ELECTROBUN_RPC__).toBeUndefined();

    const cleanup = registerDesktopFusedWake();

    expect(typeof cleanup).toBe("function");
    expect(() => cleanup()).not.toThrow();
    expect(bridgeWindow().__ELIZA_FUSED_WAKE__).toBeUndefined();
    expect(probeFusedWake()).toBe(false);
  });

  it("seeds the fused-wake capability before the controller mounts", () => {
    installFakeBridge();
    expect(probeFusedWake()).toBe(false);

    registerDesktopFusedWake();

    expect(bridgeWindow().__ELIZA_FUSED_WAKE__).toBe(true);
    expect(probeFusedWake()).toBe(true);
  });

  it("subscribes on the canonical message name and arms the native detector once", () => {
    const bridge = installFakeBridge();
    expect(DESKTOP_FUSED_WAKE_MESSAGE).toBe("voice:fusedWake");

    registerDesktopFusedWake();

    expect(bridge.listenerCount(DESKTOP_FUSED_WAKE_MESSAGE)).toBe(1);
    expect(bridge.requests).toEqual([{ method: "fusedWakeStart", params: {} }]);
  });

  it("forwards a head-fired wake into the real window CustomEvent seam", () => {
    const bridge = installFakeBridge();
    const cleanup = registerDesktopFusedWake();
    const { events, unsubscribe } = collectEvents();

    bridge.emit({ stage: "head-fired", confidence: 0.93 });

    expect(events).toEqual([{ stage: "head-fired", confidence: 0.93 }]);
    unsubscribe();
    cleanup();
  });

  it("unsubscribe removes the listener and stops the native detector", () => {
    const bridge = installFakeBridge();
    const { events, unsubscribe } = collectEvents();
    const cleanup = registerDesktopFusedWake();

    cleanup();
    bridge.emit({ stage: "head-fired", confidence: 0.9 });

    expect(bridge.listenerCount(DESKTOP_FUSED_WAKE_MESSAGE)).toBe(0);
    expect(events).toEqual([]);
    expect(bridge.requests.map((r) => r.method)).toEqual([
      "fusedWakeStart",
      "fusedWakeStop",
    ]);
    unsubscribe();
  });
});

describe("desktop fused-wake payload contract", () => {
  beforeEach(() => {
    delete bridgeWindow().__ELIZA_ELECTROBUN_RPC__;
    delete bridgeWindow().__ELIZA_FUSED_WAKE__;
  });

  afterEach(() => {
    delete bridgeWindow().__ELIZA_ELECTROBUN_RPC__;
    delete bridgeWindow().__ELIZA_FUSED_WAKE__;
  });

  function harness() {
    const bridge = installFakeBridge();
    const cleanup = registerDesktopFusedWake();
    const collected = collectEvents();
    return { ...bridge, ...collected, cleanup };
  }

  it("ignores payloads that are not objects", () => {
    const { events, emit, cleanup, unsubscribe } = harness();

    emit(null);
    emit("head-fired");
    emit(42);

    expect(events).toEqual([]);
    unsubscribe();
    cleanup();
  });

  it("ignores stages the desktop producer can never emit", () => {
    const { events, emit, cleanup, unsubscribe } = harness();

    emit({});
    emit({ stage: "wake-word" });
    emit({ stage: null });
    emit({ stage: 3 });

    expect(events).toEqual([]);
    unsubscribe();
    cleanup();
  });

  it("accepts the two-stage variants structurally without inventing them", () => {
    const { events, emit, cleanup, unsubscribe } = harness();

    emit({ stage: "stage-a-candidate" });
    emit({
      stage: "stage-b-transcript",
      transcript: "hey eliza",
      confidence: 0.5,
    });

    expect(events).toEqual([
      { stage: "stage-a-candidate" },
      {
        stage: "stage-b-transcript",
        transcript: "hey eliza",
        confidence: 0.5,
      },
    ]);
    unsubscribe();
    cleanup();
  });

  it("keeps only well-typed optional fields", () => {
    const { events, emit, cleanup, unsubscribe } = harness();

    emit({ stage: "head-fired", confidence: "high", transcript: 42 });

    expect(events).toEqual([{ stage: "head-fired" }]);
    expect("confidence" in events[0]).toBe(false);
    expect("transcript" in events[0]).toBe(false);
    unsubscribe();
    cleanup();
  });

  it("emits a minimal detail for a bare canonical wake", () => {
    const { events, emit, cleanup, unsubscribe } = harness();

    emit({ stage: "head-fired" });

    expect(events).toEqual([{ stage: "head-fired" }]);
    expect(Object.keys(events[0]).sort()).toEqual(["stage"]);
    unsubscribe();
    cleanup();
  });
});
