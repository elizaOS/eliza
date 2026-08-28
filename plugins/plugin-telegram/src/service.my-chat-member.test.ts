/**
 * Unit coverage for the `my_chat_member` delivery path: the poller's
 * allowedUpdates wiring, the update handler registration, and the
 * bot-removal tombstone / re-add clear dispatch. While polling, a kicked bot
 * stops receiving the chat's messages entirely, so Telegram's
 * `my_chat_member` update is the ONLY signal that reaches the runtime for the
 * bot's own status transitions — without it the authority's tombstone paths
 * (membership.ts removedScopes / scopeReaddWatermarks) are unreachable.
 * Deterministic unit harness: runtime and gate are fakes; the real dispatch
 * method runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TelegramService } from "./service";

interface GateFake {
  authority: {
    markScopeUnavailable: ReturnType<typeof vi.fn>;
    clearScopeRemoval: ReturnType<typeof vi.fn>;
  };
  connectorAccountId: string;
  botTelegramUserId: string;
}

function makeMembershipChatRoomKey(
  service: TelegramService,
): (chatId: string) => string {
  return (chatId: string) =>
    (
      service as unknown as {
        membershipChatRoomKey: (chatId: string, accountId: string) => string;
      }
    ).membershipChatRoomKey(chatId, "acct");
}

function makeService(gate: GateFake | null) {
  const runtime = {
    agentId: "agent-test",
    reportError: vi.fn(),
  };
  const service = Object.assign(
    Object.create(TelegramService.prototype) as TelegramService,
    {
      runtime,
      defaultAccountId: "acct",
    },
  );
  const getMembershipGate = vi.fn().mockResolvedValue(gate);
  const accountState = {
    messageManager: { markMembershipGateBroken: vi.fn() },
  };
  (
    service as unknown as {
      getMembershipGate: typeof getMembershipGate;
      getAccountState: () => typeof accountState;
      membershipGateFailures: Set<string>;
      membershipGates: Map<string, unknown>;
      messageManager: { markMembershipGateBroken: ReturnType<typeof vi.fn> };
    }
  ).getMembershipGate = getMembershipGate;
  (
    service as unknown as { getAccountState: () => typeof accountState }
  ).getAccountState = () => accountState;
  (
    service as unknown as { membershipGateFailures: Set<string> }
  ).membershipGateFailures = new Set();
  (
    service as unknown as { membershipGates: Map<string, unknown> }
  ).membershipGates = new Map();
  (
    service as unknown as {
      messageManager: { markMembershipGateBroken: ReturnType<typeof vi.fn> };
    }
  ).messageManager = accountState.messageManager;
  return { service, runtime, getMembershipGate, accountState };
}

function botMemberUpdate(
  newStatus: string,
  botId = 777,
  chatId = -100999,
): {
  chat: { id: number; type: string };
  from: { id: number; is_bot: boolean; first_name: string };
  date: number;
  old_chat_member: { status: string; user: { id: number; is_bot: boolean } };
  new_chat_member: { status: string; user: { id: number; is_bot: boolean } };
} {
  return {
    chat: { id: chatId, type: "supergroup" },
    from: { id: 42, is_bot: false, first_name: "Admin" },
    date: 1_758_000_000,
    old_chat_member: {
      status: "member",
      user: { id: botId, is_bot: true },
    },
    new_chat_member: {
      status: newStatus,
      user: { id: botId, is_bot: true },
    },
  };
}

describe("my_chat_member delivery contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("tombstones the scope when the bot is kicked", async () => {
    const gate: GateFake = {
      authority: {
        markScopeUnavailable: vi.fn().mockResolvedValue(undefined),
        clearScopeRemoval: vi.fn(),
      },
      connectorAccountId: "ca-1",
      botTelegramUserId: "777",
    };
    const { service } = makeService(gate);
    const roomKey = makeMembershipChatRoomKey(service);
    const dispatch = (
      service as unknown as {
        handleMyChatMemberUpdate: (
          update: unknown,
          accountId?: string,
        ) => Promise<void>;
      }
    ).handleMyChatMemberUpdate.bind(service);

    await dispatch(botMemberUpdate("kicked"));

    expect(gate.authority.markScopeUnavailable).toHaveBeenCalledTimes(1);
    expect(gate.authority.markScopeUnavailable).toHaveBeenCalledWith({
      chatId: "-100999",
      chatRoomKey: roomKey("-100999"),
      reason: "bot_removed",
    });
    expect(gate.authority.clearScopeRemoval).not.toHaveBeenCalled();
  });

  it("clears the tombstone when the bot is re-added as a member", async () => {
    const gate: GateFake = {
      authority: {
        markScopeUnavailable: vi.fn().mockResolvedValue(undefined),
        clearScopeRemoval: vi.fn(),
      },
      connectorAccountId: "ca-1",
      botTelegramUserId: "777",
    };
    const { service } = makeService(gate);
    const roomKey = makeMembershipChatRoomKey(service);
    const dispatch = (
      service as unknown as {
        handleMyChatMemberUpdate: (
          update: unknown,
          accountId?: string,
        ) => Promise<void>;
      }
    ).handleMyChatMemberUpdate.bind(service);

    const update = botMemberUpdate("member");
    update.old_chat_member = {
      status: "kicked",
      user: { id: 777, is_bot: true },
    };
    await dispatch(update);

    expect(gate.authority.clearScopeRemoval).toHaveBeenCalledTimes(1);
    expect(gate.authority.clearScopeRemoval).toHaveBeenCalledWith({
      chatId: "-100999",
      chatRoomKey: roomKey("-100999"),
    });
    expect(gate.authority.markScopeUnavailable).not.toHaveBeenCalled();
  });

  it("ignores a present->present update (e.g. admin-rights edit, no re-add)", async () => {
    const gate: GateFake = {
      authority: {
        markScopeUnavailable: vi.fn().mockResolvedValue(undefined),
        clearScopeRemoval: vi.fn(),
      },
      connectorAccountId: "ca-1",
      botTelegramUserId: "777",
    };
    const { service } = makeService(gate);
    const dispatch = (
      service as unknown as {
        handleMyChatMemberUpdate: (
          update: unknown,
          accountId?: string,
        ) => Promise<void>;
      }
    ).handleMyChatMemberUpdate.bind(service);

    const update = botMemberUpdate("administrator");
    update.old_chat_member = {
      status: "member",
      user: { id: 777, is_bot: true },
    };
    await dispatch(update);

    // Not a re-add transition: neither tombstone nor clear may fire, or
    // in-flight valid evidence would be spuriously invalidated.
    expect(gate.authority.clearScopeRemoval).not.toHaveBeenCalled();
    expect(gate.authority.markScopeUnavailable).not.toHaveBeenCalled();
  });

  it("treats a restricted bot with is_member false as removed (fail closed)", async () => {
    const gate: GateFake = {
      authority: {
        markScopeUnavailable: vi.fn().mockResolvedValue(undefined),
        clearScopeRemoval: vi.fn(),
      },
      connectorAccountId: "ca-1",
      botTelegramUserId: "777",
    };
    const { service } = makeService(gate);
    const dispatch = (
      service as unknown as {
        handleMyChatMemberUpdate: (
          update: unknown,
          accountId?: string,
        ) => Promise<void>;
      }
    ).handleMyChatMemberUpdate.bind(service);

    const update = botMemberUpdate("restricted");
    (update.new_chat_member as { is_member?: boolean }).is_member = false;
    await dispatch(update);

    expect(gate.authority.markScopeUnavailable).toHaveBeenCalledTimes(1);
    expect(gate.authority.clearScopeRemoval).not.toHaveBeenCalled();
  });

  it("ignores updates for a member other than the bot itself", async () => {
    const gate: GateFake = {
      authority: {
        markScopeUnavailable: vi.fn().mockResolvedValue(undefined),
        clearScopeRemoval: vi.fn(),
      },
      connectorAccountId: "ca-1",
      botTelegramUserId: "777",
    };
    const { service } = makeService(gate);
    const dispatch = (
      service as unknown as {
        handleMyChatMemberUpdate: (
          update: unknown,
          accountId?: string,
        ) => Promise<void>;
      }
    ).handleMyChatMemberUpdate.bind(service);

    await dispatch(botMemberUpdate("kicked", 12345));

    expect(gate.authority.markScopeUnavailable).not.toHaveBeenCalled();
    expect(gate.authority.clearScopeRemoval).not.toHaveBeenCalled();
  });

  it("breaks the admission gate when the tombstone write itself fails", async () => {
    const gate: GateFake = {
      authority: {
        markScopeUnavailable: vi.fn().mockRejectedValue(new Error("db down")),
        clearScopeRemoval: vi.fn(),
      },
      connectorAccountId: "ca-1",
      botTelegramUserId: "777",
    };
    const { service, runtime, accountState } = makeService(gate);
    const dispatch = (
      service as unknown as {
        handleMyChatMemberUpdate: (
          update: unknown,
          accountId?: string,
        ) => Promise<void>;
      }
    ).handleMyChatMemberUpdate.bind(service);

    await dispatch(botMemberUpdate("kicked"));

    // Fail closed: the degrade write failed, so the admission gate must be
    // marked broken and the failure reported rather than swallowed.
    expect(
      accountState.messageManager.markMembershipGateBroken,
    ).toHaveBeenCalledTimes(1);
    expect(runtime.reportError).toHaveBeenCalledTimes(1);
    const reported = (
      runtime.reportError as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls[0];
    expect(reported[0]).toBe("telegram:membership-scope-health");
    expect(reported[2]).toMatchObject({
      chatId: "-100999",
      reason: "bot_removed",
      source: "my_chat_member",
      degraded: "gate-broken",
    });
  });

  it("degrades fail-closed when gate acquisition itself rejects", async () => {
    // Production getMembershipGate cannot reject (it catches and resolves
    // null), but this pins the fail-closed property the whole-body try
    // provides: ANY pre-tombstone failure must break the admission gate
    // rather than leak to the bot.on catch that only logs.
    const { service, runtime, accountState } = makeService(null);
    (
      service as unknown as { getMembershipGate: ReturnType<typeof vi.fn> }
    ).getMembershipGate = vi.fn().mockRejectedValue(new Error("gate blew up"));
    const dispatch = (
      service as unknown as {
        handleMyChatMemberUpdate: (
          update: unknown,
          accountId?: string,
        ) => Promise<void>;
      }
    ).handleMyChatMemberUpdate.bind(service);

    await dispatch(botMemberUpdate("kicked"));

    expect(
      accountState.messageManager.markMembershipGateBroken,
    ).toHaveBeenCalledTimes(1);
    expect(runtime.reportError).toHaveBeenCalledTimes(1);
    const reported = (
      runtime.reportError as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls[0];
    expect(reported[0]).toBe("telegram:membership-scope-health");
    expect(reported[2]).toMatchObject({
      chatId: "-100999",
      reason: "bot_removed",
      source: "my_chat_member",
      degraded: "gate-broken",
    });
  });

  it("does nothing without a membership gate", async () => {
    const { service, getMembershipGate } = makeService(null);
    const dispatch = (
      service as unknown as {
        handleMyChatMemberUpdate: (
          update: unknown,
          accountId?: string,
        ) => Promise<void>;
      }
    ).handleMyChatMemberUpdate.bind(service);

    await dispatch(botMemberUpdate("kicked"));

    expect(getMembershipGate).toHaveBeenCalledTimes(1);
  });

  it("registers a my_chat_member handler during message-handler setup", async () => {
    const { service } = makeService(null);
    const registered: Array<{
      event: string;
      handler: (ctx: unknown) => Promise<void>;
    }> = [];
    const bot = {
      on: vi.fn((event: string, handler: (ctx: unknown) => Promise<void>) => {
        registered.push({ event, handler });
      }),
    };
    (
      service as unknown as { setupMessageHandlers: (state?: unknown) => void }
    ).setupMessageHandlers({
      bot,
      messageManager: undefined,
      accountId: "acct",
      account: { botToken: "tok" },
    });

    const entry = registered.find((r) => r.event === "my_chat_member");
    expect(entry).toBeDefined();

    // Dispatching a kicked-bot update through the registered handler reaches
    // the tombstone path (the handler catches and logs rather than throwing).
    const gate: GateFake = {
      authority: {
        markScopeUnavailable: vi.fn().mockResolvedValue(undefined),
        clearScopeRemoval: vi.fn(),
      },
      connectorAccountId: "ca-1",
      botTelegramUserId: "777",
    };
    (
      service as unknown as { getMembershipGate: ReturnType<typeof vi.fn> }
    ).getMembershipGate = vi.fn().mockResolvedValue(gate);
    entry?.handler({ update: { my_chat_member: botMemberUpdate("kicked") } });
    await vi.waitFor(() =>
      expect(gate.authority.markScopeUnavailable).toHaveBeenCalledTimes(1),
    );
  });
});
