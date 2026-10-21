import type { UUID } from "@elizaos/core";
import type { MessageReaction, User } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import {
  handleReaction,
  handleReactionAdd,
  handleReactionRemove,
  type ReactionServiceInternals,
} from "../discord-reactions.ts";

describe("Discord bot reaction filtering and quote formatting (issue #37031)", () => {
  const agentId = "00000000-0000-0000-0000-0000000000a1" as UUID;
  const humanUserId = "123456789012345678";
  const botUserId = "987654321098765432";

  function createMockService() {
    const ensureConnection = vi.fn().mockResolvedValue(undefined);
    const emitEvent = vi.fn();
    const logger = {
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
    };

    const runtime = {
      agentId,
      ensureConnection,
      emitEvent,
      logger,
    };

    const service: ReactionServiceInternals = {
      accountId: "default",
      runtime: runtime as unknown as ReactionServiceInternals["runtime"],
      resolveDiscordEntityId: (id: string) => `00000000-0000-0000-0000-${id.slice(0, 12)}` as UUID,
      getChannelType: vi.fn().mockResolvedValue("GROUP"),
    };

    return { service, runtime, ensureConnection, emitEvent };
  }

  function createMockReaction(messageContent = "ship it", emojiName = "⏳") {
    return {
      partial: false,
      emoji: {
        name: emojiName,
      },
      message: {
        id: "msg-123",
        content: messageContent,
        channel: {
          id: "channel-456",
          name: "general",
        },
        guild: {
          id: "guild-789",
          name: "Test Guild",
        },
        author: {
          username: "author_user",
        },
      },
    } as unknown as MessageReaction;
  }

  it("does not store or emit reactions from bots", async () => {
    const { service, ensureConnection, emitEvent } = createMockService();
    const reaction = createMockReaction();
    const botUser = {
      id: botUserId,
      username: "status_bot",
      bot: true,
      partial: false,
    } as unknown as User;

    await handleReactionAdd(service, reaction, botUser);

    expect(ensureConnection).not.toHaveBeenCalled();
    expect(emitEvent).not.toHaveBeenCalled();
  });

  it("fetches partial users and drops reactions if resolved user is a bot", async () => {
    const { service, ensureConnection, emitEvent } = createMockService();
    const reaction = createMockReaction();
    const partialBotUser = {
      id: botUserId,
      partial: true,
      fetch: vi.fn().mockResolvedValue({
        id: botUserId,
        username: "status_bot",
        bot: true,
        partial: false,
      }),
    } as unknown as User;

    await handleReactionAdd(service, reaction, partialBotUser);

    expect(partialBotUser.fetch).toHaveBeenCalled();
    expect(ensureConnection).not.toHaveBeenCalled();
    expect(emitEvent).not.toHaveBeenCalled();
  });

  it("does not store or emit reaction removals from bots", async () => {
    const { service, ensureConnection, emitEvent } = createMockService();
    const reaction = createMockReaction();
    const botUser = {
      id: botUserId,
      username: "status_bot",
      bot: true,
      partial: false,
    } as unknown as User;

    await handleReactionRemove(service, reaction, botUser);

    expect(ensureConnection).not.toHaveBeenCalled();
    expect(emitEvent).not.toHaveBeenCalled();
  });

  it("stores human user reactions with plain quotes and no backslashes", async () => {
    const { service, ensureConnection, emitEvent } = createMockService();
    const reaction = createMockReaction("ship it", "⏳");
    const humanUser = {
      id: humanUserId,
      username: "alice",
      globalName: "Alice",
      bot: false,
      partial: false,
    } as unknown as User;

    await handleReactionAdd(service, reaction, humanUser);

    expect(ensureConnection).toHaveBeenCalled();
    expect(emitEvent).toHaveBeenCalled();

    const [events, payload] = emitEvent.mock.calls[0];
    expect(events).toContain("DISCORD_REACTION_RECEIVED");
    expect(payload.message.content.text).toBe('*Added <⏳> to: "ship it"*');
    expect(payload.message.content.text).not.toContain('\\"');
  });

  it("formats human user reaction removals with plain quotes", async () => {
    const { service, ensureConnection, emitEvent } = createMockService();
    const reaction = createMockReaction("ship it", "⏳");
    const humanUser = {
      id: humanUserId,
      username: "alice",
      globalName: "Alice",
      bot: false,
      partial: false,
    } as unknown as User;

    await handleReactionRemove(service, reaction, humanUser);

    expect(ensureConnection).toHaveBeenCalled();
    expect(emitEvent).toHaveBeenCalled();

    const [events, payload] = emitEvent.mock.calls[0];
    expect(events).toContain("DISCORD_REACTION_REMOVED");
    expect(payload.message.content.text).toBe('*Removed <⏳> from: "ship it"*');
    expect(payload.message.content.text).not.toContain('\\"');
  });

  it("drops reactions when partial user fetch fails (fail-closed for uncached bots)", async () => {
    const { service, ensureConnection, emitEvent } = createMockService();
    const reaction = createMockReaction();
    const partialUserWithFailedFetch = {
      id: botUserId,
      partial: true,
      fetch: vi.fn().mockRejectedValue(new Error("Discord API rate limit")),
    } as unknown as User;

    await handleReactionAdd(service, reaction, partialUserWithFailedFetch);

    expect(partialUserWithFailedFetch.fetch).toHaveBeenCalled();
    expect(ensureConnection).not.toHaveBeenCalled();
    expect(emitEvent).not.toHaveBeenCalled();
  });
});
