/**
 * Verifies registerDesktopFusedWake against a recording electrobun RPC harness
 * installed at window.__ELIZA_ELECTROBUN_RPC__ (jsdom, no native host): the
 * non-desktop no-op fallback, capability-flag arming order, voice:fusedWake
 * subscription + payload narrowing into FusedWakeEvent emissions on the real
 * window CustomEvent bus, the best-effort fusedWakeStart/fusedWakeStop RPCs,
 * and unsubscribe semantics.
 */
// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ElectrobunMessageListener,
  ElectrobunRendererRpc,
} from "../bridge/electrobun-rpc";
import { type FusedWakeEvent, subscribeFusedWake } from "./fused-wake-bridge";
import {
  DESKTOP_FUSED_WAKE_MESSAGE,
  registerDesktopFusedWake,
} from "./fused-wake-desktop-bridge";

/**
 * A behaviour-accurate stand-in for the desktop main process at the transport
 * boundary: routes onMessage/offMessage like the real runtime message bus and
 * records the RPC methods invoked through invokeDesktopBridgeRequest.
 */
interface DesktopHostHarness {
  rpc: ElectrobunRendererRpc;
  /** Message names listeners registered under, in registration order. */
  registeredMessages: string[];
  /** RPC request methods invoked, in invocation order. */
  invokedRequests: string[];
  /** Push a runtime→renderer message to currently subscribed listeners. */
  deliver(messageName: string, payload: unknown): void;
  /** Number of listeners currently subscribed to a message name. */
  listenerCount(messageName: string): number;
}

function createDesktopHostHarness(): DesktopHostHarness {
  const listeners = new Map<string, Set<ElectrobunMessageListener>>();
  const registeredMessages: string[] = [];
  const invokedRequests: string[] = [];
  const bucketOf = (messageName: string): Set<ElectrobunMessageListener> => {
    let bucket = listeners.get(messageName);
    if (!bucket) {
      bucket = new Set();
      listeners.set(messageName, bucket);
    }
    return bucket;
  };
  const rpc: ElectrobunRendererRpc = {
    request: {
      fusedWakeStart: vi.fn(async () => {
        invokedRequests.push("fusedWakeStart");
        return { started: true };
      }),
      fusedWakeStop: vi.fn(async () => {
        invokedRequests.push("fusedWakeStop");
        return {};
      }),
    },
    onMessage: (messageName, listener) => {
      registeredMessages.push(messageName);
      bucketOf(messageName).add(listener);
    },
    offMessage: (messageName, listener) => {
      bucketOf(messageName).delete(listener);
    },
  };
  return {
    rpc,
    registeredMessages,
    invokedRequests,
    deliver(messageName, payload) {
      for (const listener of bucketOf(messageName)) listener(payload);
    },
    listenerCount: (messageName) => listeners.get(messageName)?.size ?? 0,
  };
}

function installDesktopHost(harness: DesktopHostHarness): void {
  (
    window as unknown as { __ELIZA_ELECTROBUN_RPC__?: ElectrobunRendererRpc }
  ).__ELIZA_ELECTROBUN_RPC__ = harness.rpc;
}

function uninstallDesktopHost(): void {
  delete (
    window as unknown as { __ELIZA_ELECTROBUN_RPC__?: ElectrobunRendererRpc }
  ).__ELIZA_ELECTROBUN_RPC__;
}

function clearFusedCapabilityFlag(): void {
  delete window.__ELIZA_FUSED_WAKE__;
}

/** Collect what the real consumer seam (subscribeFusedWake) receives. */
function observeFusedWakes(): {
  received: FusedWakeEvent[];
  stop(): void;
} {
  const received: FusedWakeEvent[] = [];
  const stop = subscribeFusedWake((event) => {
    received.push(event);
  });
  return { received, stop };
}

