/**
 * Unit coverage for the readiness decision driving useChatLifecycle's status
 * re-poll loop (clearing the "waking up" banner). Pure functions, no harness.
 */
import { describe, expect, it, vi } from "vitest";
import type { AgentStatus } from "../api";
import { shouldAwaitAgentReadiness } from "./types";
import { readinessPollSignature } from "./useChatLifecycle";

/**
 * shouldAwaitAgentReadiness is the decision that drives useChatLifecycle's 1.5s
 * status re-poll loop — the mechanism that clears the "waking up" banner once a
 * dedicated cloud agent reports it can respond (#8777). It must keep polling
 * while not-ready (incl. a cloud agent whose status carries no local model) and
 * stop the instant canRespond flips true.
 */
const status = (s: Partial<AgentStatus>): AgentStatus => s as AgentStatus;

describe("shouldAwaitAgentReadiness (#8777 waking-up banner)", () => {
  it("polls when status is null/early (readiness unknown)", () => {
    expect(shouldAwaitAgentReadiness(null)).toBe(true);
  });

  it("STOPS polling the instant canRespond flips true (banner clears)", () => {
    expect(
      shouldAwaitAgentReadiness(status({ state: "running", canRespond: true })),
    ).toBe(false);
  });

  it("keeps polling while a running agent reports canRespond:false", () => {
    expect(
      shouldAwaitAgentReadiness(
        status({ state: "running", canRespond: false }),
      ),
    ).toBe(true);
  });

  it("keeps polling a cloud agent with no local model and no canRespond yet", () => {
    // The exact bug: a cloud agent has no locally-detected model, so without
    // canRespond deriveAgentReady is false → keep polling for the broadcast.
    expect(shouldAwaitAgentReadiness(status({ state: "running" }))).toBe(true);
  });

  it("stops polling once a local model resolves (canRespond absent)", () => {
    expect(
      shouldAwaitAgentReadiness(status({ state: "running", model: "eliza-1" })),
    ).toBe(false);
  });

  it("does NOT poll in terminal states", () => {
    for (const state of ["error", "stopped", "not_started"] as const) {
      expect(shouldAwaitAgentReadiness(status({ state }))).toBe(false);
    }
  });
});

/**
 * The 1.5s readiness poll re-applies the status snapshot every tick while
 * "waking up…". `readinessPollSignature` is the equality guard that lets the
 * poll skip `setAgentStatus` — and the re-render of every chat-surface
 * subscriber — when nothing load-bearing (state / port / canRespond) changed.
 */
describe("readinessPollSignature (#9141 readiness-poll re-render guard)", () => {
  it("is stable across snapshots that differ only in non-load-bearing fields", () => {
    const a = status({
      state: "running",
      port: 31337,
      canRespond: false,
      uptime: 1_000,
      startedAt: 10,
      agentName: "eliza",
    });
    const b = status({
      state: "running",
      port: 31337,
      canRespond: false,
      uptime: 9_999,
      startedAt: 99,
      agentName: "eliza-renamed",
    });
    expect(readinessPollSignature(a)).toBe(readinessPollSignature(b));
  });

  it("changes when any load-bearing field (state/port/canRespond) changes", () => {
    const base = status({ state: "running", port: 31337, canRespond: false });
    const sig = readinessPollSignature(base);
    expect(
      readinessPollSignature(status({ ...base, state: "stopped" })),
    ).not.toBe(sig);
    expect(readinessPollSignature(status({ ...base, port: 4000 }))).not.toBe(
      sig,
    );
    expect(
      readinessPollSignature(status({ ...base, canRespond: true })),
    ).not.toBe(sig);
  });

  it("treats null (readiness unknown) as its own distinct signature", () => {
    expect(readinessPollSignature(null)).not.toBe(
      readinessPollSignature(status({ state: "running" })),
    );
  });

  /**
   * Mirrors the guarded poll body in useChatLifecycle: compare the incoming
   * snapshot's signature against the last-applied one held in a ref; only call
   * the setter when it changed. Asserts the setter is NOT called on an equal
   * snapshot, and IS called when a load-bearing field flips.
   */
  it("does NOT call setAgentStatus when getStatus returns an equal snapshot", () => {
    const setAgentStatus = vi.fn();
    const signatureRef: { current: string | null } = { current: null };

    const applyPolled = (next: AgentStatus) => {
      const signature = readinessPollSignature(next);
      if (signature === signatureRef.current) return;
      signatureRef.current = signature;
      setAgentStatus(next);
    };

    const ready = status({ state: "running", port: 31337, canRespond: false });
    // Seed (first observation applies).
    applyPolled(ready);
    // Three identical polls (only uptime drifts) must be skipped.
    applyPolled(status({ ...ready, uptime: 2_000 }));
    applyPolled(status({ ...ready, uptime: 3_000 }));
    applyPolled(status({ ...ready, uptime: 4_000 }));
    expect(setAgentStatus).toHaveBeenCalledTimes(1);

    // canRespond flips → the setter fires exactly once more.
    applyPolled(status({ ...ready, canRespond: true }));
    expect(setAgentStatus).toHaveBeenCalledTimes(2);
    expect(setAgentStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ canRespond: true }),
    );
  });
});
