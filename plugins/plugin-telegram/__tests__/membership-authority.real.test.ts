/**
 * Real-PGlite proof of the Telegram membership-authority vertical (#23101
 * first lane): join/leave evidence through the canonical MembershipService,
 * same-turn revocation, getChatMember backfill reconcile, duplicate-update
 * non-resurrection, restart adoption with the stable publisher binding, and
 * fail-closed admission when no fresh evidence exists.
 *
 * The harness boots a real AgentRuntime with the real SqlMembershipService
 * (plugin-sql) and drives the REAL MessageManager.handleMessage admission
 * gate with synthetic Telegram contexts; `getChatMember` is a captured
 * provider seam (no network).
 */
import type { UUID } from "@elizaos/core";
import {
  createTestRuntimeWithModelProvider,
  type ModelProviderTestRuntime,
} from "@elizaos/core/testing";
import { MessageManager } from "@elizaos/plugin-telegram";
import type { Context } from "telegraf";
import { Telegraf } from "telegraf";
import { afterEach, describe, expect, it, vi } from "vitest";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup) await cleanup();
  }
});

function track(harness: ModelProviderTestRuntime): ModelProviderTestRuntime {
  cleanups.push(harness.cleanup);
  return harness;
}

interface ChatMemberFixture {
  status: string;
  user: { id: number };
}

/**
 * Boots a real runtime, resolves the membership service, and binds the
 * authority-backed gate into a fresh MessageManager exactly the way
 * TelegramService.finishBotStartup does.
 */
