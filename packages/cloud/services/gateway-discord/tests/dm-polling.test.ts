/** Verifies deterministic Discord user-install DM polling and deduplication. */

import { describe, expect, it, mock } from "bun:test";
import {
  pollTrackedDiscordDms,
  type TrackedDiscordDm,
} from "../src/dm-polling";

const tracked: TrackedDiscordDm = {
  channelId: "channel-1",
  userId: "user-1",
  lastMessageId: "100",
};

describe("pollTrackedDiscordDms", () => {
  it("routes human messages oldest-first and advances over bot messages", async () => {
    const routed: string[] = [];
    const cursors: string[] = [];
    const report = await pollTrackedDiscordDms({
      listTracked: async () => [{ ...tracked }],
      fetchAfter: async () => [
        { id: "103", author: { bot: false }, content: "third" },
        { id: "101", author: { bot: false }, content: "first" },
        { id: "102", author: { bot: true }, content: "bot reply" },
      ],
      claimMessage: async () => true,
      routeMessage: async (message) => routed.push(message.id),
      updateCursor: async (_state, id) => cursors.push(id),
      removeTracked: async () => {},
      isTerminalChannelError: () => false,
    });

    expect(routed).toEqual(["101", "103"]);
    expect(cursors).toEqual(["101", "102", "103"]);
    expect(report).toEqual({
      channels: 1,
      messages: 3,
      routed: 2,
      deduplicated: 0,
      removed: 0,
    });
  });

  it("does not reroute a message already claimed by the Gateway path", async () => {
    const routeMessage = mock(async () => {});
    const report = await pollTrackedDiscordDms({
      listTracked: async () => [{ ...tracked }],
      fetchAfter: async () => [
        { id: "101", author: { bot: false }, content: "hello" },
      ],
      claimMessage: async () => false,
      routeMessage,
      updateCursor: async () => {},
      removeTracked: async () => {},
      isTerminalChannelError: () => false,
    });

    expect(routeMessage).not.toHaveBeenCalled();
    expect(report.deduplicated).toBe(1);
  });

  it("removes only definitively unavailable channels", async () => {
    const removeTracked = mock(async () => {});
    const onError = mock(() => {});
    const report = await pollTrackedDiscordDms({
      listTracked: async () => [{ ...tracked }],
      fetchAfter: async () => {
        throw Object.assign(new Error("Unknown Channel"), { code: 10003 });
      },
      claimMessage: async () => true,
      routeMessage: async () => {},
      updateCursor: async () => {},
      removeTracked,
      isTerminalChannelError: (error) =>
        (error as { code?: number }).code === 10003,
      onError,
    });

    expect(removeTracked).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    expect(report.removed).toBe(1);
  });
});
