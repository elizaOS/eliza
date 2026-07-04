// @vitest-environment jsdom

/**
 * `useLifecycleState.setAgentStatusIfChanged` change detection: a
 * `canRespond`-only flip must apply rather than being deduped away. Real hook
 * under jsdom; no live agent.
 */
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AgentStatus } from "../api";
import { useLifecycleState } from "./useLifecycleState";

const RUNNING: AgentStatus = {
  state: "running",
  agentName: "Eliza",
  model: undefined,
  startedAt: 1000,
  uptime: undefined,
  canRespond: false,
};

describe("useLifecycleState.setAgentStatusIfChanged — canRespond change detection", () => {
  it("applies a canRespond-only flip (false→true) instead of deduping it away", () => {
    const { result } = renderHook(() => useLifecycleState());

    act(() => {
      result.current.setAgentStatusIfChanged(RUNNING);
    });
    expect(result.current.state.agentStatus?.canRespond).toBe(false);

    // Same state/agentName/model/startedAt — only canRespond flips. The agent
    // just finished warming and can now answer; this MUST update, or the
    // "waking up" banner sticks forever.
    act(() => {
      result.current.setAgentStatusIfChanged({ ...RUNNING, canRespond: true });
    });
    expect(result.current.state.agentStatus?.canRespond).toBe(true);
  });

  it("still dedupes when nothing material changed (no needless re-render churn)", () => {
    const { result } = renderHook(() => useLifecycleState());

    act(() => {
      result.current.setAgentStatusIfChanged({ ...RUNNING, canRespond: true });
    });
    const first = result.current.state.agentStatus;

    act(() => {
      // Identical snapshot (incl. canRespond) — should be deduped: same object ref.
      result.current.setAgentStatusIfChanged({ ...RUNNING, canRespond: true });
    });
    expect(result.current.state.agentStatus).toBe(first);
  });
});
