/**
 * Real-PGlite regression: a bot re-add followed by a process restart before
 * the next fresh evidence write must not re-hydrate the bot-removal
 * tombstone from the stale persisted "unavailable" scope health (the bot is
 * already present, so no second my_chat_member re-add transition would ever
 * arrive to clear it). Fresh post-re-add evidence recovers admission after
 * re-instantiation; pre-re-add backlogged evidence stays denied through the
 * re-hydrated in-memory watermark.
 *
 * Harness identical to __tests__/membership-authority.real.test.ts:
 * real AgentRuntime + real SqlMembershipService; restart simulated by
 * stopping the first runtime and booting a second over the same PGlite dir.
 */
import type { UUID } from "@elizaos/core";
import {
  createTestRuntimeWithModelProvider,
  type ModelProviderTestRuntime,
} from "@elizaos/core/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup) await cleanup();
  }
});

const CHAT_ID = -3101;
const MEMBER_TG_ID = 655_001;

async function bootAuthority(pgliteDir: string) {
  const harness = await createTestRuntimeWithModelProvider({ pgliteDir });
  cleanups.push(harness.cleanup);
  const membershipService = harness.runtime.getService(
    "membership",
  ) as import("@elizaos/core").MembershipService;
  const { getConnectorAccountManager } = await import("@elizaos/core");
  const manager = await getConnectorAccountManager(harness.runtime);
  const stored = await manager.upsertAccount("telegram", {
    id: "telegram-910001",
    provider: "telegram",
    label: "Telegram bot 910001",
    role: "AGENT",
    purpose: ["messaging"],
    accessGate: "open",
    status: "connected",
    externalId: "910001",
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
  return { harness, authority };
}

async function ensurePrincipal(
  harness: ModelProviderTestRuntime,
  entityId: UUID,
): Promise<void> {
  const created = await harness.runtime.createEntity({
    id: entityId,
    agentId: harness.runtime.agentId,
    names: ["Re-add Restart Probe User"],
    metadata: {},
  });
  if (!created) throw new Error("test principal entity creation failed");
}

describe("bot re-add durability across restart", () => {
  it("fresh post-re-add evidence recovers admission after a restart, while pre-re-add evidence stays denied", async () => {
    const fs = await import("node:fs/promises");
    const dir = await fs.mkdtemp("/tmp/tg-membership-readd-restart-");
    const { resolveTelegramRuntimeEntityId } = await import(
      "@elizaos/plugin-telegram"
    );

    // Process 1: member joins, bot is removed (persists unavailable),
    // then the bot is re-added (clearScopeRemoval persists the re-add
    // watermark durably).
    const first = await bootAuthority(dir);
    const entityId = (await resolveTelegramRuntimeEntityId(
      first.harness.runtime,
      "default",
      String(MEMBER_TG_ID),
    )) as UUID;
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
    await first.authority.markScopeUnavailable({
      chatId: String(CHAT_ID),
      chatRoomKey: String(CHAT_ID),
      reason: "bot_removed",
    });
    await first.authority.clearScopeRemoval({
      chatId: String(CHAT_ID),
      chatRoomKey: String(CHAT_ID),
    });

    // Restart: stop the first runtime, boot a second over the same DB.
    const cleanupIndex = cleanups.indexOf(first.harness.cleanup);
    if (cleanupIndex >= 0) cleanups.splice(cleanupIndex, 1);
    // Successful shutdown is part of the tested restart contract: the
    // second runtime must not boot while the first still holds PGlite.
    await first.harness.runtime.stop();
    const second = await bootAuthority(dir);

    // PRE-re-add evidence (backlogged, stamped before the re-add moment)
    // must stay denied.
    await second.authority.recordEvent({
      chatId: String(CHAT_ID),
      chatRoomKey: String(CHAT_ID),
      canonicalPrincipalId: entityId,
      state: "active",
      reason: "joined",
      messageId: 2,
      telegramUserId: String(MEMBER_TG_ID),
      runtime: runtimeMap,
      observedAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const backloggedDecision = await second.authority.authorize({
      chatId: String(CHAT_ID),
      chatRoomKey: String(CHAT_ID),
      canonicalPrincipalId: entityId,
    });
    expect(
      backloggedDecision.decision,
      "backlogged pre-re-add evidence must not authorize after restart",
    ).toBe("denied");

    // FRESH evidence (stamped after the re-add) must recover admission
    // even after the restart.
    await second.authority.recordEvent({
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
    const freshDecision = await second.authority.authorize({
      chatId: String(CHAT_ID),
      chatRoomKey: String(CHAT_ID),
      canonicalPrincipalId: entityId,
    });
    expect(
      freshDecision.decision,
      "fresh post-re-add evidence must recover admission after a restart",
    ).toBe("allowed");

    cleanups.push(async () => {
      await fs.rm(dir, { recursive: true, force: true });
    });
  }, 120_000);

  it("a removal AFTER the re-add still re-hydrates the tombstone across restart (generation fence, no wall clock)", async () => {
    const fs = await import("node:fs/promises");
    const dir = await fs.mkdtemp("/tmp/tg-membership-readd-restart-");
    const { resolveTelegramRuntimeEntityId } = await import(
      "@elizaos/plugin-telegram"
    );

    // Cycle 1: join -> remove -> re-add (clear persists watermark for the
    // removal generation it repaired). Cycle 2: the bot is removed AGAIN —
    // the new unavailable row carries a strictly greater generation, so the
    // persisted watermark must NOT suppress the tombstone after restart.
    const first = await bootAuthority(dir);
    const entityId = (await resolveTelegramRuntimeEntityId(
      first.harness.runtime,
      "default",
      String(MEMBER_TG_ID),
    )) as UUID;
    await ensurePrincipal(first.harness, entityId);
    const runtimeMap = { worldId: null, roomId: null, entityId };
    const recordJoin = async (
      authority: import("@elizaos/plugin-telegram").TelegramMembershipAuthority,
      messageId: number,
      observedAt: string,
    ) => {
      await authority.recordEvent({
        chatId: String(CHAT_ID),
        chatRoomKey: String(CHAT_ID),
        canonicalPrincipalId: entityId,
        state: "active",
        reason: "joined",
        messageId,
        telegramUserId: String(MEMBER_TG_ID),
        runtime: runtimeMap,
        observedAt,
      });
    };

    await recordJoin(first.authority, 1, new Date().toISOString());
    await first.authority.markScopeUnavailable({
      chatId: String(CHAT_ID),
      chatRoomKey: String(CHAT_ID),
      reason: "bot_removed",
    });
    await first.authority.clearScopeRemoval({
      chatId: String(CHAT_ID),
      chatRoomKey: String(CHAT_ID),
    });
    await first.authority.markScopeUnavailable({
      chatId: String(CHAT_ID),
      chatRoomKey: String(CHAT_ID),
      reason: "bot_removed_again",
    });

    // Restart and try fresh evidence: the second removal's generation is
    // strictly greater than the watermark's, so the tombstone re-hydrates
    // and admission must stay denied — a wall-clock comparison cannot make
    // this distinction when both writes land in the same millisecond.
    const cleanupIndex = cleanups.indexOf(first.harness.cleanup);
    if (cleanupIndex >= 0) cleanups.splice(cleanupIndex, 1);
    // Successful shutdown is part of the tested restart contract: the
    // second runtime must not boot while the first still holds PGlite.
    await first.harness.runtime.stop();
    const second = await bootAuthority(dir);

    await recordJoin(second.authority, 2, new Date().toISOString());
    const decision = await second.authority.authorize({
      chatId: String(CHAT_ID),
      chatRoomKey: String(CHAT_ID),
      canonicalPrincipalId: entityId,
    });
    expect(
      decision.decision,
      "evidence after a post-re-add removal must stay denied after restart",
    ).toBe("denied");

    cleanups.push(async () => {
      await fs.rm(dir, { recursive: true, force: true });
    });
  }, 120_000);

  it("a transient watermark cache READ failure denies that attempt without cementing the tombstone", async () => {
    const fs = await import("node:fs/promises");
    const dir = await fs.mkdtemp("/tmp/tg-membership-readd-restart-");
    const { resolveTelegramRuntimeEntityId } = await import(
      "@elizaos/plugin-telegram"
    );

    const first = await bootAuthority(dir);
    const entityId = (await resolveTelegramRuntimeEntityId(
      first.harness.runtime,
      "default",
      String(MEMBER_TG_ID),
    )) as UUID;
    await ensurePrincipal(first.harness, entityId);
    const runtimeMap = { worldId: null, roomId: null, entityId };
    const recordJoin = async (
      observedAt: string,
      messageId: number,
    ): Promise<void> => {
      await first.authority.recordEvent({
        chatId: String(CHAT_ID),
        chatRoomKey: String(CHAT_ID),
        canonicalPrincipalId: entityId,
        state: "active",
        reason: "joined",
        messageId,
        telegramUserId: String(MEMBER_TG_ID),
        runtime: runtimeMap,
        observedAt,
      });
    };

    await recordJoin(new Date().toISOString(), 1);
    await first.authority.markScopeUnavailable({
      chatId: String(CHAT_ID),
      chatRoomKey: String(CHAT_ID),
      reason: "bot_removed",
    });
    await first.authority.clearScopeRemoval({
      chatId: String(CHAT_ID),
      chatRoomKey: String(CHAT_ID),
    });

    // Restart. First recordEvent after restart: the watermark cache read
    // throws once — that attempt must fail closed (recordEvent returns
    // false, no evidence write) WITHOUT setting the in-memory tombstone, so
    // the next attempt (cache recovered) allows the watermark to suppress
    // hydration and fresh evidence recovers admission.
    const cleanupIndex = cleanups.indexOf(first.harness.cleanup);
    if (cleanupIndex >= 0) cleanups.splice(cleanupIndex, 1);
    // Successful shutdown is part of the tested restart contract: the
    // second runtime must not boot while the first still holds PGlite.
    await first.harness.runtime.stop();
    const second = await bootAuthority(dir);

    const realGetCache = second.harness.runtime.getCache.bind(
      second.harness.runtime,
    );
    let failNextWatermarkRead = true;
    const watermarkKeyFragment = "telegram:membership:readd-watermark:";
    vi.spyOn(second.harness.runtime, "getCache").mockImplementation(
      async (key: string) => {
        if (failNextWatermarkRead && key.startsWith(watermarkKeyFragment)) {
          failNextWatermarkRead = false;
          throw new Error("simulated transient cache outage");
        }
        return realGetCache(key);
      },
    );

    const firstAttempt = await second.authority.recordEvent({
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
    expect(firstAttempt).toBeUndefined();
    const deniedDecision = await second.authority.authorize({
      chatId: String(CHAT_ID),
      chatRoomKey: String(CHAT_ID),
      canonicalPrincipalId: entityId,
    });
    expect(
      deniedDecision.decision,
      "cache-read failure must fail this evidence attempt closed",
    ).toBe("denied");

    const secondAttempt = await second.authority.recordEvent({
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
    expect(secondAttempt).toBeUndefined();
    const decision = await second.authority.authorize({
      chatId: String(CHAT_ID),
      chatRoomKey: String(CHAT_ID),
      canonicalPrincipalId: entityId,
    });
    expect(
      decision.decision,
      "recovered cache read must retry hydration, not replay a cemented tombstone",
    ).toBe("allowed");

    cleanups.push(async () => {
      await fs.rm(dir, { recursive: true, force: true });
    });
  }, 120_000);

  it("clearScopeRemoval THROWS when the watermark cannot be made durable; in-memory watermark still carries this process", async () => {
    const fs = await import("node:fs/promises");
    const dir = await fs.mkdtemp("/tmp/tg-membership-readd-restart-");
    const { resolveTelegramRuntimeEntityId } = await import(
      "@elizaos/plugin-telegram"
    );

    const first = await bootAuthority(dir);
    const entityId = (await resolveTelegramRuntimeEntityId(
      first.harness.runtime,
      "default",
      String(MEMBER_TG_ID),
    )) as UUID;
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
    await first.authority.markScopeUnavailable({
      chatId: String(CHAT_ID),
      chatRoomKey: String(CHAT_ID),
      reason: "bot_removed",
    });

    // Every watermark write rejects: clearScopeRemoval must surface the
    // durability failure to the re-add caller instead of silently
    // succeeding.
    const watermarkKeyFragment = "telegram:membership:readd-watermark:";
    vi.spyOn(first.harness.runtime, "setCache").mockImplementation(
      async (key: string) => {
        if (key.startsWith(watermarkKeyFragment)) {
          throw new Error("simulated persistent cache outage");
        }
        return true;
      },
    );
    await expect(
      first.authority.clearScopeRemoval({
        chatId: String(CHAT_ID),
        chatRoomKey: String(CHAT_ID),
      }),
      "undurable re-add clear must throw to the caller",
    ).rejects.toMatchObject({
      name: "ElizaError",
      code: "TELEGRAM_MEMBERSHIP_READD_WATERMARK_UNDURABLE",
      cause: { message: "simulated persistent cache outage" },
    });

    // THIS process is still protected: the in-memory watermark denies
    // backlogged pre-re-add evidence...
    await first.authority.recordEvent({
      chatId: String(CHAT_ID),
      chatRoomKey: String(CHAT_ID),
      canonicalPrincipalId: entityId,
      state: "active",
      reason: "joined",
      messageId: 2,
      telegramUserId: String(MEMBER_TG_ID),
      runtime: runtimeMap,
      observedAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const backlogged = await first.authority.authorize({
      chatId: String(CHAT_ID),
      chatRoomKey: String(CHAT_ID),
      canonicalPrincipalId: entityId,
    });
    expect(
      backlogged.decision,
      "backlogged evidence stays denied in-process",
    ).toBe("denied");
    // ...and fresh post-re-add evidence recovers admission in-process.
    await first.authority.recordEvent({
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
    const decision = await first.authority.authorize({
      chatId: String(CHAT_ID),
      chatRoomKey: String(CHAT_ID),
      canonicalPrincipalId: entityId,
    });
    expect(decision.decision).toBe("allowed");

    cleanups.push(async () => {
      await fs.rm(dir, { recursive: true, force: true });
    });
  }, 120_000);
});
