/**
 * Error-path coverage for relevantConversationsProvider (#12265): a recall
 * failure must surface through runtime.reportError (feeding RECENT_ERRORS /
 * owner escalation) while still degrading to empty context, never fabricating
 * relevant history. The throw is induced at the first recall call (getRoom),
 * before any embed, so the provider is real and only the runtime collaborator is
 * stubbed. Kept separate from relevant-conversations.test.ts so the fast-fail
 * assertions do not depend on the createMockRuntime harness.
 */

import type { IAgentRuntime, Memory, State, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { relevantConversationsProvider } from "./relevant-conversations.ts";

const ROOM_ID = "00000000-0000-0000-0000-0000000000c1" as UUID;
const EMPTY_STATE: State = { values: {}, data: {}, text: "" };

function message(): Memory {
  return {
    id: "00000000-0000-0000-0000-0000000000a1" as UUID,
    entityId: "00000000-0000-0000-0000-0000000000e0" as UUID,
    roomId: ROOM_ID,
    content: { text: "what did we decide about the launch date" },
    createdAt: 2,
  } as Memory;
}

describe("relevantConversationsProvider fast-fail (#12265)", () => {
  it("reports a recall failure and degrades to empty context, not fabricated history", async () => {
    const reportError = vi.fn();
    const runtime = {
      getRoom: async () => {
        throw new Error("room store unavailable");
      },
      reportError,
    } as unknown as IAgentRuntime;

    const result = await relevantConversationsProvider.get(
      runtime,
      message(),
      EMPTY_STATE,
    );

    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]?.[0]).toBe(
      "RelevantConversationsProvider",
    );
    expect(reportError.mock.calls[0]?.[1]).toBeInstanceOf(Error);
    // Degrade is an EMPTY context — never a fabricated relevant-history line.
    expect(result.text).toBe("");
    expect(result.text).not.toContain("Relevant past conversations:");
    expect(result.values).toEqual({});
  });

  it("short messages short-circuit before recall and do not report", async () => {
    const reportError = vi.fn();
    const runtime = {
      getRoom: async () => {
        throw new Error("should not be reached");
      },
      reportError,
    } as unknown as IAgentRuntime;

    const result = await relevantConversationsProvider.get(
      runtime,
      { ...message(), content: { text: "hi" } } as Memory,
      EMPTY_STATE,
    );

    // Legit short-circuit (too-short query) is not an error — must not report.
    expect(reportError).not.toHaveBeenCalled();
    expect(result).toEqual({ text: "", values: {}, data: {} });
  });
});