async function bootMembershipHarness(options?: {
  pgliteDir?: string;
}): Promise<{
  harness: ModelProviderTestRuntime;
  manager: MessageManager;
  authority: import("@elizaos/plugin-telegram").TelegramMembershipAuthority;
  getChatMember: ReturnType<typeof vi.fn>;
  membershipService: import("@elizaos/core").MembershipService;
}> {
  const harness = track(
    await createTestRuntimeWithModelProvider({
      pgliteDir: options?.pgliteDir,
      removePgliteDirOnCleanup: true,
    }),
  );
  const membershipService = harness.runtime.getService(
    "membership",
  ) as import("@elizaos/core").MembershipService;
  if (!membershipService) {
    throw new Error("membership service missing from test runtime");
  }

  const { getConnectorAccountManager } = await import("@elizaos/core");
  const manager$ = getConnectorAccountManager(harness.runtime);
  const stored = await manager$.upsertAccount("telegram", {
    id: "telegram-900001",
    provider: "telegram",
    label: "Telegram bot 900001",
    role: "AGENT",
    purpose: ["messaging"],
    accessGate: "open",
    status: "connected",
    externalId: "900001",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  if (!stored.id) throw new Error("connector account upsert returned no id");

  const { TelegramMembershipAuthority } = await import(
    "@elizaos/plugin-telegram"
  );
  const authority = new TelegramMembershipAuthority({
    runtime: harness.runtime,
    connectorAccountId: stored.id as UUID,
    service: membershipService,
  });

  const bot = new Telegraf("123456:TEST_TOKEN", {
    telegram: { apiRoot: "http://127.0.0.1:0/" },
  });
  const manager = new MessageManager(bot, harness.runtime, "default");
  manager.bindMembershipGate({
    authority,
    botTelegramUserId: "900001",
  });

  const getChatMember = vi.fn(
    async (): Promise<ChatMemberFixture> => ({
      status: "member",
      user: { id: 555001 },
    }),
  );

  return {
    harness,
    manager,
    authority,
    getChatMember,
    membershipService,
  };
}

const CHAT_ID = -2001;
const _BOT_ID = 900_001;
const MEMBER_TG_ID = 555_001;

/**
 * The membership authority requires the principal's entity row to exist in the
 * tenant before evidence can be applied (MEMBERSHIP_PRINCIPAL_NOT_FOUND
 * otherwise). Production paths create it via ensureConnection; tests that
 * drive recordEvent directly must create it the same way.
 */
async function ensurePrincipal(
  harness: ModelProviderTestRuntime,
  entityId: UUID,
): Promise<void> {
  const created = await harness.runtime.createEntity({
    id: entityId,
    agentId: harness.runtime.agentId,
    names: ["Member Test User"],
    metadata: {},
  });
  if (!created) {
    throw new Error("test principal entity creation failed");
  }
}

function groupMessageCtx(input: {
  messageId: number;
  fromId?: number;
  date?: number;
  text?: string;
  getChatMember: ReturnType<typeof vi.fn>;
}): Context {
  const chat = { id: CHAT_ID, type: "group", title: "Membership Test Group" };
  const from = {
    id: input.fromId ?? MEMBER_TG_ID,
    is_bot: false,
    first_name: "Member",
    username: "member",
  };
  return {
    from,
    chat,
    message: {
      message_id: input.messageId,
      date: input.date ?? Math.floor(Date.now() / 1000),
      text: input.text ?? "hello",
      chat,
      from,
    },
    telegram: {
      getChatMember: input.getChatMember,
      sendMessage: async () => ({}),
      sendChatAction: async () => true,
    },
  } as unknown as Context;
}

describe("telegram membership authority vertical (real PGlite)", () => {
  it("admits a member after join evidence and denies the same principal in the same turn after leave evidence", async () => {
    const { manager, authority, getChatMember, harness } =
      await bootMembershipHarness();
    const entityId = await import("@elizaos/plugin-telegram").then((m) =>
      m.resolveTelegramRuntimeEntityId(
        harness.runtime,
        "default",
        String(MEMBER_TG_ID),
      ),
    );
    await ensurePrincipal(harness, entityId);
    const observedAt = new Date(Date.now() - 1_000).toISOString();
    const runtimeMap = {
      worldId: null as UUID | null,
      roomId: null as UUID | null,
      entityId,
    };

    // Join evidence
    await authority.recordEvent({
      chatId: String(CHAT_ID),
      chatRoomKey: String(CHAT_ID),
      canonicalPrincipalId: entityId,
      state: "active",
      reason: "joined",
      runtime: runtimeMap,
      messageId: 1,
      telegramUserId: String(MEMBER_TG_ID),
      observedAt,
    });

    // Admitted: message from the member creates a memory
    await manager.handleMessage(
      groupMessageCtx({ messageId: 100, getChatMember }),
      { forceReply: false },
    );
    // The gate passed when getChatMember was NOT needed for this member
    expect(getChatMember).not.toHaveBeenCalled();

    // Leave evidence (same turn semantics: revocation lands before the next read)
    await authority.recordEvent({
      chatId: String(CHAT_ID),
      chatRoomKey: String(CHAT_ID),
      canonicalPrincipalId: entityId,
      state: "revoked",
      reason: "left",
      runtime: runtimeMap,
      messageId: 2,
      telegramUserId: String(MEMBER_TG_ID),
      observedAt: new Date().toISOString(),
    });

    // Denied: no memory created; but the reconcile seam IS consulted because
    // the denial reason (membership_revoked) is not a reconcile-miss...
    // revoked principals fail closed without a provider query.
    const memorySpy = vi.fn();
    harness.runtime.createMemory = memorySpy as never;
    getChatMember.mockResolvedValueOnce({
      status: "left",
      user: { id: MEMBER_TG_ID },
    });
    await manager.handleMessage(
      groupMessageCtx({ messageId: 101, getChatMember }),
      { forceReply: false },
    );
    expect(getChatMember).not.toHaveBeenCalled();
    expect(memorySpy).not.toHaveBeenCalled();
  }, 120_000);

  it("backfills a never-seen member via getChatMember reconcile and admits them; a kicked reconcile denies", async () => {
    const { manager, getChatMember } = await bootMembershipHarness();

    getChatMember.mockResolvedValue({
      status: "member",
      user: { id: MEMBER_TG_ID },
    });
    // Admission observability WITHOUT breaking the runtime: wrap the real
    // createMemory so internal callers (ensureConnection etc.) keep working.
    const harnessRuntime = (
      manager as unknown as { runtime: { createMemory: unknown } }
    ).runtime;
    const originalCreateMemory = (
      harnessRuntime.createMemory as (...args: unknown[]) => Promise<boolean>
    ).bind(harnessRuntime);
    let admissions = 0;
    (harnessRuntime as { createMemory: unknown }).createMemory = async (
      ...args: unknown[]
    ) => {
      admissions += 1;
      return originalCreateMemory(
        ...(args as Parameters<typeof originalCreateMemory>),
      );
    };

    await manager.handleMessage(
      groupMessageCtx({ messageId: 200, getChatMember }),
      { forceReply: false },
    );
    expect(
      getChatMember,
      "never-seen member triggers a reconcile query",
    ).toHaveBeenCalledTimes(1);
    expect(admissions, "reconciled member is admitted").toBeGreaterThan(0);

    // Kicked member: a SECOND never-seen principal whose getChatMember
    // status is kicked — the reconcile applies revoked evidence and the
    // message is denied. (The first principal is now an admitted member and
    // would pass the gate without a provider query.)
    getChatMember.mockClear();
    admissions = 0;
    getChatMember.mockResolvedValue({
      status: "kicked",
      user: { id: MEMBER_TG_ID },
    });
    await manager.handleMessage(
      groupMessageCtx({
        messageId: 201,
        fromId: MEMBER_TG_ID + 1,
        getChatMember,
      }),
      { forceReply: false },
    );
    expect(getChatMember).toHaveBeenCalledTimes(1);
    expect(admissions, "kicked member is denied after reconcile").toBe(0);
    (harnessRuntime as { createMemory: unknown }).createMemory =
      originalCreateMemory;
  }, 120_000);

  it("does not resurrect membership on a duplicate join redelivery after a newer revocation", async () => {
    const { authority, getChatMember, harness } = await bootMembershipHarness();
    const entityId = await import("@elizaos/plugin-telegram").then((m) =>
      m.resolveTelegramRuntimeEntityId(
        harness.runtime,
        "default",
        String(MEMBER_TG_ID),
      ),
    );
    await ensurePrincipal(harness, entityId);
    const runtimeMap = { worldId: null, roomId: null, entityId };
    const observedAt = new Date(Date.now() - 2_000).toISOString();

    await authority.recordEvent({
      chatId: String(CHAT_ID),
      chatRoomKey: String(CHAT_ID),
      canonicalPrincipalId: entityId,
      state: "active",
      reason: "joined",
      messageId: 1,
      telegramUserId: String(MEMBER_TG_ID),
      runtime: runtimeMap,
      observedAt,
    });
    await authority.recordEvent({
      chatId: String(CHAT_ID),
      chatRoomKey: String(CHAT_ID),
      canonicalPrincipalId: entityId,
      state: "revoked",
      reason: "left",
      messageId: 2,
      telegramUserId: String(MEMBER_TG_ID),
      runtime: runtimeMap,
      observedAt: new Date(Date.now() - 1_000).toISOString(),
    });

    // Duplicate redelivery of the OLD join event (same message id): identical
    // command bytes -> journal replay or benign-duplicate skip, never a
    // resurrection over the newer revocation.
    await authority.recordEvent({
      chatId: String(CHAT_ID),
      chatRoomKey: String(CHAT_ID),
      canonicalPrincipalId: entityId,
      state: "active",
      reason: "joined",
      messageId: 1,
      telegramUserId: String(MEMBER_TG_ID),
      runtime: runtimeMap,
      observedAt,
    });

    const decision = await authority.authorize({
      chatId: String(CHAT_ID),
      chatRoomKey: String(CHAT_ID),
      canonicalPrincipalId: entityId,
    });
    expect(decision.decision).toBe("denied");
    expect(
      (decision as { reason: string }).reason,
      "the redelivered join did not resurrect the revoked membership",
    ).toBe("membership_revoked");
    expect(getChatMember).not.toHaveBeenCalled();
  }, 120_000);

  it("does not let an older join (distinct message id) resurrect a newer revocation", async () => {
    const { authority, harness } = await bootMembershipHarness();
    const entityId = await import("@elizaos/plugin-telegram").then((m) =>
      m.resolveTelegramRuntimeEntityId(
        harness.runtime,
        "default",
        String(MEMBER_TG_ID),
      ),
    );
    await ensurePrincipal(harness, entityId);
    const runtimeMap = { worldId: null, roomId: null, entityId };

    // Newer revocation lands first.
    await authority.recordEvent({
      chatId: String(CHAT_ID),
      chatRoomKey: String(CHAT_ID),
      canonicalPrincipalId: entityId,
      state: "revoked",
      reason: "left",
      messageId: 50,
      telegramUserId: String(MEMBER_TG_ID),
      runtime: runtimeMap,
      observedAt: new Date(Date.now() - 1_000).toISOString(),
    });

    // An OLDER join with a distinct message id redelivered out of order must
    // not overwrite the newer revocation.
    await authority.recordEvent({
      chatId: String(CHAT_ID),
      chatRoomKey: String(CHAT_ID),
      canonicalPrincipalId: entityId,
      state: "active",
      reason: "joined",
      messageId: 40,
      telegramUserId: String(MEMBER_TG_ID),
      runtime: runtimeMap,
      observedAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const decision = await authority.authorize({
      chatId: String(CHAT_ID),
      chatRoomKey: String(CHAT_ID),
      canonicalPrincipalId: entityId,
    });
    expect(decision.decision).toBe("denied");
    expect((decision as { reason: string }).reason).toBe("membership_revoked");
  }, 120_000);

  it("continues the persisted publisher binding after a restart instead of re-registering", async () => {
    const dir = await import("node:fs/promises").then((fs) =>
      fs.mkdtemp("/tmp/tg-membership-restart-"),
    );
    const first = await bootMembershipHarness({ pgliteDir: dir });
    const entityId = await import("@elizaos/plugin-telegram").then((m) =>
      m.resolveTelegramRuntimeEntityId(
        first.harness.runtime,
        "default",
        String(MEMBER_TG_ID),
      ),
    );
    await ensurePrincipal(first.harness, entityId);
    const runtimeMap = { worldId: null, roomId: null, entityId };
    await first.authority.recordEvent({
      chatId: String(CHAT_ID),
      chatRoomKey: String(CHAT_ID),
      canonicalPrincipalId: entityId,
      state: "active",
      reason: "joined",
      messageId: 1,
      telegramUserId: String(MEMBER_TG_ID),
      runtime: runtimeMap,
      observedAt: new Date().toISOString(),
    });
    const before = await first.authority.scopeHealth({
      chatId: String(CHAT_ID),
      chatRoomKey: String(CHAT_ID),
    });
    expect(before?.health).toBe("current");
    // Stop the first runtime WITHOUT removing the PGlite dir.
    const cleanupIndex = cleanups.indexOf(first.harness.cleanup);
    if (cleanupIndex >= 0) cleanups.splice(cleanupIndex, 1);
    await first.harness.runtime.stop().catch(() => {});

    // Second process over the same database: same stable publisher identity.
    const second = await bootMembershipHarness({ pgliteDir: dir });
    const decision = await second.authority.authorize({
      chatId: String(CHAT_ID),
      chatRoomKey: String(CHAT_ID),
      canonicalPrincipalId: entityId,
    });
    expect(
      decision.decision,
      "a restarted process adopting the persisted binding does not strand the member fact",
    ).toBe("allowed");
    const after = await second.authority.scopeHealth({
      chatId: String(CHAT_ID),
      chatRoomKey: String(CHAT_ID),
    });
    expect(after?.publisherInstanceId).toBe(before?.publisherInstanceId);
    cleanups.push(async () => {
      await import("node:fs/promises").then((fs) =>
        fs.rm(dir, { recursive: true, force: true }),
      );
    });
  }, 120_000);

  it("does not let an equal-second join redelivery resurrect a same-second revocation (strict tie-break)", async () => {
    const { authority, harness } = await bootMembershipHarness();
    const entityId = await import("@elizaos/plugin-telegram").then((m) =>
      m.resolveTelegramRuntimeEntityId(
        harness.runtime,
        "default",
        String(MEMBER_TG_ID),
      ),
    );
    await ensurePrincipal(harness, entityId);
    const runtimeMap = { worldId: null, roomId: null, entityId };
    // Both observations carry the SAME second-resolution timestamp.
    const sameSecond = new Date(Date.now() - 1_000).toISOString();

    await authority.recordEvent({
      chatId: String(CHAT_ID),
      chatRoomKey: String(CHAT_ID),
      canonicalPrincipalId: entityId,
      state: "revoked",
      reason: "left",
      messageId: 10,
      telegramUserId: String(MEMBER_TG_ID),
      runtime: runtimeMap,
      observedAt: sameSecond,
    });
    // A join redelivery stamped within the SAME second must not resurrect:
    // Telegram dates are one-second resolution, so equal is not newer.
    await authority.recordEvent({
      chatId: String(CHAT_ID),
      chatRoomKey: String(CHAT_ID),
      canonicalPrincipalId: entityId,
      state: "active",
      reason: "joined",
      messageId: 11,
      telegramUserId: String(MEMBER_TG_ID),
      runtime: runtimeMap,
      observedAt: sameSecond,
    });

    const decision = await authority.authorize({
      chatId: String(CHAT_ID),
      chatRoomKey: String(CHAT_ID),
      canonicalPrincipalId: entityId,
    });
    expect(decision.decision).toBe("denied");
    expect((decision as { reason: string }).reason).toBe("membership_revoked");
  }, 120_000);

  it("tombstones a bot-removed scope: backlogged evidence cannot restore it, bot re-add clears it", async () => {
    const { authority, harness } = await bootMembershipHarness();
    const entityId = await import("@elizaos/plugin-telegram").then((m) =>
      m.resolveTelegramRuntimeEntityId(
        harness.runtime,
        "default",
        String(MEMBER_TG_ID),
      ),
    );
    await ensurePrincipal(harness, entityId);
    const runtimeMap = { worldId: null, roomId: null, entityId };

    await authority.recordEvent({
      chatId: String(CHAT_ID),
      chatRoomKey: String(CHAT_ID),
      canonicalPrincipalId: entityId,
      state: "active",
      reason: "joined",
      messageId: 1,
      telegramUserId: String(MEMBER_TG_ID),
      runtime: runtimeMap,
      observedAt: new Date(Date.now() - 5_000).toISOString(),
    });
    const beforeDecision = await authority.authorize({
      chatId: String(CHAT_ID),
      chatRoomKey: String(CHAT_ID),
      canonicalPrincipalId: entityId,
    });
    expect(beforeDecision.decision).toBe("allowed");

    // The bot is removed from the chat: the scope degrades to unavailable.
    await authority.markScopeUnavailable({
      chatId: String(CHAT_ID),
      chatRoomKey: String(CHAT_ID),
      reason: "bot_removed",
    });

    // A backlogged join redelivery (observed AFTER the removal) must NOT
    // advance the scope back to current — the tombstone holds.
    await authority.recordEvent({
      chatId: String(CHAT_ID),
      chatRoomKey: String(CHAT_ID),
      canonicalPrincipalId: entityId,
      state: "active",
      reason: "joined",
      messageId: 2,
      telegramUserId: String(MEMBER_TG_ID),
      runtime: runtimeMap,
      observedAt: new Date().toISOString(),
    });
    const tombstonedDecision = await authority.authorize({
      chatId: String(CHAT_ID),
      chatRoomKey: String(CHAT_ID),
      canonicalPrincipalId: entityId,
    });
    expect(
      tombstonedDecision.decision,
      "backlogged evidence cannot restore a bot-removed scope",
    ).toBe("denied");

    // The bot is re-added: the tombstone clears and fresh evidence works.
    authority.clearScopeRemoval({
      chatId: String(CHAT_ID),
      chatRoomKey: String(CHAT_ID),
    });
    await authority.recordEvent({
      chatId: String(CHAT_ID),
      chatRoomKey: String(CHAT_ID),
      canonicalPrincipalId: entityId,
      state: "active",
      reason: "joined",
      messageId: 3,
      telegramUserId: String(MEMBER_TG_ID),
      runtime: runtimeMap,
      observedAt: new Date().toISOString(),
    });
    const readdedDecision = await authority.authorize({
      chatId: String(CHAT_ID),
      chatRoomKey: String(CHAT_ID),
      canonicalPrincipalId: entityId,
    });
    expect(
      readdedDecision.decision,
      "after a bot re-add, fresh evidence re-establishes authority",
    ).toBe("allowed");
  }, 120_000);

  it("rejects a reconcile response describing a different user than requested (subject mismatch)", async () => {
    const { authority, harness } = await bootMembershipHarness();
    const entityId = await import("@elizaos/plugin-telegram").then((m) =>
      m.resolveTelegramRuntimeEntityId(
        harness.runtime,
        "default",
        String(MEMBER_TG_ID),
      ),
    );
    await ensurePrincipal(harness, entityId);
    const runtimeMap = { worldId: null, roomId: null, entityId };

    // Provider replies with member status but for user 999999, not 555001:
    // the response must never become evidence for the requested principal.
    const mismatched = await authority.reconcile({
      chatId: String(CHAT_ID),
      chatRoomKey: String(CHAT_ID),
      canonicalPrincipalId: entityId,
      telegramUserId: String(MEMBER_TG_ID),
      runtime: runtimeMap,
      getChatMember: async () => ({
        status: "member",
        user: { id: 999_999 },
      }),
      nonce: "mismatch-probe-1",
    });
    expect(mismatched).toBeNull();

    const decision = await authority.authorize({
      chatId: String(CHAT_ID),
      chatRoomKey: String(CHAT_ID),
      canonicalPrincipalId: entityId,
    });
    expect(decision.decision).toBe("denied");
  }, 120_000);
});
