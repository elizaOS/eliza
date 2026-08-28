/**
 * Boundary regressions for the review findings on #28715: (1) membership
 * admission runs at the TOP of chatAndEntityMiddleware — ahead of any
 * ensureConnection participant mutation; (2) a leave revocation removes the
 * departed principal's room participation; (3) the pending admission state
 * fails closed during the poller-before-gate startup window. Deterministic
 * unit harness: the real middleware and gate run over fake runtimes; no
 * network, no database.
 */
import type { IAgentRuntime, UUID } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TelegramMembershipMessageGate } from "./membership-gate";
import { TelegramService } from "./service";

function makeRuntime(): IAgentRuntime {
  return {
    agentId: "00000000-0000-0000-0000-0000000000a1",
    reportError: vi.fn(),
    getSetting: () => undefined,
    getEntityById: vi.fn(async () => null),
    updateEntity: vi.fn(async () => undefined),
    createEntity: vi.fn(async () => true),
    removeParticipant: vi.fn(async () => true),
    ensureConnection: vi.fn(async () => undefined),
    getWorld: vi.fn(async () => null),
    getRoom: vi.fn(async () => null),
    createWorld: vi.fn(async () => true),
    createRoom: vi.fn(async () => true),
    emitEvent: vi.fn(),
    getRoomsForParticipant: vi.fn(async () => [] as UUID[]),
  } as unknown as IAgentRuntime;
}

function middlewareService(options?: {
  authorize?: (telegramUserId: string) => boolean;
}) {
  const runtime = makeRuntime();
  const authorize = vi.fn(async (input: { telegramUserId: string }) =>
    options?.authorize?.(input.telegramUserId)
      ? { decision: "allowed" as const }
      : { decision: "denied" as const, reason: "membership_revoked" },
  );
  const gate = new TelegramMembershipMessageGate({
    runtime,
    // Real gate; the authority double only records authorize calls.
    authority: { authorize } as never,
    botTelegramUserId: "900001",
  });
  const manager = { telegramMembershipGate: gate };
  const service = Object.assign(
    Object.create(TelegramService.prototype) as TelegramService,
    {
      runtime,
      defaultAccountId: "default",
      // The chat is already known so admitted updates take the
      // existing-chat preprocessing path (no world bootstrap needed).
      knownChats: new Map<string, unknown>([["-100123", {}]]),
      syncedEntityIds: new Set<UUID>(),
      messageManager: manager,
    },
  );
  (service as unknown as { getAccountState: () => unknown }).getAccountState =
    () => ({ messageManager: manager });
  const chatAndEntityMiddleware = (
    service as unknown as {
      chatAndEntityMiddleware: (
        ctx: unknown,
        next: () => Promise<void>,
        accountId?: string,
      ) => Promise<void>;
    }
  ).chatAndEntityMiddleware.bind(service);
  return { service, runtime, gate, authorize, chatAndEntityMiddleware };
}

function groupCtx(senderId = 42) {
  return {
    chat: { id: -100123, type: "supergroup" },
    from: { id: senderId, is_bot: false, first_name: "Sender" },
    message: {
      message_id: 1,
      date: 1_758_000_000,
      text: "hello",
      message_thread_id: undefined,
    },
    telegram: {
      getChatMember: vi.fn(async () => ({
        status: "member",
        user: { id: senderId },
      })),
    },
  } as never;
}

