/**
 * Unit tests for the per-view live-state renderers. Uses a hand-built fake
 * runtime (no live model, no DB) to prove the doctrine invariants: an EMPTY
 * documents store renders a designed empty-state line (never a fabricated "0"
 * masquerading as loaded data), and an UNREACHABLE store renders an explicit
 * "unavailable" line and reports the failure.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  renderLiveStateForScope,
  renderViewLiveStateForJudge,
} from "./page-scoped-live-state.ts";

function fakeRuntime(
  overrides: Partial<IAgentRuntime> & {
    getMemories?: IAgentRuntime["getMemories"];
  } = {},
): IAgentRuntime {
  return {
    agentId: "agent-1",
    reportError: vi.fn(),
    getMemories: vi.fn(async () => []),
    ...overrides,
  } as unknown as IAgentRuntime;
}

describe("renderLiveStateForScope — knowledge/transcripts empty-state (#13587)", () => {
  it("renders a designed empty knowledge brief, not a fabricated zero", async () => {
    const rt = fakeRuntime();
    const text = await renderLiveStateForScope(rt, "page-knowledge");
    expect(text).toContain("Live knowledge state");
    // 0 counts are legitimately empty here (getMemories returned []), so the
    // count text is allowed — what is banned is a "0" that stands in for a
    // FAILED fetch. Assert the designed empty phrasing is present.
    expect(text).toContain("0 ingested chat attachments");
    expect(rt.reportError).not.toHaveBeenCalled();
  });

  it("renders the empty transcript brief when no transcripts exist", async () => {
    const rt = fakeRuntime();
    const text = await renderLiveStateForScope(rt, "page-transcripts");
    expect(text).toBe(
      "Live transcript state (last 7 days): no recorded transcripts yet.",
    );
    expect(rt.reportError).not.toHaveBeenCalled();
  });

  it("counts recent transcript documents scoped to the agent", async () => {
    const now = Date.now();
    const rt = fakeRuntime({
      getMemories: vi.fn(async () => [
        {
          agentId: "agent-1",
          createdAt: now,
          metadata: { tags: ["transcript"], addedAt: now },
        },
        {
          agentId: "agent-1",
          createdAt: now,
          metadata: { tags: ["transcript"], addedAt: now },
        },
        // another agent's row must not be counted
        {
          agentId: "agent-2",
          createdAt: now,
          metadata: { tags: ["transcript"], addedAt: now },
        },
      ]),
    } as never);
    const text = await renderLiveStateForScope(rt, "page-transcripts");
    expect(text).toContain("2 recorded transcripts");
  });

  it("renders an explicit unavailable line and reports when the store throws", async () => {
    const rt = fakeRuntime({
      getMemories: vi.fn(async () => {
        throw new Error("store down");
      }),
    } as never);
    const text = await renderLiveStateForScope(rt, "page-transcripts");
    expect(text).toContain("unavailable");
    expect(rt.reportError).toHaveBeenCalled();
  });
});

describe("renderViewLiveStateForJudge — viewId → scope mapping", () => {
  it("maps documents view to knowledge live state", async () => {
    const rt = fakeRuntime();
    const text = await renderViewLiveStateForJudge(rt, "documents");
    expect(text).toContain("Live knowledge state");
  });

  it("maps transcripts view to transcript live state", async () => {
    const rt = fakeRuntime();
    const text = await renderViewLiveStateForJudge(rt, "transcripts");
    expect(text).toContain("Live transcript state");
  });

  it("returns null for a view with no live-state surface", async () => {
    const rt = fakeRuntime();
    expect(await renderViewLiveStateForJudge(rt, "database")).toBeNull();
    expect(await renderViewLiveStateForJudge(rt, "settings")).toBeNull();
  });
});
