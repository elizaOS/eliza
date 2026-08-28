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

// Controllable override for the gate factory: only the bootstrap-ordering
// test below swaps it in (via gateFactory.create) so the REAL production
// chain (beginMembershipGateBootstrap -> getMe -> factory -> replay) runs
// against a deferred fake gate instead of the fake runtime's absent
// authority service. Every other test stubs getMembershipGate directly and
// never reaches the factory.
const gateFactory = vi.hoisted(() => ({
  create: null as
    | null
    | ((input: { botTelegramUserId: string }) => Promise<unknown>),
}));
vi.mock("./membership-gate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./membership-gate")>();
  return {
    ...actual,
    createTelegramMembershipGate: (
      input: Parameters<typeof actual.createTelegramMembershipGate>[0],
    ) =>
      gateFactory.create
        ? gateFactory.create(input)
        : actual.createTelegramMembershipGate(input),
  };
});

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
    service as unknown as { settledMembershipGates: Map<string, unknown> }
  ).settledMembershipGates = new Map();
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

  it("does nothing without a membership gate (absent authority: legacy mode)", async () => {
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

  it("queues a transition that arrives while the gate is bootstrapping and replays it once resolved", async () => {
    // Startup window: the poller is live but finishBotStartup has not
    // resolved the gate yet. A kick arriving here must be queued and
    // replayed — discarding it would leave stale active authority
    // untombstoned (and a re-add would leave a persisted tombstone
    // denying the chat indefinitely).
    let resolveGate: (gate: GateFake | null) => void = () => {};
    const gatePromise = new Promise<GateFake | null>((resolve) => {
      resolveGate = resolve;
    });
    const { service } = makeService(null);
    const internals = service as unknown as {
      membershipGates: Map<string, Promise<GateFake | null>>;
      settledMembershipGates: Map<string, GateFake | null>;
      pendingMembershipTransitions: Map<string, unknown[]>;
      handleMyChatMemberUpdate: (
        update: unknown,
        accountId?: string,
      ) => Promise<void>;
    };
    internals.membershipGates.set("acct", gatePromise);
    // Object.assign harness: field initializers never ran, so provide the
    // queue registry the production class declares.
    internals.pendingMembershipTransitions = new Map();
    // Production getMembershipGate: settled registry first, else the promise.
    const settled = new Map<string, GateFake | null>();
    (
      service as unknown as {
        getMembershipGate: ReturnType<typeof vi.fn>;
      }
    ).getMembershipGate = vi.fn(async () => {
      if (settled.has("acct")) {
        return settled.get("acct") ?? null;
      }
      return gatePromise.then((gate) => {
        settled.set("acct", gate);
        return gate;
      });
    });
    internals.settledMembershipGates = settled as never;
    const dispatch = internals.handleMyChatMemberUpdate.bind(service);

    // Transition arrives while the gate promise is pending: queued, not dropped.
    await dispatch(botMemberUpdate("kicked"));

    // Once the gate resolves, the queued transition is replayed through the
    // normal dispatch path — the tombstone lands.
    resolveGate({
      authority: {
        markScopeUnavailable: vi.fn().mockResolvedValue(undefined),
        clearScopeRemoval: vi.fn().mockResolvedValue(undefined),
      },
      connectorAccountId: "connector-1",
      botTelegramUserId: "777",
    });
    await gatePromise;
    // Let the replay microtask chain drain.
    await new Promise((r) => setTimeout(r, 10));
    expect(
      settled.get("acct")?.authority.markScopeUnavailable,
    ).toHaveBeenCalledTimes(1);
  });

  it("installs the gate-bootstrap promise synchronously before the poller goes live (pre-getMe window)", async () => {
    // The residual startup-window hole: ensureWiredOnce launches the poller
    // BEFORE finishBotStartup's setMyCommands/getMe awaits resolve. A
    // my_chat_member transition delivered in that window must find a PENDING
    // gate promise to queue against — a missing promise reads as
    // absent-authority legacy mode and silently drops the transition.
    // beginMembershipGateBootstrap must therefore register the promise
    // synchronously (its own getMe feeds it), before any update can arrive.
    const { service } = makeService(null);
    let resolveGetMe: (info: { id: number; username?: string }) => void =
      () => {};
    const getMe = vi.fn(
      () =>
        new Promise<{ id: number; username?: string }>((resolve) => {
          resolveGetMe = resolve;
        }),
    );
    const internals = service as unknown as {
      membershipGates: Map<string, Promise<unknown>>;
      settledMembershipGates: Map<string, unknown>;
      pendingMembershipTransitions: Map<string, unknown[]>;
      handleMyChatMemberUpdate: (
        update: unknown,
        accountId?: string,
      ) => Promise<void>;
      beginMembershipGateBootstrap: (bot: unknown, accountId: string) => void;
    };
    internals.pendingMembershipTransitions = new Map();
    internals.beginMembershipGateBootstrap({ telegram: { getMe } }, "acct");

    // Synchronous pin: the promise exists BEFORE getMe has resolved.
    const gatePromise = internals.membershipGates.get("acct");
    expect(gatePromise).toBeDefined();
    expect(getMe).toHaveBeenCalledTimes(1);

    // A transition arriving while the bootstrap is still pending queues
    // (production dispatch path), instead of dropping on a missing promise.
    await internals.handleMyChatMemberUpdate(botMemberUpdate("kicked"), "acct");
    expect(internals.pendingMembershipTransitions.get("acct")?.length).toBe(1);

    // Resolve the bootstrap: getMe resolves, the factory returns the fake
    // gate, and the queued transition replays through the real dispatch
    // path — the tombstone lands. Re-stub getMembershipGate BEFORE the
    // resolution (the replay runs on the promise's microtask chain;
    // makeService's null stub would read as absent authority and skip it).
    const authority = {
      markScopeUnavailable: vi.fn().mockResolvedValue(undefined),
      clearScopeRemoval: vi.fn().mockResolvedValue(undefined),
    };
    const gate = {
      authority,
      connectorAccountId: "connector-1",
      botTelegramUserId: "777",
    };
    gateFactory.create = async () => gate;
    (
      service as unknown as { getMembershipGate: ReturnType<typeof vi.fn> }
    ).getMembershipGate = vi.fn().mockResolvedValue(gate);
    resolveGetMe({ id: 777, username: "test_bot" });
    await expect(gatePromise).resolves.toEqual(
      expect.objectContaining({ botTelegramUserId: "777" }),
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(authority.markScopeUnavailable).toHaveBeenCalledTimes(1);
    gateFactory.create = null;
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
