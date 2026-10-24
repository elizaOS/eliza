/**
 * A Telegram reaction is durable before the REACTION_RECEIVED observers run.
 * A listener that rejects must not become an unhandled rejection, and the
 * failure must not be reported as a successful reaction either.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { expect, it, vi } from "vitest";
import { MessageManager } from "../src/messageManager";

it("reports a rejecting reaction event listener", async () => {
  const runtime = {
    agentId: "00000000-0000-0000-0000-0000000000a2",
    emitEvent: vi.fn(() => Promise.reject(new Error("listener boom"))),
    reportError: vi.fn(),
  } as unknown as IAgentRuntime;
  const manager = new MessageManager({} as never, runtime, "account-1");
  const chat = { id: -100123, type: "group" };
  const ctx = {
    from: { id: 4242, first_name: "Sam", username: "sam", is_bot: false },
    chat,
    update: {
      message_reaction: {
        chat,
        message_id: 77,
        new_reaction: [{ type: "emoji", emoji: "👍" }],
      },
    },
  };

  await manager.handleReaction(ctx as never);

  expect(runtime.emitEvent).toHaveBeenCalledTimes(2);
  expect(
    vi.mocked(runtime.reportError).mock.calls.map(([scope]) => scope),
  ).toEqual(["MessageManager.emitReaction", "MessageManager.emitReaction"]);
});
