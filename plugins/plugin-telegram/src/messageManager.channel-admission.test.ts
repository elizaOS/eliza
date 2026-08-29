/**
 * Admission-surface boundary tests for MessageManager.handleMessage: the
 * membership gate must run ONLY for raw Telegram `group`/`supergroup` chats —
 * the same predicate as TelegramService.chatAndEntityMiddleware and the
 * standalone handler. `channel` chats collapse to ChannelType.GROUP through
 * getChannelType and must NOT consult or register a membership scope: the
 * connector contract (membership.ts) gives channels no inbound admission
 * surface. Deterministic unit harness: the REAL handleMessage admission path
 * and the REAL TelegramMembershipMessageGate run over a fake runtime with a
 * fail-closed stubbed authority; no network, no database.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { MessageManager } from "./messageManager";

const CHAT_ID = -1002147483647;

function makeRuntime(): IAgentRuntime & {
  createMemory: ReturnType<typeof vi.fn>;
  setCache: ReturnType<typeof vi.fn>;
} {
  return {
    agentId: "00000000-0000-0000-0000-0000000000a1",
    getSetting: () => undefined,
    getCache: vi.fn(async () => undefined),
    setCache: vi.fn(async () => undefined),
    createMemory: vi.fn(async () => undefined),
    ensureConnection: vi.fn(async () => undefined),
    reportError: vi.fn(),
  } as unknown as IAgentRuntime & {
    createMemory: ReturnType<typeof vi.fn>;
    setCache: ReturnType<typeof vi.fn>;
  };
}

function makeManager(): {
  manager: MessageManager;
  runtime: ReturnType<typeof makeRuntime>;
} {
  const bot = {
    telegram: {
      getChatMember: vi.fn(async () => ({
        status: "left",
        user: { id: 424242 },
      })),
      sendMessage: vi.fn(async () => undefined),
    },
  };
  const runtime = makeRuntime();
  const manager = new MessageManager(bot as never, runtime as never, "default");
  return { manager, runtime };
}

/**
 * A gate whose authority denies EVERY authorization (fail-closed stub): if the
 * channel-post path consults the authority, authorize() fires and admission
 * is denied — the tripwire for the regression.
 */
function bindDenyAllGate(manager: MessageManager): ReturnType<typeof vi.fn> {
  const authorize = vi.fn(async () => ({
    decision: "denied" as const,
    reason: "authority_expired" as const,
  }));
  const reconcile = vi.fn(async () => ({
    state: "revoked" as const,
    reason: "kicked" as const,
  }));
  manager.bindMembershipGate({
    authority: {
      authorize,
      reconcile,
    } as never,
    botTelegramUserId: "777777",
  });
  return authorize;
}

function makeCtx(chatType: "channel" | "group" | "supergroup") {
  return {
    from: { id: 424242, is_bot: false, first_name: "Channel", username: "c" },
    chat: { id: CHAT_ID, type: chatType, title: "Announcements" },
    message: {
      message_id: 101,
      date: 1_774_000_000,
      text: "broadcast post body",
      chat: { id: CHAT_ID, type: chatType, title: "broadcasts" },
    },
    telegram: {
      getChatMember: async () => ({ status: "left", user: { id: 424242 } }),
    },
  } as never;
}

describe("MessageManager admission gate scopes to group/supergroup chats", () => {
  it("does not consult the membership authority for a channel post", async () => {
    const { manager, runtime } = makeManager();
    const authorize = bindDenyAllGate(manager);

    await manager.handleMessage(makeCtx("channel"));

    expect(authorize).not.toHaveBeenCalled();
    // The channel post is still ingested: it must not be dropped by the gate.
    expect(runtime.createMemory).toHaveBeenCalledTimes(1);
    const memory = runtime.createMemory.mock.calls[0][0] as {
      content: { channelType: string };
      metadata: { chatType: string };
    };
    expect(memory.content.channelType).toBe("GROUP");
    expect(memory.metadata.chatType).toBe("channel");
  });

  it("consults the membership authority for a group message and denies when evidence is stale", async () => {
    const { manager, runtime } = makeManager();
    const authorize = bindDenyAllGate(manager);

    await manager.handleMessage(makeCtx("group"));

    expect(authorize).toHaveBeenCalledTimes(1);
    // Denied admission must not persist the message (fail-closed).
    expect(runtime.createMemory).not.toHaveBeenCalled();
  });

  it("consults the membership authority for a supergroup message and denies when evidence is stale", async () => {
    const { manager, runtime } = makeManager();
    const authorize = bindDenyAllGate(manager);

    await manager.handleMessage(makeCtx("supergroup"));

    expect(authorize).toHaveBeenCalledTimes(1);
    expect(runtime.createMemory).not.toHaveBeenCalled();
  });

  it("admits an allowed group sender and persists the memory", async () => {
    const { manager, runtime } = makeManager();
    const authorize = vi.fn(async () => ({
      decision: "allowed" as const,
    }));
    manager.bindMembershipGate({
      authority: { authorize, reconcile: vi.fn() } as never,
      botTelegramUserId: "777777",
    });

    await manager.handleMessage(makeCtx("group"));

    expect(authorize).toHaveBeenCalledTimes(1);
    expect(runtime.createMemory).toHaveBeenCalledTimes(1);
  });
});