describe("chatAndEntityMiddleware membership admission ordering", () => {
  afterEach(() => {
    delete process.env.TELEGRAM_MEMBERSHIP_ENFORCE;
    vi.restoreAllMocks();
  });

  it("runs the membership gate BEFORE any participant-state mutation (denied sender mutates nothing)", async () => {
    const { chatAndEntityMiddleware, runtime } = middlewareService({
      authorize: () => false,
    });
    const next = vi.fn(async () => undefined);

    await chatAndEntityMiddleware(groupCtx(), next);

    expect(next).not.toHaveBeenCalled();
    expect(runtime.ensureConnection).not.toHaveBeenCalled();
    expect(runtime.removeParticipant).not.toHaveBeenCalled();
  });

  it("admitted senders proceed to normal preprocessing", async () => {
    const { chatAndEntityMiddleware } = middlewareService({
      authorize: () => true,
    });
    const next = vi.fn(async () => undefined);

    await chatAndEntityMiddleware(groupCtx(), next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it("does not gate my_chat_member updates (a kicked bot must reach its tombstone handler)", async () => {
    const { chatAndEntityMiddleware, authorize } = middlewareService({
      authorize: () => false,
    });
    const next = vi.fn(async () => undefined);

    // A my_chat_member update has no ctx.message — the gate must not fire.
    await chatAndEntityMiddleware(
      {
        chat: { id: -100123, type: "supergroup" },
        from: { id: 42, is_bot: false, first_name: "Admin" },
        update: { my_chat_member: {} },
      } as never,
      next,
    );

    expect(authorize).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("fails closed while the admission gate is pending (startup window)", async () => {
    const runtime = makeRuntime();
    const gate = new TelegramMembershipMessageGate({
      runtime,
      authority: null,
      botTelegramUserId: null,
    });
    gate.markPending();

    await expect(
      gate.authorizeMessage({
        chatId: "-100",
        chatRoomKey: "-100",
        chatType: "group",
        principalEntityId: "00000000-0000-0000-0000-000000000001" as UUID,
        telegramUserId: "42",
        runtimeMapping: { worldId: null, roomId: null, entityId: null },
        getChatMember: async () => ({ status: "member", user: { id: 42 } }),
      }),
    ).resolves.toBe(false);

    // Settles to the legacy allow mode once the bootstrap resolves absent.
    gate.markAbsent();
    await expect(
      gate.authorizeMessage({
        chatId: "-100",
        chatRoomKey: "-100",
        chatType: "group",
        principalEntityId: "00000000-0000-0000-0000-000000000001" as UUID,
        telegramUserId: "42",
        runtimeMapping: { worldId: null, roomId: null, entityId: null },
        getChatMember: async () => ({ status: "member", user: { id: 42 } }),
      }),
    ).resolves.toBe(true);
  });
});

describe("leave revocation removes room participation", () => {
  it("calls removeParticipant for the departed principal's observed and main rooms", async () => {
    const runtime = makeRuntime();
    // Forum-topic participation: the principal also sits in a topic room of
    // the SAME chat world (plus an unrelated chat's world that must NOT be
    // cleared). getRoom resolves worldId so the enumeration can filter.
    const worldId = "00000000-0000-0000-0000-0000000000bb" as UUID;
    const topicRoom = "00000000-0000-0000-0000-0000000000cc" as UUID;
    const otherWorldRoom = "00000000-0000-0000-0000-0000000000dd" as UUID;
    runtime.getRoomsForParticipant = vi.fn(async () => [
      topicRoom,
      otherWorldRoom,
    ]);
    runtime.getRoom = vi.fn(
      async (id: UUID) =>
        (id === topicRoom
          ? { id, worldId }
          : id === otherWorldRoom
            ? {
                id,
                worldId: "00000000-0000-0000-0000-0000000000ee" as UUID,
              }
            : null) as never,
    );
    const gate = {
      authority: {
        recordEvent: vi.fn(async () => undefined),
        markScopeUnavailable: vi.fn(async () => undefined),
      },
      connectorAccountId: "connector-1",
      botTelegramUserId: "900001",
    };
    const service = Object.assign(
      Object.create(TelegramService.prototype) as TelegramService,
      {
        runtime,
        defaultAccountId: "default",
        knownChats: new Map<string, unknown>(),
        syncedEntityIds: new Set<UUID>(),
        membershipGateFailures: new Set<string>(),
        settledMembershipGates: new Map<string, unknown>(),
        membershipGates: new Map<string, unknown>(),
        messageManager: { markMembershipGateBroken: vi.fn() },
      },
    );
    (
      service as unknown as { getMembershipGate: ReturnType<typeof vi.fn> }
    ).getMembershipGate = vi.fn().mockResolvedValue(gate);
    (service as unknown as { getAccountState: () => unknown }).getAccountState =
      () => undefined;

    const syncLeftChatMember = (
      service as unknown as {
        syncLeftChatMember: (
          ctx: unknown,
          worldId: UUID,
          roomId: UUID,
          accountId?: string,
        ) => Promise<void>;
      }
    ).syncLeftChatMember.bind(service);

    const roomId = "00000000-0000-0000-0000-0000000000aa" as UUID;
    await syncLeftChatMember(
      {
        chat: { id: -100123, type: "supergroup" },
        message: {
          message_id: 5,
          date: 1_758_000_000,
          left_chat_member: { id: 42, is_bot: false, first_name: "Leaver" },
        },
      } as never,
      "00000000-0000-0000-0000-0000000000bb" as UUID,
      roomId,
      "default",
    );

    expect(gate.authority.recordEvent).toHaveBeenCalledTimes(1);
    const removedRooms = (
      runtime.removeParticipant as ReturnType<typeof vi.fn>
    ).mock.calls.map((call) => call[1]);
    // Observed room, main room, AND the same-world topic room are cleared;
    // the unrelated world's room is NOT.
    expect(removedRooms).toContain(roomId);
    expect(new Set(removedRooms)).toContain(topicRoom);
    expect(removedRooms).not.toContain(otherWorldRoom);
    // A revocation must never (re)create participation: no ensureConnection.
    expect(runtime.ensureConnection).not.toHaveBeenCalled();
  });
});