describe("registerDesktopFusedWake", () => {
  afterEach(() => {
    uninstallDesktopHost();
    clearFusedCapabilityFlag();
  });

  it("is a safe no-op on a non-desktop host", () => {
    // No __ELIZA_ELECTROBUN_RPC__ installed: the Swabble fallback must stay
    // untouched and the returned cleanup must be callable without effect.
    const { received } = observeFusedWakes();
    const dispose = registerDesktopFusedWake();
    expect(typeof dispose).toBe("function");
    expect(() => dispose()).not.toThrow();
    expect(window.__ELIZA_FUSED_WAKE__).toBeUndefined();
    expect(received).toEqual([]);
  });

  it("arms the capability flag synchronously and subscribes on the fused channel before returning", () => {
    const harness = createDesktopHostHarness();
    installDesktopHost(harness);
    const dispose = registerDesktopFusedWake();
    try {
      // Ordering contract with useWakeController: probeFusedWake() reads this
      // flag at mount, so it must be set before registration returns.
      expect(window.__ELIZA_FUSED_WAKE__).toBe(true);
      expect(harness.registeredMessages).toEqual([DESKTOP_FUSED_WAKE_MESSAGE]);
      expect(DESKTOP_FUSED_WAKE_MESSAGE).toBe("voice:fusedWake");
      expect(harness.listenerCount(DESKTOP_FUSED_WAKE_MESSAGE)).toBe(1);
    } finally {
      dispose();
    }
  });

  it("arms the native detector with a fusedWakeStart request during registration", () => {
    const harness = createDesktopHostHarness();
    installDesktopHost(harness);
    const dispose = registerDesktopFusedWake();
    try {
      expect(harness.invokedRequests).toEqual(["fusedWakeStart"]);
    } finally {
      dispose();
    }
  });

  it("forwards a canonical head-fired wake to the renderer event bus", () => {
    const harness = createDesktopHostHarness();
    installDesktopHost(harness);
    const { received } = observeFusedWakes();
    const dispose = registerDesktopFusedWake();

    harness.deliver(DESKTOP_FUSED_WAKE_MESSAGE, {
      stage: "head-fired",
      confidence: 0.87,
    });
    dispose();

    expect(received).toEqual([{ stage: "head-fired", confidence: 0.87 }]);
  });

  it("silently drops payloads that are not objects or carry an unknown stage", () => {
    const harness = createDesktopHostHarness();
    installDesktopHost(harness);
    const { received } = observeFusedWakes();
    const dispose = registerDesktopFusedWake();

    harness.deliver(DESKTOP_FUSED_WAKE_MESSAGE, null);
    harness.deliver(DESKTOP_FUSED_WAKE_MESSAGE, "head-fired");
    harness.deliver(DESKTOP_FUSED_WAKE_MESSAGE, 42);
    harness.deliver(DESKTOP_FUSED_WAKE_MESSAGE, undefined);
    harness.deliver(DESKTOP_FUSED_WAKE_MESSAGE, { stage: "bogus-stage" });
    harness.deliver(DESKTOP_FUSED_WAKE_MESSAGE, {});
    dispose();

    expect(received).toEqual([]);
  });

  it("accepts forward-compatible two-stage payloads structurally", () => {
    const harness = createDesktopHostHarness();
    installDesktopHost(harness);
    const { received } = observeFusedWakes();
    const dispose = registerDesktopFusedWake();

    harness.deliver(DESKTOP_FUSED_WAKE_MESSAGE, {
      stage: "stage-a-candidate",
      confidence: 0.4,
    });
    harness.deliver(DESKTOP_FUSED_WAKE_MESSAGE, {
      stage: "stage-b-transcript",
      confidence: 0.9,
      transcript: "hey eliza",
    });
    dispose();

    expect(received).toEqual([
      { stage: "stage-a-candidate", confidence: 0.4 },
      {
        stage: "stage-b-transcript",
        confidence: 0.9,
        transcript: "hey eliza",
      },
    ]);
  });

  it("omits confidence unless numeric and transcript unless a string", () => {
    const harness = createDesktopHostHarness();
    installDesktopHost(harness);
    const { received } = observeFusedWakes();
    const dispose = registerDesktopFusedWake();

    harness.deliver(DESKTOP_FUSED_WAKE_MESSAGE, {
      stage: "head-fired",
      confidence: "very sure",
    });
    harness.deliver(DESKTOP_FUSED_WAKE_MESSAGE, {
      stage: "head-fired",
      transcript: 12_345,
    });
    dispose();

    expect(received).toEqual([
      { stage: "head-fired" },
      { stage: "head-fired" },
    ]);
  });

  it("stops the native detector and detaches the listener on cleanup", () => {
    const harness = createDesktopHostHarness();
    installDesktopHost(harness);
    const { received } = observeFusedWakes();
    const dispose = registerDesktopFusedWake();

    harness.deliver(DESKTOP_FUSED_WAKE_MESSAGE, {
      stage: "head-fired",
      confidence: 1,
    });
    dispose();

    harness.deliver(DESKTOP_FUSED_WAKE_MESSAGE, {
      stage: "head-fired",
      confidence: 1,
    });

    expect(harness.listenerCount(DESKTOP_FUSED_WAKE_MESSAGE)).toBe(0);
    expect(harness.invokedRequests).toEqual([
      "fusedWakeStart",
      "fusedWakeStop",
    ]);
    expect(received).toEqual([{ stage: "head-fired", confidence: 1 }]);
  });

  it("does not resurrect the capability flag on cleanup", () => {
    const harness = createDesktopHostHarness();
    installDesktopHost(harness);
    const dispose = registerDesktopFusedWake();
    expect(window.__ELIZA_FUSED_WAKE__).toBe(true);
    dispose();
    expect(harness.registeredMessages).toEqual([DESKTOP_FUSED_WAKE_MESSAGE]);
  });
});
