/**
 * Error-path coverage for recentConversationsProvider (#12265): a recall failure
 * must surface through runtime.reportError (feeding RECENT_ERRORS / owner
 * escalation) while still degrading to empty context, never fabricating recent
 * history. The provider is real; only the runtime collaborator (getRoom) is
 * stubbed to throw a real error.
 */

import type { IAgentRuntime, Memory, State, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { recentConversationsProvider } from "./recent-conversations.ts";

const ROOM_ID = "00000000-0000-0000-0000-0000000000c1" as UUID;
const EMPTY_STATE: State = { values: {}, data: {}, text: "" };

function message(): Memory {
  return {
    id: "00000000-0000-0000-0000-0000000000a1" as UUID,
    entityId: "00000000-0000-0000-0000-0000000000e0" as UUID,
    roomId: ROOM_ID,
    content: { text: "hello there" },
    createdAt: 2,
  } as Memory;
}

describe("recentConversationsProvider fast-fail (#12265)", () => {
  it("reports a recall failure and degrades to empty context, not fabricated history", async () => {
    const reportError = vi.fn();
    const runtime = {
      getRoom: async () => {
        throw new Error("room store unavailable");
      },
      reportError,
    } as unknown as IAgentRuntime;

    const result = await recentConversationsProvider.get(
      runtime,
      message(),
      EMPTY_STATE,
    );

    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]?.[0]).toBe("RecentConversationsProvider");
    expect(reportError.mock.calls[0]?.[1]).toBeInstanceOf(Error);
    // Degrade is an EMPTY context — never a fabricated recent-history line.
    expect(result.text).toBe("");
    expect(result.text).not.toContain("Recent");
    expect(result.values).toEqual({});
    expect(result.data).toEqual({});
  });

  it("returns empty context without reporting when there is no entity id", async () => {
    const reportError = vi.fn();
    const runtime = { reportError } as unknown as IAgentRuntime;

    const result = await recentConversationsProvider.get(
      runtime,
      { ...message(), entityId: undefined } as unknown as Memory,
      EMPTY_STATE,
    );

    // Legit absence (no entity) is not an error — it must not report.
    expect(reportError).not.toHaveBeenCalled();
    expect(result).toEqual({ text: "", values: {}, data: {} });
  });
});
