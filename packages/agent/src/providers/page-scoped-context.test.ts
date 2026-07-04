// Error-path coverage for the page-scoped-context provider's fast-fail
// conversion (#12265): a failing live-state subsection (task read throwing) and
// a failing provider boundary must both surface through runtime.reportError
// (feeding RECENT_ERRORS / owner escalation) while still degrading gracefully —
// the provider omits the broken section / returns empty context rather than
// aborting the turn. No mocking of the thing under test; the collaborators
// (getRoom / getTasks) throw real errors.

import type { IAgentRuntime, Memory, State, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { pageScopedContextProvider } from "./page-scoped-context.ts";

const EMPTY_STATE: State = { values: {}, data: {}, text: "" };

const ROOM_ID = "00000000-0000-0000-0000-0000000000aa" as UUID;
const AGENT_ID = "00000000-0000-0000-0000-0000000000bb" as UUID;

function automationsRoom() {
  return { metadata: { webConversation: { scope: "page-automations" } } };
}

function message(): Memory {
  return {
    id: "00000000-0000-0000-0000-0000000000cc" as UUID,
    entityId: "00000000-0000-0000-0000-0000000000dd" as UUID,
    roomId: ROOM_ID,
    content: { text: "what can I automate?" },
  } as Memory;
}

describe("pageScopedContextProvider fast-fail (#12265)", () => {
  it("reports a failing task read and degrades to the brief-only section", async () => {
    const reportError = vi.fn();
    const runtime = {
      agentId: AGENT_ID,
      character: { name: "Test" },
      getRoom: async () => automationsRoom(),
      getTasks: async () => {
        throw new Error("task store unavailable");
      },
      reportError,
    } as unknown as IAgentRuntime;

    const result = await pageScopedContextProvider.get(
      runtime,
      message(),
      EMPTY_STATE,
    );

    // The subsection failure is surfaced, not swallowed.
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]?.[0]).toBe(
      "PageScopedContext.automationsLiveState",
    );
    expect(reportError.mock.calls[0]?.[1]).toBeInstanceOf(Error);
    // …but the provider still returns the page brief (graceful degrade), and
    // never fabricates a tasks line as if the read succeeded.
    expect(result.text).toContain("Automations view");
    expect(result.text).not.toContain("Live automations state:");
  });

  it("reports a provider-boundary failure and returns empty context", async () => {
    const reportError = vi.fn();
    const runtime = {
      agentId: AGENT_ID,
      character: { name: "Test" },
      getRoom: async () => {
        throw new Error("room lookup failed");
      },
      reportError,
    } as unknown as IAgentRuntime;

    const result = await pageScopedContextProvider.get(
      runtime,
      message(),
      EMPTY_STATE,
    );

    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]?.[0]).toBe("page-scoped-context");
    expect(reportError.mock.calls[0]?.[1]).toBeInstanceOf(Error);
    // Boundary degrade is an EMPTY context, never a fabricated one.
    expect(result.text).toBe("");
    expect(result.values).toEqual({});
    expect(result.data).toEqual({});
  });
});
