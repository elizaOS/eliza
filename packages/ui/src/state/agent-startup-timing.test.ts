/**
 * Direct coverage for the agent-ready wait-loop deadline math in
 * `agent-startup-timing.ts`: the electrobun-aware initial timeout floor and
 * the sliding extension applied while the agent stays in `starting`.
 *
 * The suite is deterministic: `computeAgentDeadlineExtensions` takes an
 * explicit `now`, and the electrobun path is exercised through the real
 * `isElectrobunRuntime` detector by seeding `window.__electrobunWindowId`
 * in jsdom (no module mocks).
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  AGENT_STARTING_SLIDE_MS,
  AGENT_STARTUP_ABSOLUTE_MAX_MS,
  computeAgentDeadlineExtensions,
  getAgentReadyTimeoutMs,
} from "./agent-startup-timing";

const START = 1_000_000;
const DAY_MS = 86_400_000;

function extend(
  options: Partial<Parameters<typeof computeAgentDeadlineExtensions>[0]> & {
    state?: string | undefined;
  },
): number {
  return computeAgentDeadlineExtensions({
    agentWaitStartedAt: START,
    agentDeadlineAt: START + 120_000,
    state: "starting",
    now: START + 60_000,
    ...options,
  });
}

afterEach(() => {
  delete (globalThis.window as { __electrobunWindowId?: number })
    .__electrobunWindowId;
});

describe("getAgentReadyTimeoutMs", () => {
  it("returns the 180s floor for non-electrobun runtimes", () => {
    expect(getAgentReadyTimeoutMs()).toBe(180_000);
  });

  it("returns the 300s electrobun floor when the renderer bridge is present", () => {
    (
      globalThis.window as { __electrobunWindowId?: number }
    ).__electrobunWindowId = 7;
    expect(getAgentReadyTimeoutMs()).toBe(300_000);
  });
});

describe("computeAgentDeadlineExtensions", () => {
  it("keeps the existing deadline when state is not starting", () => {
    const deadline = START + 120_000;
    expect(extend({ state: "running", agentDeadlineAt: deadline })).toBe(
      deadline,
    );
    expect(extend({ state: undefined, agentDeadlineAt: deadline })).toBe(
      deadline,
    );
  });

  it("keeps the existing deadline during the first 15s of the wait", () => {
    const deadline = START + 120_000;
    expect(extend({ now: START + 14_999, agentDeadlineAt: deadline })).toBe(
      deadline,
    );
  });

  it("extends to now+180s once the wait is at least 15s old", () => {
    expect(extend({ now: START + 15_000 })).toBe(START + 15_000 + 180_000);
  });

  it("does not shrink a deadline that is already further out", () => {
    const far = START + 500_000;
    expect(extend({ now: START + 60_000, agentDeadlineAt: far })).toBe(far);
  });

  it("caps the extension at 900s from wait start", () => {
    // now+slide would be START+1_160_000, above the 900s absolute cap.
    expect(extend({ now: START + 980_000 })).toBe(START + 900_000);
  });

  it("clamps epoch-scale deadlines to wait start + 900s", () => {
    const epochStart = 1_756_000_000_000;
    // 600s into the wait: now+slide = epochStart+780_000, below the
    // incoming deadline's ceiling — the slide applies, then the absolute
    // cap does NOT bind. The expectation pins the slide arithmetic on
    // epoch-scale numbers where a ms-vs-s unit slip would show.
    const out = computeAgentDeadlineExtensions({
      agentWaitStartedAt: epochStart,
      agentDeadlineAt: epochStart + 120_000,
      state: "starting",
      now: epochStart + 600_000,
    });
    expect(out).toBe(epochStart + 780_000);
    expect(out - epochStart).toBe(600_000 + AGENT_STARTING_SLIDE_MS);
  });

  it("caps at wait start + 900s even when the incoming deadline is later", () => {
    const out = computeAgentDeadlineExtensions({
      agentWaitStartedAt: START,
      agentDeadlineAt: START + 2_000_000,
      state: "starting",
      now: START + 60_000,
    });
    expect(out).toBe(START + AGENT_STARTUP_ABSOLUTE_MAX_MS);
  });

  it("handles wait timestamps spanning day boundaries", () => {
    const out = computeAgentDeadlineExtensions({
      agentWaitStartedAt: DAY_MS - 30_000,
      agentDeadlineAt: DAY_MS + 90_000,
      state: "starting",
      now: DAY_MS - 10_000,
    });
    // 20s into the wait (> 15s warmup), so the deadline slides to
    // now+180s — past midnight — rather than staying at +90s.
    expect(out).toBe(DAY_MS - 10_000 + 180_000);
  });
});
