/**
 * Unit tests for createRuntimeReadyGate, the boot barrier that lets HTTP callers
 * await the AgentRuntime becoming available: resolves immediately when a value
 * already exists, holds waiters until markReady then releases them all with the
 * value, and resolves with the current value (possibly null) on timeout.
 * Deterministic, with fake timers for the timeout path.
 */
import { describe, expect, it, vi } from "vitest";
import { createRuntimeReadyGate } from "./runtime-ready-gate.ts";

describe("createRuntimeReadyGate", () => {
  it("resolves immediately when a value already exists", async () => {
    const gate = createRuntimeReadyGate(() => "ready");
    await expect(gate.await(1000)).resolves.toBe("ready");
  });

  it("holds until markReady, then resolves all waiters with the value", async () => {
    let current: string | null = null;
    const gate = createRuntimeReadyGate(() => current);

    const a = gate.await(10_000);
    const b = gate.await(10_000);
    let aResolved = false;
    void a.then(() => {
      aResolved = true;
    });
    // Not resolved yet — still warming.
    await Promise.resolve();
    expect(aResolved).toBe(false);

    current = "rt";
    gate.markReady("rt");
    await expect(a).resolves.toBe("rt");
    await expect(b).resolves.toBe("rt");
  });

  it("resolves with the current value (possibly null) on timeout", async () => {
    vi.useFakeTimers();
    try {
      const gate = createRuntimeReadyGate(() => null);
      const pending = gate.await(5_000);
      vi.advanceTimersByTime(5_000);
      await expect(pending).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a late waiter after markReady sees the now-current value immediately", async () => {
    let current: string | null = null;
    const gate = createRuntimeReadyGate(() => current);
    current = "rt";
    gate.markReady("rt");
    await expect(gate.await(1000)).resolves.toBe("rt");
  });
});
