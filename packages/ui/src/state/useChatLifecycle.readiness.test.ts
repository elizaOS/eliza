import type { AgentStatus } from "../api";
import { describe, expect, it } from "vitest";
import { shouldAwaitAgentReadiness } from "./types";

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
      shouldAwaitAgentReadiness(status({ state: "running", canRespond: false })),
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
